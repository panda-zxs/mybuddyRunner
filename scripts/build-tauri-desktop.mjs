import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE_READY_MARKER = "MYBUDDY_DESKTOP_WORKSPACE_READY";
const SHELL_READY_MARKER = "MYBUDDY_DESKTOP_SHELL_READY";

function run(command, args, env, cwd, options) {
  execFileSync(command, args, { cwd, env, stdio: "inherit", ...options });
}

function nsisOptions(executable) {
  // The executable name needs quotes. NSIS reads its final directory argument verbatim.
  return { argv0: `"${executable}"`, windowsVerbatimArguments: true };
}

function stopWindowsProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    execFileSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "pipe",
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    try {
      process.kill(child.pid, 0);
    } catch (probeError) {
      if (probeError.code === "ESRCH") return;
    }
    child.kill();
    throw new Error("Could not stop the installed MyBuddy process tree", { cause: error });
  }
}

export async function verifyInstalledWindowsStartup(installDir, profileDir, {
  env = process.env,
  timeoutMs = 150_000,
  readyMarker = WORKSPACE_READY_MARKER,
  spawnApp = spawn,
  stopApp = stopWindowsProcessTree,
} = {}) {
  const child = spawnApp(join(installDir, "mybuddy.exe"), [], {
    cwd: installDir,
    env: {
      ...env,
      MYBUDDY_DESKTOP_PROFILE: profileDir,
      MYBUDDY_DESKTOP_SMOKE: "1",
      WEBVIEW2_USER_DATA_FOLDER: join(profileDir, "webview"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let timer;
  let failure;
  const markerLine = new RegExp(`^${readyMarker}\\r?\\n`, "m");
  try {
    await new Promise((ready, reject) => {
      timer = setTimeout(() => reject(new Error(`no startup readiness marker (${readyMarker}) after ${timeoutMs} ms`)), timeoutMs);
      child.once("error", reject);
      child.once("close", (code, signal) => reject(new Error(`exited before startup was ready (${signal ?? `code ${code}`})`)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const output = stderr + chunk;
        stderr = output.slice(-12_000);
        if (markerLine.test(output)) ready();
      });
    });
  } catch (error) {
    const secrets = Object.entries(env)
      .filter(([name, value]) => value && /TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY/i.test(name))
      .map(([, value]) => String(value))
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) stderr = stderr.replaceAll(secret, "[REDACTED]");
    const diagnostics = stderr.trim() ? `\nStartup stderr:\n${stderr.trim()}` : "\nNo startup stderr was captured.";
    failure = new Error(`Installed MyBuddy failed to start: ${error.message}${diagnostics}`);
  } finally {
    clearTimeout(timer);
    try {
      stopApp(child);
    } catch (error) {
      if (!failure) throw error;
      failure = new AggregateError([failure, error], "Windows Tauri startup and process cleanup failed");
    } finally {
      child.stderr.destroy();
    }
  }
  if (failure) throw failure;
}

export function verifyInstalledWindowsPayload(installDir, arch) {
  const runtimeKey = `win32-${arch}`;
  const managedDir = join(installDir, "bundled-mybuddy-core", runtimeKey, "managed-resources");
  const manifestPath = join(managedDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const nodePath = join(managedDir, manifest.node.root, manifest.node.executable);
  const required = [
    join(installDir, "mybuddy.exe"),
    join(installDir, "host.mjs"),
    join(installDir, "static", "index.html"),
    join(installDir, "bundled-mybuddy-core", runtimeKey, "mybuddy-core.exe"),
    nodePath,
  ];
  for (const candidate of required) {
    const info = statSync(candidate);
    if (!info.isFile() || info.size < 1) {
      throw new Error(`Missing or empty installed Windows Tauri payload file: ${candidate}`);
    }
  }
}

export async function buildTauriDesktop(platform, arch, options = {}) {
  if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported Tauri desktop target: ${platform}-${arch}`);
  }
  const cwd = options.cwd || process.cwd();
  const execute = options.execute || ((command, args, env, runOptions) => run(command, args, env, cwd, runOptions));
  const baseEnv = {
    ...process.env,
    ...(options.env || {}),
    MYBUDDY_TAURI_RELEASE: "1",
    ...(process.env.WPS365_APP_SECRET?.trim() ? { MYBUDDY_BUNDLE_WPS365_APP_SECRET: "1" } : {}),
  };

  execute(process.execPath, ["scripts/prepareMyBuddyCore.js"], baseEnv);
  execute(process.execPath, ["scripts/prepareHubResources.js"], baseEnv);

  if (platform === "darwin") {
    execute(process.execPath, ["packages/desktop-tauri/macos-release.mjs", "resources", arch], baseEnv);
    execute("bash", ["packages/desktop-tauri/build-macos.sh", "out"], {
      ...baseEnv,
      MYBUDDY_TAURI_MAC_ARCH: arch,
    });
    return;
  }

  execute(process.execPath, ["packages/release-tools/src/buildTauriWindows.mjs", "resources", arch], baseEnv);
  execute(process.execPath, ["packages/release-tools/src/buildTauriWindows.mjs", "out", `--arch=${arch}`], baseEnv);

  if (options.skipWindowsInstallSmoke) return;
  const outDir = join(cwd, "out");
  const installerName = readdirSync(outDir).find(
    (name) => name.startsWith("MyBuddy-") && name.endsWith(`-win-${arch}.exe`),
  );
  if (!installerName) {
    throw new Error(`Expected Tauri Windows installer in ${outDir}`);
  }
  const installerPath = join(outDir, installerName);
  // Managed builds may repackage older frozen Tauri sources that only log page load.
  const shellSource = readFileSync(join(cwd, "packages", "desktop-tauri", "src", "desktop", "shell.rs"), "utf8");
  const readyMarker = shellSource.includes(`"${WORKSPACE_READY_MARKER}"`) ? WORKSPACE_READY_MARKER : SHELL_READY_MARKER;
  const smokeDir = mkdtempSync(join(resolve(baseEnv.RUNNER_TEMP || tmpdir()), "mybuddy-tauri-install-"));
  const installDir = join(smokeDir, "installed app");
  const uninstallerPath = join(installDir, "uninstall.exe");
  const failures = [];
  try {
    execute(installerPath, ["/S", "/NS", `/D=${installDir}`], baseEnv, nsisOptions(installerPath));
    verifyInstalledWindowsPayload(installDir, arch);
    const verifyStartup = options.verifyStartup || verifyInstalledWindowsStartup;
    await verifyStartup(installDir, join(smokeDir, "profile"), { env: baseEnv, readyMarker });
    console.log(`Installed Windows MyBuddy reported ${readyMarker}.`);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (existsSync(uninstallerPath)) {
        execute(uninstallerPath, ["/S", `_?=${installDir}`], baseEnv, nsisOptions(uninstallerPath));
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(smokeDir, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Windows Tauri smoke test or cleanup failed");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [platform, arch] = process.argv.slice(2);
  await buildTauriDesktop(platform, arch);
}
