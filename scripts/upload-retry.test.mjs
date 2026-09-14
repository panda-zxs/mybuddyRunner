import test from "node:test";
import assert from "node:assert/strict";
import { uploadWithRetry } from "./upload-retry.mjs";

test("retries a transient server failure and a dropped response", async () => {
  let requests = 0;
  const delays = [];
  await uploadWithRetry(async () => {
    requests++;
    if (requests === 1) return new Response(null, { status: 503 });
    if (requests === 2) throw new Error("socket closed");
    return new Response(null, { status: 200 });
  }, "installer.zip", async (delay) => delays.push(delay));
  assert.equal(requests, 3);
  assert.deepEqual(delays, [5000, 10000]);
});

test("never retries authentication or conflicting artifact bytes", async () => {
  for (const status of [401, 403, 409]) {
    let requests = 0;
    await assert.rejects(uploadWithRetry(async () => { requests++; return new Response(null, { status }); }, "installer.zip", async () => assert.fail("must not retry")), new RegExp(String(status)));
    assert.equal(requests, 1);
  }
});
