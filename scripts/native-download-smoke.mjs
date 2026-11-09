import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { installBunFallback } from "./setup-bun-fallback.mjs";
import { prefetchComputerUse } from "./prefetch-computer-use.mjs";
import { prefetchVideoTools } from "./prefetch-video-tools.mjs";

const root = mkdtempSync(join(process.env.RUNNER_TEMP, "native-download-smoke-"));
try {
  if (process.env.GITHUB_ACTIONS === "true" && !process.env.GITHUB_TOKEN) throw new Error("Native Actions verification requires the read-only GitHub token");
  const version = process.platform === "win32" && process.arch === "arm64" ? "1.4.2" : "1.3.5";
  const cleanEnv = { ...process.env };
  delete cleanEnv.GITHUB_TOKEN;
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
  console.log(`Native download smoke passed: ${process.platform}-${process.arch}; Bun/bunx ${version}; ${process.env.GITHUB_TOKEN ? "authenticated" : "anonymous"} Computer Use API; FFmpeg executable and notices; offline cache.`);
} catch (error) {
  console.error(`::error::${error.message.replaceAll("\n", " ").replaceAll("\r", " ")}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
