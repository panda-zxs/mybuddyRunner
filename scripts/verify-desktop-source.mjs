import { lstatSync } from "node:fs";
import { join } from "node:path";

const { DESKTOP_RUNTIME: runtime, SOURCE_DIR: sourceDir } = process.env;
const markers = new Map([
  ["electron", "packages/desktop/electron-builder.yml"],
  ["tauri", "packages/desktop-tauri/tauri.conf.json"],
]);
const marker = markers.get(runtime);
if (!marker || !sourceDir) throw new Error("Desktop runtime or source directory missing");
if (!lstatSync(join(sourceDir, marker), { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Frozen Desktop source does not match ${runtime}: missing ${marker}`);
}
