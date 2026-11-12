import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { prefetchVideoTools, videoTarget } from "./prefetch-video-tools.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "video-prefetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "beforePack.js"), "async function prepareVideoTools() { const release = 'b6.1.1'; }");
  const files = [gzipSync(Buffer.from("test encoder")), Buffer.from("license"), Buffer.from("source notice")];
  const asset = (id, name) => ({ id, name, size: files[id - 1].length, sha256: hash(files[id - 1]) });
  const target = { archive: asset(1, "ffmpeg-win32-x64.gz"), binarySha256: hash(Buffer.from("test encoder")), license: asset(2, "win32-x64.LICENSE"), readme: asset(3, "win32-x64.README") };
  const release = { repository: "owner/encoder", release: "b6.1.1", targets: { "win32-x64": target } };
  const calls = [];
  const request = async (url) => { const id = Number(new URL(url).pathname.split("/").at(-1)); calls.push(id); return new Response(files[id - 1]); };
  return { root, release, files, calls, request, destination: join(root, "resources", "video-tools", "win32-arm64") };
}

test("Windows ARM64 retains the source's x64 encoder compatibility while preparing every required notice", async (t) => {
  const f = fixture(t);
  const result = await prefetchVideoTools(f.root, "win32", "arm64", f);
  assert.equal(result, f.destination);
  assert.equal(readFileSync(join(result, "ffmpeg.exe"), "utf8"), "test encoder");
  assert.deepEqual(JSON.parse(readFileSync(join(result, "source.json"), "utf8")), { release: "b6.1.1", platform: "win32", binaryArch: "x64", sha256: f.release.targets['win32-x64'].binarySha256 });
  assert.deepEqual(f.calls, [1, 2, 3]);
});

test("verified encoder caches work offline and notice corruption triggers repair", async (t) => {
  const f = fixture(t);
  await prefetchVideoTools(f.root, "win32", "arm64", f);
  await prefetchVideoTools(f.root, "win32", "arm64", { release: f.release, request: async () => assert.fail("cache must avoid downloads") });
  writeFileSync(join(f.destination, "ffmpeg.exe.LICENSE"), "corrupt");
  await prefetchVideoTools(f.root, "win32", "arm64", f);
  assert.equal(readFileSync(join(f.destination, "ffmpeg.exe.LICENSE"), "utf8"), "license");
  assert.equal(f.calls.length, 6);
});

test("archive checksum failures never publish a prepared source record", async (t) => {
  const f = fixture(t);
  await assert.rejects(prefetchVideoTools(f.root, "win32", "arm64", { ...f, request: async () => new Response("tampered") }), /checksum or size mismatch/);
  assert.equal(existsSync(f.destination), false);
});

test("missing required license does not overwrite an older bundle", async (t) => {
  const f = fixture(t);
  mkdirSync(f.destination, { recursive: true });
  writeFileSync(join(f.destination, "source.json"), "old bundle");
  await assert.rejects(prefetchVideoTools(f.root, "win32", "arm64", {
    ...f, request: async (url) => new URL(url).pathname.endsWith("/2") ? new Response(null, { status: 403 }) : f.request(url),
  }), /HTTP 403/);
  assert.equal(readFileSync(join(f.destination, "source.json"), "utf8"), "old bundle");
});

test("changed frozen source releases require reviewed pins instead of silent substitution", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "scripts", "beforePack.js"), "async function prepareVideoTools() { const release = 'b7.0.0'; }");
  await assert.rejects(prefetchVideoTools(f.root, "win32", "arm64", f), /differs from the reviewed/);
  assert.deepEqual(f.calls, []);
});

test("pins cover all current targets without executing the wrong architecture", () => {
  for (const platform of ["darwin", "linux", "win32"]) for (const arch of ["arm64", "x64"]) {
    const target = videoTarget(platform, arch);
    assert.equal(target.binaryArch, platform === "win32" && arch === "arm64" ? "x64" : arch);
  }
  assert.throws(() => videoTarget("freebsd", "x64"), /Unsupported/);
});

test("supports Tauri source layout via tauriReleaseHelpers.cjs", async (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "scripts"), { recursive: true, force: true });
  mkdirSync(join(f.root, "packages", "release-tools", "src"), { recursive: true });
  writeFileSync(
    join(f.root, "packages", "release-tools", "src", "tauriReleaseHelpers.cjs"),
    "async function prepareVideoTools() { const release = 'b6.1.1'; }",
  );
  const result = await prefetchVideoTools(f.root, "win32", "arm64", f);
  assert.equal(result, f.destination);
  assert.equal(readFileSync(join(result, "ffmpeg.exe"), "utf8"), "test encoder");
});
