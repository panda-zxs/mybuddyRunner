import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function normalizeCoreVersion(coreTag) {
  const version = String(coreTag || "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("invalid managed Core version");
  }
  return version;
}

export function applyCoreVersion(sourceDirectory, coreTag) {
  if (!sourceDirectory) throw new Error("missing Core source directory");
  const version = normalizeCoreVersion(coreTag);
  const cargoTomlPath = resolve(sourceDirectory, "Cargo.toml");
  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const updatedToml = cargoToml.replace(
    /(\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
  );
  if (updatedToml === cargoToml && !cargoToml.includes(`version = "${version}"`)) {
    throw new Error("failed to update [workspace.package] version in Cargo.toml");
  }
  writeFileSync(cargoTomlPath, updatedToml);

  const cargoLockPath = resolve(sourceDirectory, "Cargo.lock");
  if (existsSync(cargoLockPath)) {
    const cargoLock = readFileSync(cargoLockPath, "utf8");
    const updatedLock = cargoLock.replace(
      /(\[\[package\]\]\r?\nname = "mybuddy-core-[^"]+"\r?\nversion = )"[^"]+"/g,
      `$1"${version}"`,
    );
    writeFileSync(cargoLockPath, updatedLock);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceDirectory, coreTag] = process.argv.slice(2);
  applyCoreVersion(sourceDirectory, coreTag);
}
