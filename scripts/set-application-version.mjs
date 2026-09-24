import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [sourceDirectory, applicationVersion] = process.argv.slice(2);
if (!sourceDirectory || !/^\d+\.\d+\.\d+-build\.[1-9]\d*$/.test(applicationVersion || "")) throw new Error("invalid managed application version");
const packagePath = resolve(sourceDirectory, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
// The frozen task plan derives the UI version from the GitLab tag. Source
// package metadata may lag behind that tag until packaging assigns its build number.
pkg.version = applicationVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
