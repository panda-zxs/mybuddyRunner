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
const auth = { Authorization: `Bearer ${secret}` };
const artifactURL = (filename, suffix = "") => new URL(`/releases/ci/v1/tasks/${taskId}/artifacts/${component}/${target}/${encodeURIComponent(filename)}${suffix}`, base);

// Runner-direct path: the update server presigns an OSS staging PUT, bytes go
// runner→OSS, then the server verifies the staged object in-region. Falls back
// to the legacy streamed PUT when the server predates the staged endpoints.
async function uploadStaged(file, filename, size, digest) {
  const issue = await fetch(artifactURL(filename, "/staged-upload"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }) });
  if (issue.status === 404 || issue.status === 405) { await issue.body?.cancel(); return false; }
  if (!issue.ok) { await issue.body?.cancel(); throw new Error(`staged upload issue failed for ${filename} (${issue.status})`); }
  const { url } = await issue.json();
  await uploadWithRetry(async () => fetch(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) }, body: createReadStream(file), duplex: "half", redirect: "error" }), filename);
  for (let attempt = 1; ; attempt++) {
    const register = await fetch(artifactURL(filename, "/staged"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }) });
    const status = register.status;
    await register.body?.cancel();
    if (register.ok) return true;
    if (![408, 429, 500, 502, 503, 504].includes(status) || attempt === 4) throw new Error(`staged register failed for ${filename} (${status})`);
    console.log(`Retrying staged register of ${filename}, attempt ${attempt + 1}/4`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}

for (const file of files) {
  const size = statSync(file).size;
  if (size < 1) throw new Error(`empty artifact: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  const filename = basename(file);
  const staged = await uploadStaged(file, filename, size, digest);
  if (!staged) {
    await uploadWithRetry(async () => fetch(artifactURL(filename), { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(size), "X-Content-SHA256": digest }, body: createReadStream(file), duplex: "half", redirect: "error" }), filename);
  }
  console.log(`Uploaded ${filename}${staged ? " (oss-staged)" : ""}`);
}
