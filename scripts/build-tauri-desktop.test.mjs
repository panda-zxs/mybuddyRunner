import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTauriDesktop, verifyInstalledWindowsPayload } from "./build-tauri-desktop.mjs";

test("runs macOS Tauri release preparation and packaging in order", () => {
  const calls = [];
  buildTauriDesktop("darwin", "arm64", {
    env: {},
    execute: (command, args, env) => {
      calls.push({ command, args, release: env.MYBUDDY_TAURI_RELEASE, arch: env.MYBUDDY_TAURI_MAC_ARCH });
    },
  });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["scripts/prepareMyBuddyCore.js"],
      ["scripts/prepareMarketResources.js"],
      ["scripts/prepareHubResources.js"],
      ["packages/desktop-tauri/macos-release.mjs", "resources", "arm64"],
      ["packages/desktop-tauri/build-macos.sh", "out"],
    ],
  );
  assert.ok(calls.every((call) => call.release === "1"));
  assert.equal(calls.at(-1).arch, "arm64");
});

test("runs Windows Tauri release packaging and verifies installed payload", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tauri-win-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "MyBuddy-1.2.3-build.1-win-x64.exe"), "installer");

  const calls = [];
  buildTauriDesktop("win32", "x64", {
    cwd: root,
    execute: (command, args) => {
      calls.push({ command, args });
      const installArg = args.find((arg) => arg.startsWith("/D="));
      if (installArg) {
        const installDir = installArg.slice(3);
        const managedDir = join(installDir, "bundled-mybuddy-core", "win32-x64", "managed-resources");
        mkdirSync(join(installDir, "static"), { recursive: true });
        mkdirSync(join(managedDir, "node"), { recursive: true });
        writeFileSync(join(installDir, "mybuddy-tauri.exe"), "exe");
        writeFileSync(join(installDir, "host.mjs"), "host");
        writeFileSync(join(installDir, "static", "index.html"), "html");
        writeFileSync(join(installDir, "bundled-mybuddy-core", "win32-x64", "mybuddy-core.exe"), "core");
        writeFileSync(join(managedDir, "manifest.json"), JSON.stringify({ node: { root: "node", executable: "node.exe" } }));
        writeFileSync(join(managedDir, "node", "node.exe"), "node");
      }
    },
  });

  assert.deepEqual(
    calls.slice(0, 5).map((call) => call.args),
    [
      ["scripts/prepareMyBuddyCore.js"],
      ["scripts/prepareMarketResources.js"],
      ["scripts/prepareHubResources.js"],
      ["packages/release-tools/src/buildTauriWindows.mjs", "resources", "x64"],
      ["packages/release-tools/src/buildTauriWindows.mjs", "out", "--arch=x64"],
    ],
  );
  assert.equal(calls.length, 6);
  assert.equal(calls[5].args[0], "/S");
  assert.match(calls[5].args[1], /^\/D=/);
});

test("rejects incomplete Windows Tauri installation payload", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tauri-win-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => verifyInstalledWindowsPayload(dir, "x64"));
});
