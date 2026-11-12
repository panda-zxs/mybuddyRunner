import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, env = process.env, cwd = process.cwd()) {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

export function verifyInstalledWindowsPayload(installDir, arch) {
  const runtimeKey = `win32-${arch}`;
  const managedDir = join(installDir, "bundled-mybuddy-core", runtimeKey, "managed-resources");
  const manifestPath = join(managedDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const nodePath = join(managedDir, manifest.node.root, manifest.node.executable);
  const required = [
    join(installDir, "mybuddy-tauri.exe"),
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

export function buildTauriDesktop(platform, arch, options = {}) {
  if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported Tauri desktop target: ${platform}-${arch}`);
  }
  const cwd = options.cwd || process.cwd();
  const execute = options.execute || ((command, args, env) => run(command, args, env, cwd));
  const baseEnv = {
    ...process.env,
    ...(options.env || {}),
    MYBUDDY_TAURI_RELEASE: "1",
    ...(process.env.WPS365_APP_SECRET?.trim() ? { MYBUDDY_BUNDLE_WPS365_APP_SECRET: "1" } : {}),
  };

  execute(process.execPath, ["scripts/prepareMyBuddyCore.js"], baseEnv);
  execute(process.execPath, ["scripts/prepareMarketResources.js"], baseEnv);
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
  const installDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mybuddy-tauri-install-"));
  try {
    // NSIS /D= must be the last argument and unquoted.
    execute(installerPath, ["/S", `/D=${installDir}`], baseEnv);
    verifyInstalledWindowsPayload(installDir, arch);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [platform, arch] = process.argv.slice(2);
  buildTauriDesktop(platform, arch);
}
