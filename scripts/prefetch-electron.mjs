import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { downloadGitHubBytes, DownloadError } from "./github-release.mjs";

const repository = "electron/electron";
const releaseBase = `https://github.com/${repository}/releases/download/`;
const apiBase = `https://api.github.com/repos/${repository}/releases`;

export function electronArtifactName(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("Unsupported locked Electron version or target");
  }
  return `electron-v${version}-${platform}-${arch}.zip`;
}

// Keep @electron/get's public cache and checksum verification. Only replace its
// transport, so a cache hit can also validate against the cached checksum file.
export async function prefetchElectronArchive({ version, platform, arch, cacheRoot }, { getArtifact, ...options }) {
  const filename = electronArtifactName(version, platform, arch);
  const names = new Set([filename, "SHASUMS256.txt"]);
  let metadata;
  const downloader = {
    async download(url, destination) {
      const parsed = new URL(url);
      const name = parsed.pathname.split("/").at(-1);
      if (!names.has(name) || url !== `${releaseBase}v${version}/${name}`) throw new Error("Unexpected Electron artifact URL");
      const limits = { ...options, maxBytes: name === filename ? 256 * 1024 * 1024 : 2 * 1024 * 1024 };
      let bytes;
      try {
        bytes = await downloadGitHubBytes(url, "application/octet-stream", limits);
      } catch (error) {
        if (!(error instanceof DownloadError)) throw error;
        console.warn(`Electron ${version} ${name} download unavailable; using the official GitHub asset API`);
        metadata ??= JSON.parse((await downloadGitHubBytes(`${apiBase}/tags/v${version}`, "application/vnd.github+json", { ...options, maxBytes: 2 * 1024 * 1024 })).toString("utf8"));
        const assets = metadata.assets?.filter((item) => item.name === name);
        const asset = assets?.[0];
        if (metadata.tag_name !== `v${version}` || assets?.length !== 1 || !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
            !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limits.maxBytes) {
          throw new Error("GitHub asset does not match the locked Electron release");
        }
        bytes = await downloadGitHubBytes(`${apiBase}/assets/${asset.id}`, "application/octet-stream", limits);
        if (bytes.length !== asset.size) throw new Error("Electron release asset size mismatch");
      }
      // @electron/get writes into a temporary directory and verifies SHA-256
      // before publishing this archive to its cache. Never disable that check.
      writeFileSync(destination, bytes);
    },
  };
  return getArtifact({
    version, platform, arch, artifactName: "electron", cacheRoot, downloader,
    mirrorOptions: {
      // Ignore a stale mirror/customDir in .npmrc without mutating process env.
      resolveAssetURL(details) {
        if (details.version !== `v${version}`) throw new Error("Electron version override differs from the locked dependency");
        const name = details.isGeneric && details.artifactName === "SHASUMS256.txt" ? "SHASUMS256.txt"
          : !details.isGeneric && details.artifactName === "electron" && details.platform === platform && details.arch === arch ? filename : "";
        if (!name) throw new Error("Unexpected Electron checksum or target request");
        return `${releaseBase}v${version}/${name}`;
      },
    },
  });
}

export async function prepareElectron(root, platform, arch, options = {}) {
  const runtimeFile = join(root, "packages", "release-tools", "src", "code-protection", "runtime.cjs");
  if (!existsSync(runtimeFile)) throw new Error("Frozen source has no supported Electron bytecode runtime");
  const sourceRequire = createRequire(join(root, "package.json"));
  const electronRequire = createRequire(sourceRequire.resolve("electron/package.json"));
  const version = electronRequire("./package.json").version;
  electronArtifactName(version, platform, arch);
  if (platform !== process.platform) throw new Error("Electron preparation requires a native OS runner");
  const configPath = join(root, "packages", "desktop", "electron-builder.yml");
  const yaml = sourceRequire("js-yaml");
  const config = yaml.load(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config) || config.electronDist != null) throw new Error("Frozen builder configuration has an unsupported Electron distribution override");
  const archive = await prefetchElectronArchive({ version, platform, arch, cacheRoot: process.env.ELECTRON_CACHE }, {
    ...options, getArtifact: electronRequire("@electron/get").downloadArtifact,
  });
  const token = process.env.GITHUB_TOKEN;
  let executable;
  try {
    // The download token is not needed by the compiler probe or frozen source.
    delete process.env.GITHUB_TOKEN;
    const runtime = sourceRequire(runtimeFile);
    executable = await runtime.prepareElectronRuntime({ projectRoot: root, platform, arch }, { download: async () => archive });
  } finally {
    if (token !== undefined) process.env.GITHUB_TOKEN = token;
  }
  // Both compiler and packager consume the same verified, exact-version VM.
  // The temporary source configuration is not a change to the frozen Git ref.
  config.electronDist = archive;
  config.electronVersion = version;
  writeFileSync(configPath, yaml.dump(config));
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `ELECTRON_EXEC_PATH=${executable}\n`);
  console.log(`Prepared verified Electron ${version} ${platform}-${arch} for bytecode compilation and packaging`);
  return { archive, executable, version };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, platform, arch] = process.argv.slice(2);
  if (!root || !platform || !arch) throw new Error("Usage: prefetch-electron.mjs <source-directory> <platform> <arch>");
  try {
    await prepareElectron(resolve(root), platform, arch);
  } catch (error) {
    console.error(`::error::${error.message.replaceAll("\n", " ").replaceAll("\r", " ")}`);
    process.exitCode = 1;
  }
}
