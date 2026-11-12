import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { downloadGitHubBytes } from "./github-release.mjs";

const pinned = JSON.parse(readFileSync(new URL("./video-tools-release.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function videoTarget(platform, arch, release = pinned) {
  const binaryArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const assets = release.targets[`${platform}-${binaryArch}`];
  if (!assets || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported video encoder target");
  return { assets, binaryArch, name: platform === "win32" ? "ffmpeg.exe" : "ffmpeg" };
}

export async function prefetchVideoTools(root, platform, arch, options = {}) {
  const release = options.release || pinned;
  const hookCandidates = [
    join(root, "scripts", "beforePack.js"),
    join(root, "packages", "release-tools", "src", "tauriReleaseHelpers.cjs"),
  ];
  const hook = hookCandidates.find((candidate) => existsSync(candidate) && readFileSync(candidate, "utf8").includes("async function prepareVideoTools("));
  if (!hook) {
    console.log("Source has no bundled video encoder hook; nothing to prefetch");
    return null;
  }
  const source = readFileSync(hook, "utf8");
  const sourceRelease = source.match(/const release = ['"](b[0-9.]+)['"]/g);
  if (sourceRelease?.length !== 1 || !sourceRelease[0].includes(`'${release.release}'`) && !sourceRelease[0].includes(`"${release.release}"`)) {
    throw new Error("Frozen source video encoder release differs from the reviewed Runner pins");
  }
  const { assets, binaryArch, name } = videoTarget(platform, arch, release);
  const parent = join(root, "resources", "video-tools");
  const destination = join(parent, `${platform}-${arch}`);
  try {
    const previous = JSON.parse(readFileSync(join(destination, "source.json"), "utf8"));
    if (previous.release === release.release && previous.platform === platform && previous.binaryArch === binaryArch && previous.sha256 === assets.binarySha256 &&
        sha256(readFileSync(join(destination, name))) === assets.binarySha256 &&
        sha256(readFileSync(join(destination, `${name}.LICENSE`))) === assets.license.sha256 &&
        sha256(readFileSync(join(destination, `${name}.README`))) === assets.readme.sha256) {
      console.log(`Verified cached FFmpeg ${release.release} for ${platform}-${arch}`);
      return destination;
    }
  } catch { /* Recreate an incomplete cache from pinned assets. */ }
  async function assetBytes(asset) {
    const bytes = await downloadGitHubBytes(`https://api.github.com/repos/${release.repository}/releases/assets/${asset.id}`, "application/octet-stream", options);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`FFmpeg ${asset.name} checksum or size mismatch`);
    return bytes;
  }
  // Complete all verification before exposing a new source.json to the build hook.
  const archive = await assetBytes(assets.archive);
  const binary = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  if (sha256(binary) !== assets.binarySha256) throw new Error("FFmpeg decompressed binary checksum mismatch");
  const license = await assetBytes(assets.license);
  const readme = await assetBytes(assets.readme);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".ffmpeg-stage-"));
  try {
    writeFileSync(join(staging, name), binary);
    chmodSync(join(staging, name), 0o755);
    writeFileSync(join(staging, `${name}.LICENSE`), license);
    writeFileSync(join(staging, `${name}.README`), readme);
    writeFileSync(join(staging, "source.json"), JSON.stringify({ release: release.release, platform, binaryArch, sha256: assets.binarySha256 }));
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Verified FFmpeg ${release.release} for ${platform}-${arch}, including required notices`);
  return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, platform, arch] = process.argv.slice(2);
  if (!root || !platform || !arch) throw new Error("Usage: prefetch-video-tools.mjs <source-directory> <platform> <arch>");
  await prefetchVideoTools(resolve(root), platform, arch);
}
