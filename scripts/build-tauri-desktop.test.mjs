import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { buildTauriDesktop, verifyInstalledWindowsPayload, verifyInstalledWindowsStartup } from "./build-tauri-desktop.mjs";

test("runs macOS Tauri release preparation and packaging in order", async () => {
  const calls = [];
  await buildTauriDesktop("darwin", "arm64", {
    env: {},
    execute: (command, args, env) => {
      calls.push({ command, args, release: env.MYBUDDY_TAURI_RELEASE, arch: env.MYBUDDY_TAURI_MAC_ARCH });
    },
  });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["scripts/prepareMyBuddyCore.js"],
      ["scripts/prepareHubResources.js"],
      ["packages/desktop-tauri/macos-release.mjs", "resources", "arm64"],
      ["packages/desktop-tauri/build-macos.sh", "out"],
    ],
  );
  assert.ok(calls.every((call) => call.release === "1"));
  assert.equal(calls.at(-1).arch, "arm64");
});

for (const { name, legacy, startupFails } of [
  { name: "workspace readiness" },
  { name: "startup failure", startupFails: true },
  { name: "shell readiness from a legacy source", legacy: true },
]) {
  test(`installs, launches and uninstalls Windows Tauri after ${name}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "tauri-win-runner-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source checkout");
    mkdirSync(join(sourceDir, "out"), { recursive: true });
    const installer = join(sourceDir, "out", "MyBuddy-1.2.3-build.1-win-x64.exe");
    writeFileSync(installer, "installer");
    const shellDir = join(sourceDir, "packages", "desktop-tauri", "src", "desktop");
    mkdirSync(shellDir, { recursive: true });
    writeFileSync(join(shellDir, "shell.rs"), legacy ? "" : 'eprintln!("MYBUDDY_DESKTOP_WORKSPACE_READY");');

    const calls = [];
    const build = buildTauriDesktop("win32", "x64", {
      cwd: sourceDir,
      env: { RUNNER_TEMP: root },
      execute: (command, args, env, options) => {
        calls.push({ command, args, options });
        const installArg = args.find((arg) => arg.startsWith("/D="));
        if (installArg) {
          const installDir = installArg.slice(3);
          const managedDir = join(installDir, "bundled-mybuddy-core", "win32-x64", "managed-resources");
          mkdirSync(join(installDir, "static"), { recursive: true });
          mkdirSync(join(managedDir, "node"), { recursive: true });
          writeFileSync(join(installDir, "mybuddy.exe"), "exe");
          writeFileSync(join(installDir, "uninstall.exe"), "uninstaller");
          writeFileSync(join(installDir, "host.mjs"), "host");
          writeFileSync(join(installDir, "static", "index.html"), "html");
          writeFileSync(join(installDir, "bundled-mybuddy-core", "win32-x64", "mybuddy-core.exe"), "core");
          writeFileSync(join(managedDir, "manifest.json"), JSON.stringify({ node: { root: "node", executable: "node.exe" } }));
          writeFileSync(join(managedDir, "node", "node.exe"), "node");
        }
      },
      verifyStartup: async (installDir, profileDir, { readyMarker }) => {
        calls.push({ command: "verifyStartup", args: [installDir, profileDir] });
        assert.ok(existsSync(join(installDir, "mybuddy.exe")));
        assert.equal(existsSync(profileDir), false);
        assert.equal(readyMarker, legacy ? "MYBUDDY_DESKTOP_SHELL_READY" : "MYBUDDY_DESKTOP_WORKSPACE_READY");
        if (startupFails) throw new Error("mock startup failure");
      },
    });
    if (startupFails) await assert.rejects(build, /mock startup failure/);
    else await build;

    assert.deepEqual(
      calls.slice(0, 4).map((call) => call.args),
      [
        ["scripts/prepareMyBuddyCore.js"],
        ["scripts/prepareHubResources.js"],
        ["packages/release-tools/src/buildTauriWindows.mjs", "resources", "x64"],
        ["packages/release-tools/src/buildTauriWindows.mjs", "out", "--arch=x64"],
      ],
    );
    assert.equal(calls.length, 7);
    const [, , , , install, startup, uninstall] = calls;
    const installDir = install.args[2].slice(3);
    assert.deepEqual(install.args, ["/S", "/NS", `/D=${installDir}`]);
    assert.equal(install.command, installer);
    assert.deepEqual(install.options, { argv0: `"${installer}"`, windowsVerbatimArguments: true });
    assert.equal(startup.command, "verifyStartup");
    assert.equal(startup.args[0], installDir);
    assert.deepEqual(uninstall.args, ["/S", `_?=${installDir}`]);
    assert.equal(uninstall.command, join(installDir, "uninstall.exe"));
    assert.deepEqual(uninstall.options, { argv0: `"${uninstall.command}"`, windowsVerbatimArguments: true });
    assert.equal(existsSync(installDir), false);
  });
}

test("rejects incomplete Windows Tauri installation payload", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tauri-win-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => verifyInstalledWindowsPayload(dir, "x64"));
});

function startupFixture(timeoutMs) {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  const calls = [];
  const profile = join(tmpdir(), "fresh profile");
  const startup = verifyInstalledWindowsStartup("installed app", profile, {
    env: { TEST_API_KEY: "test-secret-value" },
    timeoutMs,
    spawnApp: (command, args, options) => {
      calls.push("spawn");
      assert.equal(command, join("installed app", "mybuddy.exe"));
      assert.deepEqual(args, []);
      assert.equal(options.cwd, "installed app");
      assert.equal(options.env.MYBUDDY_DESKTOP_PROFILE, profile);
      assert.equal(options.env.MYBUDDY_DESKTOP_SMOKE, "1");
      assert.equal(options.env.WEBVIEW2_USER_DATA_FOLDER, join(profile, "webview"));
      return child;
    },
    stopApp: (process) => {
      calls.push("stop");
      assert.equal(process, child);
    },
  });
  return { child, calls, startup };
}

test("accepts a complete Windows workspace marker split across stderr chunks", async () => {
  const { child, calls, startup } = startupFixture();
  child.stderr.write("MYBUDDY_DESKTOP_SHELL_READY\nMYBUDDY_DESKTOP_WORKSPACE_");
  assert.deepEqual(calls, ["spawn"]);
  child.stderr.write("READY\r\n");
  await startup;
  assert.deepEqual(calls, ["spawn", "stop"]);
});

test("reports Windows startup exit and stderr while redacting build credentials", async () => {
  const { child, calls, startup } = startupFixture();
  child.stderr.write("[desktop-host] Startup failed: cannot initialize Core (test-secret-value)\n");
  child.emit("close", 1, null);
  await assert.rejects(startup, (error) => {
    assert.match(error.message, /exited before startup was ready \(code 1\)/);
    assert.match(error.message, /cannot initialize Core \(\[REDACTED\]\)/);
    assert.doesNotMatch(error.message, /test-secret-value/);
    return true;
  });
  assert.deepEqual(calls, ["spawn", "stop"]);
});

test("cleans up when the Windows WebView finishes loading but the workspace never starts", async () => {
  const { child, calls, startup } = startupFixture(25);
  child.stderr.write("MYBUDDY_DESKTOP_SHELL_READY\n");
  await assert.rejects(startup, /no startup readiness marker \(MYBUDDY_DESKTOP_WORKSPACE_READY\)/);
  assert.deepEqual(calls, ["spawn", "stop"]);
});
