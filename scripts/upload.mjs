import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { uploadWithRetry } from "./upload-retry.mjs";

const [component, target, ...inputs] = process.argv.slice(2);
const base = new URL(process.env.UPDATE_SERVER_URL || "");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
if (base.protocol !== "https:" || !/^bt_[a-f0-9]{24}$/.test(taskId) || !["core", "desktop"].includes(component) || !inputs.length || !secret) throw new Error("invalid upload configuration");
const files = inputs.flatMap((input) => statSync(input).isDirectory() ? readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${input}/${entry.name}`) : [input]);
if (!files.length) throw new Error("no artifacts found");
for (const file of files) {
  const size = statSync(file).size;
  if (size < 1) throw new Error(`empty artifact: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  const filename = basename(file);
  await uploadWithRetry(async () => fetch(new URL(`/releases/ci/v1/tasks/${taskId}/artifacts/${component}/${target}/${encodeURIComponent(filename)}`, base), { method: "PUT", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/octet-stream", "Content-Length": String(size), "X-Content-SHA256": digest }, body: createReadStream(file), duplex: "half", redirect: "error" }), filename);
  console.log(`Uploaded ${filename}`);
}
