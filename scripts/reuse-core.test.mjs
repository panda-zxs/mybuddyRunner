import test from "node:test";
import assert from "node:assert/strict";
import { hasUploadedCore } from "./reuse-core.mjs";

const config = { serverURL: "https://updates.example", taskId: "bt_0102030405060708090a0b0c", secret: "fixture-secret", target: "darwin-x64" };

test("registered Core is reused through the task-scoped endpoint without downloading its body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "X-Content-SHA256": "a".repeat(64), "Content-Length": "100000000" },
  });
  assert.equal(await hasUploadedCore(config, async (url, options) => {
    assert.equal(url.href, "https://updates.example/releases/ci/v1/tasks/bt_0102030405060708090a0b0c/artifacts/core/darwin-x64/mybuddy-core-darwin-x64.zip");
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return response;
  }), true);
  assert.equal(cancelled, true);
});

test("only a missing Core permits fallback; authentication and service errors fail closed", async () => {
  assert.equal(await hasUploadedCore(config, async () => new Response(null, { status: 404 })), false);
  for (const status of [204, 302, 401, 403, 409, 500, 503]) {
    await assert.rejects(hasUploadedCore(config, async () => new Response(null, { status }), { wait: async () => {} }), /Core reuse check failed/);
  }
  for (const headers of [{}, { "X-Content-SHA256": "a".repeat(64), "Content-Length": "0" }, { "X-Content-SHA256": "invalid", "Content-Length": "1" }]) {
    await assert.rejects(hasUploadedCore(config, async () => new Response(null, { headers })), /invalid registered Core metadata/);
  }
});

test("invalid destinations and targets are rejected before credentials are sent", async () => {
  for (const changes of [{ serverURL: "http://updates.example" }, { serverURL: "https://user:password@updates.example" }, { target: "../../other" }, { taskId: "other-task" }, { secret: "" }]) {
    let called = false;
    await assert.rejects(hasUploadedCore({ ...config, ...changes }, async () => { called = true; }));
    assert.equal(called, false);
  }
});
