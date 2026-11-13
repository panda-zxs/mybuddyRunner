import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { downloadArtifact } from "@electron/get";
import extract from "extract-zip";
import { installBunFallback } from "./setup-bun-fallback.mjs";
import { prefetchComputerUse } from "./prefetch-computer-use.mjs";
import { prefetchVideoTools } from "./prefetch-video-tools.mjs";
import { prefetchElectronArchive } from "./prefetch-electron.mjs";

const root = mkdtempSync(join(process.env.RUNNER_TEMP, "native-download-smoke-"));
try {
  if (process.env.GITHUB_ACTIONS === "true" && !process.env.GITHUB_TOKEN) throw new Error("Native Actions verification requires the read-only GitHub token");
  const version = "1.4.2";
  const cleanEnv = { ...process.env };
  delete cleanEnv.GITHUB_TOKEN;
  delete cleanEnv.NODE_OPTIONS;
  const run = (cmd, args, options) => execFileSync(cmd, args, { ...options, env: cleanEnv });
  const bun = installBunFallback(version, { tempDirectory: root, githubPath: join(root, "test-path"), run });
  const bunx = join(dirname(bun), process.platform === "win32" ? "bunx.exe" : "bunx");
  if (run(bunx, ["--version"], { encoding: "utf8" }).trim() !== version) throw new Error("bunx version mismatch");
  mkdirSync(join(root, "scripts", "computer-use"), { recursive: true });
  copyFileSync(new URL("./computer-use-release.fixture.json", import.meta.url), join(root, "scripts", "computer-use", "release.json"));
  let apiCalls = 0;
  await prefetchComputerUse(root, process.platform, process.arch, {
    wait: async () => {}, request: async (url, options) => {
      // Reproduce the reported primary outage, then use real authenticated API/CDN requests.
      if (new URL(url).hostname === "github.com") return new Response(null, { status: 504 });
      if (new URL(url).hostname === "api.github.com") apiCalls++;
      return fetch(url, options);
    },
  });
  if (apiCalls < 2) throw new Error("Live asset API fallback was not exercised");
  writeFileSync(join(root, "scripts", "beforePack.js"), "async function prepareVideoTools() { const release = 'b6.1.1'; }\n");
  const video = await prefetchVideoTools(root, process.platform, process.arch);
  const encoder = join(video, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const output = run(encoder, ["-version"], { encoding: "utf8", timeout: 20_000 });
  if (!output.includes("ffmpeg version")) throw new Error("FFmpeg did not start on the native runner");
  const offline = { request: async () => { throw new Error("Verified caches must work offline"); } };
  await prefetchComputerUse(root, process.platform, process.arch, offline);
  await prefetchVideoTools(root, process.platform, process.arch, offline);
  const electron = { version: "37.10.3", platform: process.platform, arch: process.arch, cacheRoot: join(root, "electron-cache") };
  let electronAPICalls = 0;
  const archive = await prefetchElectronArchive(electron, {
    getArtifact: downloadArtifact, wait: async () => {}, request: async (url, options) => {
      if (new URL(url).hostname === "github.com") return new Response(null, { status: 504 });
      if (new URL(url).hostname === "api.github.com") electronAPICalls++;
      return fetch(url, options);
    },
  });
  if (electronAPICalls < 3) throw new Error("Electron archive and checksum API fallback were not exercised");
  const electronDir = join(root, "electron-runtime");
  await extract(archive, { dir: electronDir });
  const binary = join(electronDir, process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
  const actual = JSON.parse(execFileSync(binary, ["-e", 'require("node:fs").writeSync(1,JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron}));process.exit(0)'], {
    env: { ...cleanEnv, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 180_000, windowsHide: true,
  }).trim());
  if (actual.platform !== electron.platform || actual.arch !== electron.arch || actual.electron !== electron.version) throw new Error("Downloaded Electron VM does not match the native target");
  if (await prefetchElectronArchive(electron, { ...offline, getArtifact: downloadArtifact }) !== archive) throw new Error("Offline Electron cache did not reuse the verified archive");
  console.log(`Native download smoke passed: ${process.platform}-${process.arch}; Bun/bunx ${version}; ${process.env.GITHUB_TOKEN ? "authenticated" : "anonymous"} Computer Use API; FFmpeg executable and notices; Electron ${electron.version} API fallback, checksum, native VM and offline cache.`);
} catch (error) {
  console.error(`::error::${error.message.replaceAll("\n", " ").replaceAll("\r", " ")}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
