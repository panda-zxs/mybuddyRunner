import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [sourceDirectory, applicationVersion] = process.argv.slice(2);
if (!sourceDirectory || !/^\d+\.\d+\.\d+-build\.[1-9]\d*$/.test(applicationVersion || "")) throw new Error("invalid managed application version");
const packagePath = resolve(sourceDirectory, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const uiVersion = applicationVersion.slice(0, applicationVersion.indexOf("-build."));
if (pkg.version !== uiVersion) throw new Error(`source package version ${pkg.version} does not match task UI version ${uiVersion}`);
pkg.version = applicationVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
