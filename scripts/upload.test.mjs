import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const preload = String.raw`
import { writeFileSync } from "node:fs";
import timers from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
timers.setTimeout = async () => {};
syncBuiltinESMExports();
const calls = [];
let registered = false;
let registrationAttempts = 0;
process.on("exit", () => writeFileSync(process.env.CALLS, JSON.stringify(calls)));
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method || "GET";
  calls.push({ method, path: url.pathname, ...(method === "POST" ? { body: options.body } : {}) });
  if (url.origin === "https://updates.example") {
    if (options.headers.Authorization !== "Bearer fixture-secret" || options.redirect !== "error") {
      return new Response(null, { status: 403 });
    }
    if (url.pathname.endsWith("/plan")) {
      const headers = process.env.SCENARIO === "legacy" ? {} : { "X-MyBuddy-Task-Status": process.env.SCENARIO === "failed" ? "failed" : "running" };
      return Response.json({ taskId: process.env.TASK_ID }, { headers });
    }
    if (method === "GET") {
      if (registered || ["registered", "different", "bad-metadata"].includes(process.env.SCENARIO)) {
        const headers = { "Content-Length": process.env.SIZE, "X-Content-SHA256": process.env.SHA256 };
        if (process.env.SCENARIO === "different") headers["X-Content-SHA256"] = "a".repeat(64);
        if (process.env.SCENARIO === "bad-metadata") delete headers["X-Content-SHA256"];
        return new Response("registered installer", { headers });
      }
      if (process.env.SCENARIO === "denied") return new Response(null, { status: 403 });
      return new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/staged-upload-multipart")) {
      if (["failed", "registered", "conflict"].includes(process.env.SCENARIO)) {
        return new Response("conflict\nfixture-secret signed-url?secret=fixture", { status: 409 });
      }
      return Response.json({ uploadId: "fixture-upload", partSize: Number(process.env.SIZE), parts: [{ number: 1, url: "https://objects.example/part", headers: { "x-oss-acl": "private" } }] });
    }
    if (url.pathname.endsWith("/staged-multipart")) {
      registrationAttempts++;
      const payload = JSON.parse(options.body);
      if (payload.sha256 !== process.env.SHA256 || payload.size !== Number(process.env.SIZE) || payload.parts[0]?.etag !== "fixture-etag") return new Response(null, { status: 400 });
      if (process.env.SCENARIO === "register-retry" && registrationAttempts === 1) return new Response(null, { status: 503 });
      if (process.env.SCENARIO === "register-race") { registered = true; return new Response(null, { status: 409 }); }
      if (process.env.SCENARIO === "verify-failed") return new Response("fixture-secret signed-url?secret=fixture", { status: 503, headers: { "X-MyBuddy-Error-Code": "staged_object_verify_failed", "X-Request-Id": "fixture-request-123" } });
      return Response.json({});
    }
    return new Response(null, { status: 409 });
  }
  if (url.href === "https://objects.example/part" && method === "PUT") {
    if (options.headers.Authorization || options.headers["x-oss-acl"] !== "private") return new Response(null, { status: 403 });
    let content = "";
    for await (const chunk of options.body) content += chunk;
    return new Response(null, { status: content === "fixture installer" ? 200 : 400, headers: { ETag: '"fixture-etag"' } });
  }
  return new Response(null, { status: 400 });
};
`;

function runUpload(scenario) {
  const directory = mkdtempSync(join(tmpdir(), "runner-upload-"));
  try {
    const artifact = join(directory, "MyBuddy-1.1.100-build.1-win-x64.exe");
    const setup = join(directory, "fetch.mjs");
    const calls = join(directory, "calls.json");
    const content = "fixture installer";
    writeFileSync(artifact, content);
    writeFileSync(setup, preload);
    const result = spawnSync(process.execPath, ["--import", setup, new URL("./upload.mjs", import.meta.url).pathname, "desktop", "windows-x64", artifact], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, UPDATE_SERVER_URL: "https://updates.example", TASK_ID: "bt_0102030405060708090a0b0c", MYBUDDY_BUILD_SECRET: "fixture-secret", SCENARIO: scenario, CALLS: calls, SIZE: String(content.length), SHA256: createHash("sha256").update(content).digest("hex") },
    });
    assert.ifError(result.error);
    return { ...result, calls: JSON.parse(readFileSync(calls, "utf8")) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("an ended task fails before any artifact transfer and explains how to retry", () => {
  const result = runUpload("failed");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed.*retry.*Pilot\/Update Server/i);
  assert.match(result.stderr, /GitHub Re-run/i);
  assert.deepEqual(result.calls.map(call => call.method), ["GET"]);
});

test("an identical registered installer is reused without opening another upload", () => {
  const result = runUpload("registered");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reused registered/);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(call => call.method === "GET"));
});

test("missing installers still complete the authenticated multipart upload", () => {
  for (const scenario of ["missing", "legacy"]) {
    const result = runUpload(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.method), ["GET", "GET", "POST", "PUT", "POST"]);
    assert.match(result.stdout, /Uploaded .*oss-staged/);
  }
});

test("different bytes, invalid metadata and authorization failures never permit overwriting", () => {
  for (const [scenario, expected] of [["different", /registered artifact differs/], ["bad-metadata", /invalid registered artifact metadata/], ["denied", /registered artifact check failed.*403/]]) {
    const result = runUpload(scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.ok(result.calls.every(call => call.method === "GET"));
  }
});

test("upload conflicts remain failures with recovery guidance and no response payload leakage", () => {
  const result = runUpload("conflict");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /409.*retry.*Pilot\/Update Server/i);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|signed-url/);
  assert.equal(result.calls.filter(call => call.path.endsWith("staged-upload-multipart")).length, 1);
  assert.ok(result.calls.every(call => call.method !== "PUT"));
});

test("registration retries reuse the same multipart receipt and handle a matching registration race", () => {
  for (const scenario of ["register-retry", "register-race"]) {
    const result = runUpload(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.filter(call => call.method === "PUT").length, 1);
    assert.equal(result.calls.filter(call => call.path.endsWith("staged-upload-multipart")).length, 1);
    const registrations = result.calls.filter(call => call.path.endsWith("staged-multipart"));
    if (scenario === "register-retry") {
      assert.equal(registrations.length, 2);
      assert.equal(registrations[0].body, registrations[1].body);
    } else {
      assert.equal(registrations.length, 1);
      assert.equal(result.calls.at(-1).method, "GET");
    }
  }
});

test("persistent registration errors stay failures after bounded retries with safe correlation", () => {
  const result = runUpload("verify-failed");
  assert.equal(result.status, 1);
  assert.equal(result.calls.filter(call => call.path.endsWith("staged-multipart")).length, 4);
  assert.match(result.stderr, /503; staged_object_verify_failed/);
  assert.match(result.stderr, /request=fixture-request-123/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|signed-url/);
});
