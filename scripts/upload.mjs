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

async function postWithRetry(url, payload, filename, label) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const status = response.status;
    await response.body?.cancel();
    if (response.ok) return;
    if (![408, 429, 500, 502, 503, 504].includes(status) || attempt === 4) throw new Error(`${label} failed for ${filename} (${status})`);
    console.log(`Retrying ${label} of ${filename}, attempt ${attempt + 1}/4`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}

// Multipart first: each part is a bounded PUT that survives flaky cross-border
// links, and a failed part retries alone instead of dooming the whole file.
async function uploadParts(file, filename, size, plan) {
  const etags = new Array(plan.parts.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, plan.parts.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= plan.parts.length) return;
      const part = plan.parts[index];
      const start = (part.number - 1) * plan.partSize;
      const end = Math.min(start + plan.partSize, size);
      await uploadWithRetry(async () => {
        const response = await fetch(part.url, { method: "PUT", headers: { ...part.headers, "Content-Length": String(end - start) }, body: createReadStream(file, { start, end: end - 1 }), duplex: "half", redirect: "error" });
        if (response.ok) etags[index] = { number: part.number, etag: (response.headers.get("etag") || "").replaceAll('"', "") };
        return response;
      }, `${filename} part ${part.number}`);
    }
  });
  await Promise.all(workers);
  return etags;
}

// Runner-direct path: the update server presigns OSS staging PUTs, bytes go
// runner→OSS, then the server verifies the staged object in-region. Falls back
// to the legacy streamed PUT when the server predates the staged endpoints.
async function uploadStaged(file, filename, size, digest) {
  const issueMultipart = await fetch(artifactURL(filename, "/staged-upload-multipart"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }) });
  if (issueMultipart.ok) {
    const plan = await issueMultipart.json();
    const parts = await uploadParts(file, filename, size, plan);
    await postWithRetry(artifactURL(filename, "/staged-multipart"), { size, sha256: digest, uploadId: plan.uploadId, parts }, filename, "staged multipart register");
    return true;
  }
  await issueMultipart.body?.cancel();
  if (issueMultipart.status !== 404 && issueMultipart.status !== 405) throw new Error(`staged multipart issue failed for ${filename} (${issueMultipart.status})`);

  const issue = await fetch(artifactURL(filename, "/staged-upload"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }) });
  if (issue.status === 404 || issue.status === 405) { await issue.body?.cancel(); return false; }
  if (!issue.ok) { await issue.body?.cancel(); throw new Error(`staged upload issue failed for ${filename} (${issue.status})`); }
  const { url, headers = {} } = await issue.json();
  // Signed headers (x-oss-acl etc.) must be replayed verbatim or OSS answers 403.
  await uploadWithRetry(async () => fetch(url, { method: "PUT", headers: { ...headers, "Content-Length": String(size) }, body: createReadStream(file), duplex: "half", redirect: "error" }), filename);
  await postWithRetry(artifactURL(filename, "/staged"), { size, sha256: digest }, filename, "staged register");
  return true;
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
