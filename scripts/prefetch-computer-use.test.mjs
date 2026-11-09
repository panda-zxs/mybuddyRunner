import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefetchComputerUse } from "./prefetch-computer-use.mjs";

const bytes = Buffer.from("pinned upstream archive");
const digest = createHash("sha256").update(bytes).digest("hex");
const name = "Open-Computer-Use-0.3.6-macOS-universal.app.zip";

function fixture(t, { artifact = {}, release = {}, existing } = {}) {
  const root = mkdtempSync(join(tmpdir(), "computer-use-prefetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts", "computer-use"), { recursive: true });
  const manifest = join(root, "scripts", "computer-use", "release.json");
  writeFileSync(manifest, JSON.stringify({ repository: "owner/component", version: "0.3.6", artifacts: { "darwin-arm64": { name, sha256: digest, ...artifact } }, ...release }));
  const cache = join(root, "out", ".computer-use-cache");
  const archive = join(cache, name);
  if (existing) { mkdirSync(cache, { recursive: true }); writeFileSync(archive, existing); }
  return { root, cache, archive, manifest };
}

const metadata = { tag_name: "v0.3.6", assets: [{ name, id: 123, digest: `sha256:${digest}` }] };

test("release 504s recover through the asset API without changing source or pinned bytes", async (t) => {
  const f = fixture(t);
  const source = readFileSync(f.manifest, "utf8");
  const calls = [], waits = [];
  const result = await prefetchComputerUse(f.root, "darwin", "arm64", {
    wait: async (ms) => waits.push(ms),
    request: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal);
      if (url.startsWith("https://github.com/")) return new Response("gateway timeout", { status: 504 });
      if (url.endsWith("/tags/v0.3.6")) return Response.json(metadata);
      assert.equal(options.headers.Accept, "application/octet-stream");
      assert.equal(new URL(url).pathname, "/repos/owner/component/releases/assets/123");
      return new Response(bytes);
    },
  });
  assert.equal(result, f.archive);
  assert.deepEqual(readFileSync(result), bytes);
  assert.equal(readFileSync(f.manifest, "utf8"), source);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 4);
  assert.deepEqual(readdirSync(f.cache), [name]);
});

test("verified caches need no network, including during a GitHub outage", async (t) => {
  const f = fixture(t, { existing: bytes });
  assert.equal(await prefetchComputerUse(f.root, "darwin", "arm64", { request: async () => { throw new Error("network should not be used"); } }), f.archive);
});

test("stale cache is replaced only with checksum-verified bytes", async (t) => {
  const f = fixture(t, { existing: "corrupt cache" });
  await prefetchComputerUse(f.root, "darwin", "arm64", { request: async () => new Response(bytes) });
  assert.deepEqual(readFileSync(f.archive), bytes);
});

test("wrong content from a successful download never falls back or enters the cache", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(prefetchComputerUse(f.root, "darwin", "arm64", { request: async () => { calls++; return new Response("tampered"); } }), /checksum mismatch/);
  assert.equal(calls, 1);
  assert.equal(existsSync(f.archive), false);
});

for (const [label, response] of [
  ["changed asset digest", { ...metadata, assets: [{ name, id: 123, digest: "sha256:wrong" }] }],
  ["wrong release tag", { ...metadata, tag_name: "v0.3.7" }],
  ["missing asset", { ...metadata, assets: [] }],
  ["invalid asset ID", { ...metadata, assets: [{ name, id: "../other" }] }],
]) {
  test(`${label} stops API fallback before fetching an unbound asset`, async (t) => {
    const f = fixture(t);
    await assert.rejects(prefetchComputerUse(f.root, "darwin", "arm64", {
      wait: async () => {}, request: async (url) => url.startsWith("https://github.com/") ? new Response(null, { status: 504 }) : Response.json(response),
    }), /does not match/);
    assert.equal(existsSync(f.archive), false);
  });
}

test("both download routes failing stops after bounded retries without a partial cache", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(prefetchComputerUse(f.root, "darwin", "arm64", {
    wait: async () => {}, request: async () => { calls++; return new Response(null, { status: 504 }); },
  }), /bounded retries/);
  assert.equal(calls, 4);
  assert.equal(existsSync(f.archive), false);
});

test("an interrupted response body retries before accepting the complete archive", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await prefetchComputerUse(f.root, "darwin", "arm64", {
    wait: async () => {}, request: async () => ++calls === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } })) : new Response(bytes),
  });
  assert.equal(calls, 2);
  assert.deepEqual(readFileSync(f.archive), bytes);
});

test("HTTP 403 does not trigger retries or switch download routes", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(prefetchComputerUse(f.root, "darwin", "arm64", { request: async () => { calls++; return new Response(null, { status: 403 }); } }), /HTTP 403/);
  assert.equal(calls, 1);
});

test("unsafe archive paths and unpinned releases cannot start downloads", async (t) => {
  for (const config of [{ artifact: { name: "../escape.zip" } }, { release: { repository: "owner/component?redirect=evil" } }, { release: { version: "latest" } }]) {
    const f = fixture(t, config);
    await assert.rejects(prefetchComputerUse(f.root, "darwin", "arm64", { request: async () => { assert.fail("network should not be used"); } }), /Invalid/);
  }
});

test("older frozen sources without Computer Use remain buildable", async (t) => {
  const f = fixture(t);
  rmSync(f.manifest);
  assert.equal(await prefetchComputerUse(f.root, "darwin", "arm64"), null);
});
