import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { downloadArtifact } from "@electron/get";
import { electronArtifactName, prefetchElectronArchive, prepareElectron } from "./prefetch-electron.mjs";

const require = createRequire(import.meta.url);

function fixture(t, overrides = {}) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "electron-prefetch-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const details = { version: "37.10.3", platform: "win32", arch: "arm64", cacheRoot, ...overrides };
  const name = electronArtifactName(details.version, details.platform, details.arch);
  const archive = Buffer.from("synthetic opaque archive bytes");
  const checksums = Buffer.from(`${createHash("sha256").update(archive).digest("hex")} *${name}\n`);
  const assets = [{ id: 11, name, size: archive.length }, { id: 12, name: "SHASUMS256.txt", size: checksums.length }];
  const calls = [], waits = [];
  const request = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/tags/v37.10.3")) return Response.json({ tag_name: "v37.10.3", assets });
    if (parsed.pathname.endsWith("/assets/11")) return new Response(archive);
    if (parsed.pathname.endsWith("/assets/12")) return new Response(checksums);
    if (parsed.pathname.endsWith(name)) return new Response(archive);
    if (parsed.pathname.endsWith("SHASUMS256.txt")) return new Response(checksums);
    assert.fail("Unexpected test request");
  };
  return { details, name, archive, checksums, assets, calls, waits, request,
    options: { getArtifact: downloadArtifact, request, wait: async (ms) => waits.push(ms), apiToken: "synthetic-token" } };
}

test("504 downloads use bounded retries then authenticated official assets, including checksums", async (t) => {
  const f = fixture(t);
  const result = await prefetchElectronArchive(f.details, { ...f.options, request: async (url, options) => {
    if (new URL(url).hostname === "github.com") {
      f.calls.push({ url: new URL(url), options });
      return new Response(null, { status: 504 });
    }
    return f.request(url, options);
  } });
  assert.deepEqual(readFileSync(result), f.archive);
  assert.equal(f.calls.filter(c => c.url.hostname === "github.com").length, 4);
  assert.equal(f.calls.filter(c => c.url.pathname.includes("/tags/")).length, 1);
  assert.deepEqual(f.waits, [2000, 2000]);
  for (const call of f.calls) assert.equal(call.options.headers.Authorization, call.url.hostname === "api.github.com" ? "Bearer synthetic-token" : undefined);
});

test("a transient primary failure can recover without querying release metadata", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  await prefetchElectronArchive(f.details, { ...f.options, request: async (...args) => ++attempts === 1 ? new Response(null, { status: 502 }) : f.request(...args) });
  assert.equal(f.calls.some(c => c.url.hostname === "api.github.com"), false);
  assert.deepEqual(f.waits, [2000]);
});

test("verified archives and checksum files are reusable offline", async (t) => {
  const f = fixture(t);
  const first = await prefetchElectronArchive(f.details, f.options);
  const second = await prefetchElectronArchive(f.details, { ...f.options, request: async () => assert.fail("cached runtime must not use the network") });
  assert.equal(first, second);
  assert.deepEqual(readFileSync(second), f.archive);
});

test("a corrupt cached archive is repaired, but bad downloaded bytes never become cached artifacts", async (t) => {
  const f = fixture(t);
  const path = await prefetchElectronArchive(f.details, f.options);
  writeFileSync(path, "corrupt cache");
  await prefetchElectronArchive(f.details, f.options);
  assert.deepEqual(readFileSync(path), f.archive);
  rmSync(path);
  await assert.rejects(prefetchElectronArchive(f.details, { ...f.options, request: async () => new Response("tampered download") }), /checksum/i);
  assert.equal(existsSync(path), false);
});

test("permission failures stop without fallback or retries", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(prefetchElectronArchive(f.details, { ...f.options, request: async () => { calls++; return new Response(null, { status: 401 }); } }), /HTTP 401/);
  assert.equal(calls, 1);
  assert.deepEqual(f.waits, []);
});

test("fallback rejects wrong release tags, missing targets and truncated assets", async (t) => {
  for (const condition of ["tag", "missing", "size"]) await t.test(condition, async (t) => {
    const f = fixture(t);
    await assert.rejects(prefetchElectronArchive(f.details, { ...f.options, request: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === "github.com") return new Response(null, { status: 504 });
      if (parsed.pathname.includes("/tags/")) return Response.json({ tag_name: condition === "tag" ? "v37.10.2" : "v37.10.3", assets: condition === "missing" ? [] : f.assets });
      if (condition === "size") return new Response("partial");
      return f.request(url, options);
    } }), /locked Electron release|size mismatch/);
  });
});

test("mirror settings cannot redirect the artifact or replace the locked version and architecture", async (t) => {
  const f = fixture(t);
  await prefetchElectronArchive(f.details, { ...f.options, getArtifact: async (details) => {
    assert.equal(details.unsafelyDisableChecksums, undefined);
    assert.equal(details.cacheRoot, f.details.cacheRoot);
    const resolveAsset = details.mirrorOptions.resolveAssetURL;
    const normalized = { ...details, version: "v37.10.3" };
    assert.equal(await resolveAsset(normalized), `https://github.com/electron/electron/releases/download/v37.10.3/${f.name}`);
    assert.equal(await resolveAsset({ ...normalized, isGeneric: true, artifactName: "SHASUMS256.txt" }), "https://github.com/electron/electron/releases/download/v37.10.3/SHASUMS256.txt");
    await assert.rejects(async () => resolveAsset({ ...normalized, version: "v99.0.0" }), /version override/);
    await assert.rejects(async () => resolveAsset({ ...normalized, arch: "x64" }), /Unexpected/);
    await assert.rejects(details.downloader.download("https://example.invalid/secret", join(f.details.cacheRoot, "bad")), /Unexpected/);
    assert.deepEqual(f.calls, []);
  } });
});

test("target names use the locked native architecture on all supported platforms", () => {
  for (const platform of ["win32", "darwin", "linux"]) for (const arch of ["x64", "arm64"]) {
    assert.equal(electronArtifactName("37.10.3", platform, arch), `electron-v37.10.3-${platform}-${arch}.zip`);
  }
  for (const values of [["latest", "win32", "arm64"], ["37.10.3", "win32", "ia32"], ["37.10.3", "darwin/../", "x64"]]) {
    assert.throws(() => electronArtifactName(...values), /Unsupported/);
  }
});

test("compiler and packager share the verified archive without passing the API token to the compiler", async (t) => {
  const f = fixture(t, { platform: process.platform, arch: process.arch });
  const root = join(f.details.cacheRoot, "source");
  mkdirSync(join(root, "node_modules", "electron"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@electron"), { recursive: true });
  symlinkSync(dirname(require.resolve("@electron/get/package.json")), join(root, "node_modules", "@electron", "get"), "junction");
  symlinkSync(dirname(require.resolve("js-yaml/package.json")), join(root, "node_modules", "js-yaml"), "junction");
  writeFileSync(join(root, "package.json"), '{"name":"synthetic-source"}');
  writeFileSync(join(root, "node_modules", "electron", "package.json"), '{"name":"electron","version":"37.10.3"}');
  const runtimeDir = join(root, "packages", "release-tools", "src", "code-protection");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "runtime.cjs"), `exports.prepareElectronRuntime = async (target, operations) => {
    if (process.env.GITHUB_TOKEN) throw new Error('compiler inherited a token');
    if (target.executable !== '') throw new Error('compiler reused an external override');
    require('node:assert/strict').throws(operations.installedPath, /verified prefetched/);
    if (!require('node:fs').existsSync(await operations.download())) throw new Error('missing verified archive');
    return require('node:path').join(target.projectRoot, 'synthetic-electron');
  };`);
  const configPath = join(root, "packages", "desktop", "electron-builder.yml");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, "productName: Synthetic\nmac:\n  hardenedRuntime: true\n");
  const saved = Object.fromEntries(["GITHUB_TOKEN", "GITHUB_ENV", "ELECTRON_CACHE"].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.GITHUB_TOKEN = "synthetic-token";
  process.env.GITHUB_ENV = join(f.details.cacheRoot, "github-env");
  process.env.ELECTRON_CACHE = join(f.details.cacheRoot, "cache");
  const result = await prepareElectron(root, process.platform, process.arch, f.options);
  const config = require("js-yaml").load(readFileSync(configPath, "utf8"));
  assert.equal(config.electronDist, result.archive);
  assert.equal(config.electronVersion, "37.10.3");
  assert.equal(config.productName, "Synthetic");
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(readFileSync(process.env.GITHUB_ENV, "utf8"), `ELECTRON_EXEC_PATH=${result.executable}\n`);
  assert.equal(process.env.GITHUB_TOKEN, "synthetic-token");
});
