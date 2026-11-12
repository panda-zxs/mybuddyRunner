import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function applyApplicationVersion(sourceDirectory, applicationVersion) {
  if (!sourceDirectory || !/^\d+\.\d+\.\d+-build\.[1-9]\d*$/.test(applicationVersion || "")) {
    throw new Error("invalid managed application version");
  }
  const packagePath = resolve(sourceDirectory, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  // The frozen task plan derives the UI version from the GitLab tag. Source
  // package metadata may lag behind that tag until packaging assigns its build number.
  pkg.version = applicationVersion;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const tauriConfPath = resolve(sourceDirectory, "packages/desktop-tauri/tauri.conf.json");
  if (existsSync(tauriConfPath)) {
    const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
    tauriConf.version = applicationVersion;
    writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
  }

  const tauriCargoTomlPath = resolve(sourceDirectory, "packages/desktop-tauri/Cargo.toml");
  if (existsSync(tauriCargoTomlPath)) {
    const cargoToml = readFileSync(tauriCargoTomlPath, "utf8");
    const updatedToml = cargoToml.replace(
      /(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
      `$1"${applicationVersion}"`,
    );
    writeFileSync(tauriCargoTomlPath, updatedToml);
  }

  const tauriCargoLockPath = resolve(sourceDirectory, "packages/desktop-tauri/Cargo.lock");
  if (existsSync(tauriCargoLockPath)) {
    const cargoLock = readFileSync(tauriCargoLockPath, "utf8");
    const updatedLock = cargoLock.replace(
      /(\[\[package\]\]\r?\nname = "(?:mybuddy|mybuddy-tauri)"\r?\nversion = )"[^"]+"/g,
      `$1"${applicationVersion}"`,
    );
    writeFileSync(tauriCargoLockPath, updatedLock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceDirectory, applicationVersion] = process.argv.slice(2);
  applyApplicationVersion(sourceDirectory, applicationVersion);
}
