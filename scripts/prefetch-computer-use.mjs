import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { downloadGitHubBytes as download, DownloadError } from "./github-release.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prefetchComputerUse(root, platform, arch, { request = fetch, wait = delay, apiToken = process.env.GITHUB_TOKEN || "" } = {}) {
  const manifest = join(root, "scripts", "computer-use", "release.json");
  if (!existsSync(manifest)) {
    console.log("Source has no pinned Computer Use release; nothing to prefetch");
    return null;
  }
  const release = JSON.parse(readFileSync(manifest, "utf8"));
  const artifact = release.artifacts?.[`${platform}-${arch}`];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.repository || "") || !/^\d+\.\d+\.\d+$/.test(release.version || "")) {
    throw new Error("Invalid pinned Computer Use release");
  }
  if (!artifact || typeof artifact.name !== "string" || basename(artifact.name) !== artifact.name || !/^[A-Za-z0-9_.-]+\.(zip|tar\.gz)$/.test(artifact.name) || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) {
    throw new Error("Invalid Computer Use target or archive metadata");
  }
  const cache = join(root, "out", ".computer-use-cache");
  const archive = join(cache, artifact.name);
  if (existsSync(archive) && sha256(readFileSync(archive)) === artifact.sha256) {
    console.log(`Verified cached Computer Use ${release.version} for ${platform}-${arch}`);
    return archive;
  }
  const options = { request, wait, apiToken };
  const base = `https://api.github.com/repos/${release.repository}/releases`;
  let bytes;
  try {
    bytes = await download(`https://github.com/${release.repository}/releases/download/v${release.version}/${artifact.name}`, "application/octet-stream", options);
  } catch (error) {
    if (!(error instanceof DownloadError)) throw error;
    console.warn("Computer Use release download unavailable; using the official GitHub asset API");
    const metadata = JSON.parse((await download(`${base}/tags/v${release.version}`, "application/vnd.github+json", options)).toString("utf8"));
    const asset = metadata.assets?.find((item) => item.name === artifact.name);
    if (metadata.tag_name !== `v${release.version}` || !asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)) {
      throw new Error("GitHub release asset does not match the pinned Computer Use release");
    }
    bytes = await download(`${base}/assets/${asset.id}`, "application/octet-stream", options);
  }
  // Keep the frozen source hash authoritative, even if upstream metadata changes.
  if (sha256(bytes) !== artifact.sha256) throw new Error("Computer Use archive checksum mismatch");
  mkdirSync(cache, { recursive: true });
  const temporary = `${archive}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`Verified Computer Use ${release.version} for ${platform}-${arch}; archive ready for packaging`);
  return archive;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, platform, arch] = process.argv.slice(2);
  if (!root || !platform || !arch) throw new Error("Usage: prefetch-computer-use.mjs <source-directory> <platform> <arch>");
  await prefetchComputerUse(resolve(root), platform, arch);
}
