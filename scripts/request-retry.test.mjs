import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./request-retry.mjs";

test("retries connection timeouts and transient responses, preserving response bodies", async () => {
  let requests = 0, cancelled = false;
  const delays = [];
  const response = await fetchWithRetry("https://updates.example/task", { headers: { Authorization: "Bearer fixture-secret" }, redirect: "error" }, {
    wait: async value => delays.push(value),
    request: async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer fixture-secret");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (++requests === 1) throw new TypeError("fetch failed: secret must not be printed");
      if (requests === 2) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
      return new Response("registered artifact");
    },
  });
  assert.equal(await response.text(), "registered artifact");
  assert.equal(cancelled, true);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [5000, 10000]);
});

test("does not retry identity failures, conflicts, conditional or missing results", async () => {
  for (const status of [304, 400, 401, 403, 404, 405, 409, 422]) {
    let requests = 0;
    const result = await fetchWithRetry("https://updates.example/task", {}, {
      wait: async () => assert.fail("must not retry"),
      request: async () => { requests++; return new Response(null, { status }); },
    });
    assert.equal(result.status, status);
    assert.equal(requests, 1);
  }
});

test("bounds silent connection attempts and reports no sensitive native error", async () => {
  let requests = 0;
  await assert.rejects(fetchWithRetry("https://updates.example/signed?secret=fixture", {}, {
    timeoutMs: 5, wait: async () => {},
    request: async (url, options) => new Promise((resolve, reject) => {
      requests++;
      options.signal.addEventListener("abort", () => reject(new Error("fixture-secret")), { once: true });
    }),
  }), error => error.message === "Update Server request connection failed after 4 attempts");
  assert.equal(requests, 4);
});

test("header timeout is cleared before consuming a successful download body", async () => {
  let signal;
  const response = await fetchWithRetry("https://updates.example/installer", {}, {
    timeoutMs: 5,
    request: async (url, options) => { signal = options.signal; return new Response("installer"); },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
  assert.equal(await response.text(), "installer");
});
