import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-desktop-source.mjs", import.meta.url));

test("the source archive must contain the marker for the runtime selected in the plan", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-source-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [runtime, marker, mismatch] of [
    ["tauri", "packages/desktop-tauri/tauri.conf.json", "electron"],
    ["electron", "packages/desktop/electron-builder.yml", "tauri"],
  ]) {
    const source = join(root, runtime, marker);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "");
    const env = { ...process.env, SOURCE_DIR: join(root, runtime), DESKTOP_RUNTIME: runtime };
    const matched = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.equal(matched.status, 0, matched.stderr);
    const mismatched = spawnSync(process.execPath, [script], {
      env: { ...env, DESKTOP_RUNTIME: mismatch },
      encoding: "utf8",
    });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /Frozen Desktop source does not match/);
  }
});
