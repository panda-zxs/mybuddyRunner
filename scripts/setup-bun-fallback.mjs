import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function bunPackage(version, platform = process.platform, arch = process.arch) {
  const systems = { darwin: "darwin", linux: "linux", win32: "windows" };
  const architectures = { x64: "x64", arm64: "aarch64" };
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Bun requires an exact release version");
  if (!Object.hasOwn(systems, platform) || !Object.hasOwn(architectures, arch)) {
    throw new Error(`Unsupported Bun host: ${platform}-${arch}`);
  }
  return { name: `@oven/bun-${systems[platform]}-${architectures[arch]}`, version };
}

export function verifyBun(executable, version, { platform = process.platform, arch = process.arch, run = execFileSync } = {}) {
  bunPackage(version, platform, arch);
  const output = run(executable, ["-e", "console.log(JSON.stringify({version:Bun.version,platform:process.platform,arch:process.arch}))"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "inherit"],
  });
  const actual = JSON.parse(output.trim());
  if (actual.version !== version || actual.platform !== platform || actual.arch !== arch) {
    throw new Error(`Bun identity mismatch: expected ${version} ${platform}-${arch}, got ${actual.version} ${actual.platform}-${actual.arch}`);
  }
  console.log(`Verified Bun ${version} on ${platform}-${arch}`);
}

export function installBunFallback(version, {
  platform = process.platform, arch = process.arch, run = execFileSync,
  tempDirectory = process.env.RUNNER_TEMP, githubPath = process.env.GITHUB_PATH,
} = {}) {
  const pkg = bunPackage(version, platform, arch);
  if (!tempDirectory || !githubPath) throw new Error("RUNNER_TEMP and GITHUB_PATH are required");
  mkdirSync(tempDirectory, { recursive: true });
  const directory = mkdtempSync(join(tempDirectory, "bun-fallback-"));
  try {
    const args = ["install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
      "--registry=https://registry.npmjs.org", "--fetch-retries=3", "--fetch-retry-mintimeout=3000", "--fetch-retry-maxtimeout=15000", "--fetch-timeout=45000",
      `${pkg.name}@${version}`];
    // Invoke npm through Node on Windows to avoid cmd.exe quoting and .cmd execution issues.
    const npm = platform === "win32" ? process.execPath : "npm";
    if (platform === "win32") args.unshift(join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
    console.log(`Installing ${pkg.name}@${version} from the official npm registry`);
    run(npm, args, { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], timeout: 240_000 });
    const packageDirectory = join(directory, "node_modules", ...pkg.name.split("/"));
    const metadata = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    if (metadata.name !== pkg.name || metadata.version !== version || !metadata.os?.includes(platform) || !metadata.cpu?.includes(arch)) {
      throw new Error("Downloaded Bun package does not match the pinned version and host architecture");
    }
    const bin = join(packageDirectory, "bin");
    const suffix = platform === "win32" ? ".exe" : "";
    const executable = join(bin, `bun${suffix}`);
    verifyBun(executable, version, { platform, arch, run });
    // Bun switches to bunx mode by executable name. Copying also works without Windows symlink privileges.
    copyFileSync(executable, join(bin, `bunx${suffix}`));
    if (/[\r\n]/.test(bin)) throw new Error("Invalid Bun installation path");
    appendFileSync(githubPath, `${bin}\n`);
    return executable;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  const version = process.env.DESKTOP_BUN_VERSION;
  if (mode === "install") installBunFallback(version);
  else if (mode === "verify") verifyBun(process.platform === "win32" ? "bun.exe" : "bun", version);
  else throw new Error("Usage: setup-bun-fallback.mjs <install|verify>");
}
