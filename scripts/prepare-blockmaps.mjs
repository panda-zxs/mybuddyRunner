import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [sourceDirectory, artifactDirectory] = process.argv.slice(2);
if (!sourceDirectory || !artifactDirectory) throw new Error("usage: prepare-blockmaps.mjs <source> <artifacts>");
const targets = readdirSync(artifactDirectory).filter(
  (filename) =>
    (filename.endsWith(".AppImage") || /-win-(?:x64|arm64)\.zip$/.test(filename)) &&
    !existsSync(resolve(artifactDirectory, `${filename}.blockmap`))
);
if (targets.length) {
  const projectRequire = createRequire(resolve(sourceDirectory, "package.json"));
  const builderRequire = createRequire(projectRequire.resolve("electron-builder"));
  const { createBlockmap } = builderRequire("app-builder-lib/out/targets/differentialUpdateInfoBuilder.js");
  for (const filename of targets) {
    const file = resolve(artifactDirectory, filename);
    await createBlockmap(file, undefined, { info: { emitArtifactBuildCompleted: async () => {} } });
  }
}
