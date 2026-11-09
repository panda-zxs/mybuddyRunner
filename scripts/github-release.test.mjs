import test from "node:test";
import assert from "node:assert/strict";
import { downloadGitHubBytes } from "./github-release.mjs";

const assetURL = "https://api.github.com/repos/owner/component/releases/assets/123";
const token = "synthetic-readonly-test-token";

test("authenticates API redirects while stripping credentials from the asset CDN", async () => {
  const calls = [];
  const bytes = await downloadGitHubBytes(assetURL, "application/octet-stream", {
    apiToken: token,
    request: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (calls.length === 1) return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/456/releases/assets/123" } });
      if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file?sig=synthetic" } });
      return new Response("archive");
    },
  });
  assert.equal(bytes.toString(), "archive");
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.options.headers["Cache-Control"], "no-cache");
    assert.ok(call.url.searchParams.get("_mybuddy_nonce"));
    assert.equal(call.options.redirect, "manual");
  }
  assert.equal(calls[2].options.headers.Authorization, undefined);
});

test("a CDN 403 reacquires a fresh signed URL from the API instead of reusing the expired link", async () => {
  const apiURLs = [], waits = [];
  let assetCalls = 0;
  const result = await downloadGitHubBytes(assetURL, "application/octet-stream", {
    apiToken: token, wait: async (ms) => waits.push(ms),
    request: async (url, options) => {
      if (new URL(url).hostname === "api.github.com") {
        apiURLs.push(url);
        return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/file?sig=${apiURLs.length}` } });
      }
      assert.equal(options.headers.Authorization, undefined);
      return ++assetCalls === 1 ? new Response("expired", { status: 403 }) : new Response("verified bytes");
    },
  });
  assert.equal(result.toString(), "verified bytes");
  assert.equal(apiURLs.length, 2);
  assert.notEqual(apiURLs[0], apiURLs[1]);
  assert.deepEqual(waits, [2000]);
});

test("API permission errors stop immediately with safe diagnostics", async () => {
  let calls = 0;
  await assert.rejects(downloadGitHubBytes(assetURL, "application/octet-stream", {
    apiToken: token, request: async () => { calls++; return new Response(token, { status: 403, headers: { "x-ratelimit-remaining": "58" } }); },
  }), (error) => {
    assert.match(error.message, /HTTP 403.*host=api.github.com.*authentication=token.*remaining=58/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls, 1);
});

test("rate limits honor short Retry-After and do not hammer a long reset window", async () => {
  const waits = [];
  let calls = 0;
  await downloadGitHubBytes(assetURL, "application/octet-stream", {
    wait: async (ms) => waits.push(ms), request: async () => ++calls === 1 ? new Response(null, { status: 403, headers: { "retry-after": "3" } }) : new Response("ok"),
  });
  assert.deepEqual(waits, [3000]);
  await assert.rejects(downloadGitHubBytes(assetURL, "application/octet-stream", {
    request: async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "3600" } }),
    wait: async () => assert.fail("must not retry before reset"),
  }), /remaining=0.*retry-after=3600/);
});

test("rejects unexpected redirect hosts and non-HTTPS destinations before sending credentials", async () => {
  for (const location of ["https://example.invalid/token", "https://api.github.com.evil.invalid/file", "http://api.github.com/file", "https://user:password@api.github.com/file"]) {
    let calls = 0;
    await assert.rejects(downloadGitHubBytes(assetURL, "application/octet-stream", {
      apiToken: token, request: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); },
    }), /Unexpected GitHub download redirect origin/);
    assert.equal(calls, 1);
  }
});

test("ordinary release requests never receive the API token", async () => {
  await downloadGitHubBytes("https://github.com/owner/component/releases/download/v1/file", "application/octet-stream", {
    apiToken: token, request: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); return new Response("ok"); },
  });
});

test("network errors cannot leak request credentials or signed URLs into logs", async () => {
  await assert.rejects(downloadGitHubBytes(assetURL, "application/octet-stream", {
    apiToken: token, wait: async () => {}, request: async () => { throw new Error(`https://signed.example/?token=${token}`); },
  }), (error) => {
    assert.ok(!String(error).includes(token));
    assert.equal(error.cause, undefined);
    return true;
  });
});
