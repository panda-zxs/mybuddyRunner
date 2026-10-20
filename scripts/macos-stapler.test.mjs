import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStapler } from "./macos-stapler.mjs";

function fixture(results, overrides = {}) {
  let time = 0;
  const calls = [], sleeps = [], lines = [], stdout = [], stderr = [];
  const options = {
    env: { MYBUDDY_STAPLER_LOG: "/private/runner temp/stapler.jsonl" },
    now: () => time,
    execute: async (...args) => {
      calls.push(args);
      const result = results.shift();
      if (!result) throw new Error("unexpected native invocation");
      time += result.elapsedMs || 0;
      return result;
    },
    sleep: async ms => { sleeps.push(ms); time += ms; },
    append: (path, line, opts) => lines.push({ path, line, opts }),
    stdout: value => stdout.push(value),
    stderr: value => stderr.push(value),
    ...overrides,
  };
  return { calls, sleeps, lines, stdout, stderr, options, entries: () => lines.map(({ line }) => JSON.parse(line)) };
}

test("temporary Apple record lookup failure recovers without submitting, re-signing or changing arguments", async () => {
  const f = fixture([
    { code: 65, stderr: 'CloudKit query for MyBuddy.app failed: "Record not found".\n' },
    { code: 0, stdout: "The staple and validate action worked!\n" },
  ]);
  const args = ["-v", "/private/runner work/out/My Buddy.app"];
  assert.equal(await runStapler("staple", args, f.options), 0);
  assert.equal(f.calls.length, 2);
  for (const [command, forwarded, opts] of f.calls) {
    assert.equal(command, "/usr/bin/xcrun");
    assert.deepEqual(forwarded, ["stapler", "staple", ...args]);
    assert.equal(opts.killSignal, "SIGKILL");
    assert.equal(opts.timeout, 45_000);
  }
  assert.deepEqual(f.sleeps, [5_000]);
  assert.match(f.stdout.join(""), /staple and validate action worked/);
  assert.equal(f.entries().at(-1).reason, "native_success");
});

test("generic error 65 and permanent validation failures fail closed without retry", async () => {
  for (const error of [
    "The staple and validate action failed! Error 65.",
    "Could not validate ticket for MyBuddy.app. Record not found.",
    "Ticket is revoked",
    "CDHash mismatch",
    "invalid signature",
    "Certificate is expired",
    "Trust evaluation failed",
    "Permission denied",
    "No such file or directory",
    "File does not exist",
  ]) {
    const f = fixture([{ code: 65, stderr: error }]);
    assert.equal(await runStapler("staple", ["/tmp/MyBuddy.app"], f.options), 65, error);
    assert.equal(f.calls.length, 1, error);
    assert.deepEqual(f.sleeps, [], error);
    assert.equal(f.entries().at(-1).reason, "native_failure", error);
  }
});

test("known temporary network errors and native timeouts are retryable with bounded attempts", async () => {
  for (const stderr of [
    "Error Domain=NSURLErrorDomain Code=-1001",
    "The network connection was lost",
    "Could not connect to the server",
    "Connection reset by peer",
    "CloudKit service temporarily unavailable",
  ]) {
    const f = fixture([{ code: 68, stderr }, { code: 0 }]);
    assert.equal(await runStapler("staple", ["/tmp/a.dmg"], f.options), 0);
    assert.equal(f.calls.length, 2);
  }
  const f = fixture(Array.from({ length: 3 }, () => ({ code: 1, timedOut: true, errorCode: "ETIMEDOUT", elapsedMs: 45_000 })), { maxAttempts: 99, budgetMs: 999_000, attemptTimeoutMs: 999_000 });
  assert.equal(await runStapler("staple", ["/tmp/a.pkg"], f.options), 124);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.sleeps, [5_000, 15_000]);
  assert.ok(f.calls.every(([, , opts]) => opts.timeout === 45_000));
  assert.equal(f.entries()[0].budgetMs, 210_000);
  assert.equal(f.entries().at(-1).reason, "retries_exhausted");
});

test("wall clock budget bounds retries and preserves the last native failure", async () => {
  const f = fixture([{ code: 68, stderr: "Request timed out", elapsedMs: 19_000 }], { budgetMs: 20_000 });
  assert.equal(await runStapler("staple", ["/tmp/a.app"], f.options), 68);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].timeout, 20_000);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.entries().at(-1).reason, "budget_exhausted");
  const timed = fixture([{ code: 68, stderr: "Request timed out", elapsedMs: 5_000 }, { code: 68, stderr: "Request timed out", elapsedMs: 2_000 }], { budgetMs: 12_000 });
  assert.equal(await runStapler("staple", ["/tmp/a.app"], timed.options), 68);
  assert.equal(timed.calls[1][2].timeout, 2_000);
});

test("validate retains native output/status, never retries, and has its own shorter deadline", async () => {
  for (const code of [0, 65]) {
    const f = fixture([{ code, stdout: "validate stdout\n", stderr: "Request timed out\n" }], { maxAttempts: 9, budgetMs: 999_000, attemptTimeoutMs: 999_000 });
    assert.equal(await runStapler("validate", ["/tmp/a.app"], f.options), code);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.sleeps, []);
    assert.equal(f.calls[0][2].timeout, 60_000);
    assert.equal(f.stdout.join(""), "validate stdout\n");
    assert.equal(f.stderr.join(""), "Request timed out\n");
  }
});

test("diagnostics are bounded JSONL and omit arguments, credentials and unrelated environment", async () => {
  const env = {
    MYBUDDY_STAPLER_LOG: "/private/runner temp/stapler.jsonl",
    APPLE_APP_SPECIFIC_PASSWORD: "the-apple-secret",
    CSC_KEY_PASSWORD: "key-secret",
    API_TOKEN: "api-secret",
    UNRELATED_VARIABLE: "never-log-the-environment",
  };
  const f = fixture(Array.from({ length: 3 }, () => ({
    code: 68,
    stdout: `the-apple-secret key-secret api-secret Authorization: Bearer unknown-secret https://example.com/?token=url-secret\n${"签名".repeat(70_000)}`,
    stderr: "Request timed out\npassword=inline-secret\n",
  })), { env });
  assert.equal(await runStapler("staple", ["/private/do-not-log-this-argument.app"], f.options), 68);
  const log = f.lines.map(({ line }) => line).join("");
  assert.ok(Buffer.byteLength(log) <= 64 * 1024);
  assert.ok(f.lines.length > 0);
  assert.ok(f.lines.every(({ opts }) => opts.mode === 0o600));
  assert.doesNotMatch(log, /the-apple-secret|key-secret|api-secret|unknown-secret|url-secret|inline-secret|never-log-the-environment|do-not-log-this-argument/);
  assert.doesNotMatch([...f.stdout, ...f.stderr].join(""), /the-apple-secret|key-secret|api-secret|unknown-secret|url-secret|inline-secret/);
  assert.match(log, /REDACTED/);
  assert.match(log, /output truncated/);
  assert.equal(f.entries().at(-1).reason, "retries_exhausted");
});

test("unsupported actions and arguments fail clearly before any native invocation", async () => {
  for (const [action, args] of [
    ["notarytool", ["submit", "/tmp/a.zip"]],
    ["staple", []],
    ["staple", ["--password", "secret"]],
    ["staple", ["/tmp/a.app", "/tmp/b.app"]],
    ["validate", ["-q", "-v", "/tmp/a.app"]],
  ]) {
    const f = fixture([]);
    assert.equal(await runStapler(action, args, f.options), 64);
    assert.equal(f.calls.length, 0);
    assert.match(f.stderr.join(""), /unsupported arguments/);
    assert.doesNotMatch(f.stderr.join(""), /secret/);
  }
});

test("missing diagnostics cannot hide native failure, and missing logs do not dump environment", async () => {
  const f = fixture([{ code: 65, stderr: "ticket invalid\n" }], {
    append() { throw new Error("disk issue with secret details"); },
  });
  assert.equal(await runStapler("staple", ["/tmp/a.app"], f.options), 65);
  assert.match(f.stderr.join(""), /Could not write/);
  assert.doesNotMatch(f.stderr.join(""), /secret details/);
  const withoutLog = fixture([{ code: 0 }], { env: {} });
  assert.equal(await runStapler("validate", ["/tmp/a.app"], withoutLog.options), 0);
  assert.equal(withoutLog.lines.length, 0);
});

test("diagnostic file is bounded across repeated invocations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stapler-log-"));
  const path = join(dir, "stapler.jsonl");
  try {
    writeFileSync(path, " ".repeat(256 * 1024 - 10));
    const f = fixture([{ code: 65, stderr: "native failure" }], { env: { MYBUDDY_STAPLER_LOG: path }, append: undefined });
    assert.equal(await runStapler("staple", ["/tmp/a.app"], f.options), 65);
    assert.ok(statSync(path).size <= 256 * 1024);
    assert.match(f.stderr.join(""), /size limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redaction precedes truncation so a credential spanning the output limit cannot leak its prefix", async () => {
  const secret = "sensitive-prefix-that-must-never-appear-in-output";
  const f = fixture([{ code: 65, stdout: " ".repeat(128 * 1024 - 12) + secret }], {
    env: { MYBUDDY_STAPLER_LOG: "/tmp/stapler.jsonl", APPLE_APP_SPECIFIC_PASSWORD: secret },
  });
  assert.equal(await runStapler("staple", ["/tmp/a.app"], f.options), 65);
  assert.doesNotMatch(f.stdout.join(""), /sensitive/);
  assert.doesNotMatch(f.lines.map(({ line }) => line).join(""), /sensitive/);
});

test("launch errors, signals and malformed native results never become success", async () => {
  for (const result of [{ code: 0, signal: "SIGKILL" }, { code: 0, timedOut: true }, { code: 0, errorCode: "ENOENT" }, {}, { code: -1 }]) {
    const f = fixture([result]);
    assert.notEqual(await runStapler("validate", ["/tmp/a.app"], f.options), 0);
  }
  const f = fixture([], { execute: async () => { throw Object.assign(new Error("hidden launch details"), { code: "ENOENT" }); } });
  assert.equal(await runStapler("validate", ["/tmp/a.app"], f.options), 1);
  assert.equal(f.entries().find(entry => entry.event === "attempt").errorCode, "ENOENT");
});
