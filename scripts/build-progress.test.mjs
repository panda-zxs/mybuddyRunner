import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildProcesses, runBuild } from "./build-progress.mjs";

test("progress reports only this build's known executable names, never arguments or unrelated processes", () => {
  const rows = buildProcesses(`
    12 11 01:02 0.0 /usr/bin/codesign
    30 1 02:03 0.1 /usr/bin/notarytool
    10 1 05:01 0.2 /usr/local/bin/node
    11 10 02:01 1.2 /bin/bash
    13 10 00:01 0.1 /private/secret-not-a-command
  `, 10);
  assert.deepEqual(rows.map(row => row.name), ["codesign", "node", "bash"]);
  assert.ok(rows.every(row => [10, 11, 12].includes(row.pid)));
  assert.doesNotMatch(JSON.stringify(rows), /secret|notarytool|\/private/);
});

test("build exit status and spawn failures cannot be reported as success", async () => {
  for (const code of [0, 7]) {
    const messages = [];
    assert.equal(await runBuild(process.execPath, ["-e", `process.exit(${code})`], { report: text => messages.push(text) }), code);
    assert.match(messages.at(-1), new RegExp(`exit=${code}`));
  }
  assert.equal(await runBuild("/definitely-not-a-build-command", [], { report() {} }), 1);
});

test("timeouts stop the process group, including descendants that ignore SIGTERM", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "build-progress-"));
  const escaped = join(dir, "escaped"), group = join(dir, "group");
  const descendant = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(escaped)},'alive'),700); setInterval(()=>{},1000);`;
  const parent = `require('fs').writeFileSync(${JSON.stringify(group)},String(process.pid)); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
  try {
    const messages = [];
    const code = await runBuild(process.execPath, ["-e", parent], { timeoutMs: 250, killDelayMs: 50, intervalMs: 100, report: text => messages.push(text) });
    assert.equal(code, 124);
    assert.ok(existsSync(group), "real parent process was started");
    await delay(800);
    assert.equal(existsSync(escaped), false, "descendant must not keep working after timeout");
    assert.ok(messages.some(text => text.startsWith("::error::Desktop build exceeded")));
  } finally {
    if (existsSync(group)) {
      try { process.kill(-Number(readFileSync(group, "utf8")), "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
