import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const [binaryName, outputDirectory = "core-bundle"] = process.argv.slice(2);
const coreBinary = process.env.TASK_CORE_BINARY;
if (!coreBinary || !binaryName) {
  throw new Error("TASK_CORE_BINARY and binary-name are required");
}

const root = path.resolve(outputDirectory);
const managedResources = path.join(root, "managed-resources");
const dataDirectory = path.join(root, ".prepare-data");
await rm(root, { recursive: true, force: true });
await mkdir(managedResources, { recursive: true });
await mkdir(dataDirectory, { recursive: true });
const resolvedCoreBinary = path.resolve(coreBinary);
if (process.platform !== "win32") await chmod(resolvedCoreBinary, 0o755);
await copyFile(resolvedCoreBinary, path.join(root, binaryName));
if (process.platform !== "win32") await chmod(path.join(root, binaryName), 0o755);

// npm_config_* values used by electron-builder can make the managed Node/npm
// validation behave as an Electron cross-build. Prepare Core resources in a
// clean process before the Desktop build adds those variables.
const env = { ...process.env, AIONUI_BUNDLED_MANAGED_RESOURCES: "" };
for (const key of Object.keys(env)) {
  if (key.toLowerCase().startsWith("npm_config_")) delete env[key];
}

await new Promise((resolve, reject) => {
  const child = spawn(resolvedCoreBinary, [
    "--data-dir",
    dataDirectory,
    "prepare-managed-resources",
    "--bundle-out",
    managedResources,
  ], { env, stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Core resource preparation failed (${signal || code})`));
  });
});

await rm(dataDirectory, { recursive: true, force: true });
console.log(`Prepared task-bound Core bundle at ${root}`);
