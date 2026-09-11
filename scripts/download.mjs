import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const [kind, name, output] = process.argv.slice(2);
const base = new URL(process.env.UPDATE_SERVER_URL || "");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
if (base.protocol !== "https:" || !/^bt_[a-f0-9]{24}$/.test(taskId) || !secret || !output) throw new Error("invalid download configuration");
let path;
if (kind === "source" && ["core", "desktop"].includes(name)) path = `/releases/ci/v1/tasks/${taskId}/sources/${name}/archive.zip`;
else if (kind === "dependency" && /^[a-z]+-(?:arm64|x64)$/.test(name)) path = `/releases/ci/v1/tasks/${taskId}/dependencies/core/${name}`;
else throw new Error("invalid download request");
const response = await fetch(new URL(path, base), { headers: { Authorization: `Bearer ${secret}` }, redirect: "error" });
if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(output, { mode: 0o600 }));
