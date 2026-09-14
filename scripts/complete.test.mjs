import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { completeTask, COMPLETION_TIMEOUT_MS } from "./complete.mjs";

const config = { base: "https://updates.example.test", taskId: `bt_${"a".repeat(24)}`, secret: "test-secret", succeeded: true };
function responder(statusCode, delay = 0) {
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    let responseTimer;
    req.destroy = () => { clearTimeout(responseTimer); req.emit("error", new Error("socket closed")); };
    req.end = (body) => {
      calls.push({ url: url.toString(), options, body });
      responseTimer = setTimeout(() => {
        const res = Readable.from(["{}"]);
        res.statusCode = statusCode;
        callback(res);
      }, delay);
    };
    return req;
  };
  return { request, calls };
}

test("waits for delayed release registration and sends the exact authenticated result", async () => {
  const mock = responder(200, 30);
  await completeTask({ ...config, request: mock.request, timeoutMs: 500 });
  assert.equal(COMPLETION_TIMEOUT_MS, 3600000);
  assert.equal(mock.calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.deepEqual(JSON.parse(mock.calls[0].body), { succeeded: true, reason: "" });
});

test("rejects redirects and server failures without forwarding the credential", async () => {
  for (const status of [302, 401, 409, 503]) {
    const mock = responder(status);
    await assert.rejects(completeTask({ ...config, request: mock.request }), new RegExp(`\\(${status}\\)`));
    assert.equal(mock.calls.length, 1);
  }
});

test("aborts a stalled completion request at its deadline", async () => {
  const mock = responder(200, 100);
  await assert.rejects(completeTask({ ...config, request: mock.request, timeoutMs: 10 }), /timed out/);
});

test("rejects an insecure callback before sending credentials", () => {
  const mock = responder(200);
  assert.throws(() => completeTask({ ...config, base: "http://updates.example.test", request: mock.request }), /invalid completion/);
  assert.equal(mock.calls.length, 0);
});
