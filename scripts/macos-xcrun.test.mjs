import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./macos-tools/xcrun", import.meta.url));

test("macOS wrapper forwards spaced paths and preserves helper failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "macos-xcrun-"));
  try {
    const helper = join(dir, "capture helper.mjs");
    const capture = join(dir, "captured.json");
    writeFileSync(helper, `import fs from "node:fs";
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
process.exitCode = Number(process.env.TEST_EXIT);
`);
    for (const action of ["staple", "validate"]) {
      const args = [action, "-v", "/some path/My Buddy.app"];
      assert.throws(() => execFileSync("bash", [wrapper, "stapler", ...args], {
        env: { ...process.env, MYBUDDY_STAPLER_NODE: process.execPath,
          MYBUDDY_STAPLER_HELPER: helper, CAPTURE: capture, TEST_EXIT: "65" },
        stdio: "pipe",
      }), error => error.status === 65);
      assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), args);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notary credentials and SDK commands bypass the helper without logging", () => {
  const dir = mkdtempSync(join(tmpdir(), "macos-xcrun-pass-"));
  try {
    const capture = join(dir, "exec-args");
    // Replace only Bash's exec builtin in this test, so Linux can verify the
    // actual routing to /usr/bin/xcrun without an Apple toolchain.
    const harness = `exec() { printf '%s\\0' "$@" > "$CAPTURE"; exit 0; }
export -f exec
bash "$WRAPPER" "$@"`;
    for (const args of [
      ["notarytool", "submit", "/tmp/a file.zip", "--password", "test-secret"],
      ["--sdk", "macosx", "--show-sdk-path"],
      ["stapler", "help"],
    ]) {
      const output = execFileSync("bash", ["-c", harness, "_", ...args], {
        env: { ...process.env, WRAPPER: wrapper, CAPTURE: capture,
          MYBUDDY_STAPLER_NODE: "/must-not-run", MYBUDDY_STAPLER_HELPER: "/must-not-run" },
        encoding: "utf8", stdio: "pipe",
      });
      assert.equal(output, "");
      assert.deepEqual(readFileSync(capture, "utf8").split("\0").slice(0, -1),
        ["/usr/bin/xcrun", ...args]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
