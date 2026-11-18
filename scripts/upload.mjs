import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { uploadWithRetry } from "./upload-retry.mjs";
import { fetchWithRetry } from "./request-retry.mjs";
import { checkTaskState } from "./task-state.mjs";

const [component, target, ...inputs] = process.argv.slice(2);
const base = new URL(process.env.UPDATE_SERVER_URL || "");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
if (base.protocol !== "https:" || !/^bt_[a-f0-9]{24}$/.test(taskId) || !["core", "desktop"].includes(component) || !inputs.length || !secret) throw new Error("invalid upload configuration");
const files = inputs.flatMap((input) => statSync(input).isDirectory() ? readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${input}/${entry.name}`) : [input]);
if (!files.length) throw new Error("no artifacts found");
const auth = { Authorization: `Bearer ${secret}` };
const artifactURL = (filename, suffix = "") => new URL(`/releases/ci/v1/tasks/${taskId}/artifacts/${component}/${target}/${encodeURIComponent(filename)}${suffix}`, base);

await checkTaskState({ serverURL: base, taskId, secret });

async function hasRegisteredArtifact(filename, size, digest) {
  const response = await fetchWithRetry(artifactURL(filename), { headers: auth, redirect: "error" },
    { label: `registered artifact check for ${filename}` });
  try {
    if (response.status === 404) return false;
    if (response.status !== 200) throw new Error(`registered artifact check failed for ${filename} (${response.status})`);
    const registeredDigest = response.headers.get("x-content-sha256");
    const registeredSize = Number(response.headers.get("content-length"));
    if (!/^[a-f0-9]{64}$/.test(registeredDigest || "") || !Number.isSafeInteger(registeredSize) || registeredSize < 1) throw new Error(`invalid registered artifact metadata for ${filename}`);
    if (registeredDigest !== digest || registeredSize !== size) throw new Error(`registered artifact differs for ${filename}; immutable task artifacts cannot be replaced`);
    return true;
  } finally { await response.body?.cancel().catch(() => {}); }
}

async function uploadFailure(response, filename, label) {
  // Only expose protocol-defined diagnostics, never a proxy/OSS response body
  // which can include credentials or signed URLs.
  const allowed = ["task_not_active", "artifact_conflict", "invalid_request", "not_found", "unavailable", "forbidden", "multipart_issue_failed", "multipart_complete_failed", "staged_object_verify_failed", "artifact_registration_failed"];
  const code = response.headers.get("x-mybuddy-error-code");
  const status = response.headers.get("x-mybuddy-task-status");
  const state = ["pending", "dispatching", "dispatched", "running", "failed", "succeeded", "canceled"].includes(status) ? `; task=${status}` : "";
  const requestId = response.headers.get("x-request-id");
  const correlation = /^[A-Za-z0-9_-]{1,128}$/.test(requestId || "") ? `; request=${requestId}` : "";
  await response.body?.cancel().catch(() => {});
  const recovery = response.status === 409 ? "; check or retry this task in Pilot/Update Server before dispatching it again. GitHub Re-run does not reopen an ended task" : "";
  return new Error(`${label} failed for ${filename} (${response.status}${allowed.includes(code) ? `; ${code}` : ""}${state}${correlation})${recovery}`);
}

async function postWithRetry(url, payload, filename, label) {
  // Registration verifies OSS bytes in-region and may need longer than a small
  // metadata request. Retain the previous five-minute header allowance.
  const response = await fetchWithRetry(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "error" },
    { label: `${label} for ${filename}`, timeoutMs: 300_000 });
  if (!response.ok) {
    if (response.status === 409) {
      await response.body?.cancel().catch(() => {});
      if (await hasRegisteredArtifact(filename, payload.size, payload.sha256)) return;
    }
    throw await uploadFailure(response, filename, label);
  }
  await response.body?.cancel();
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
  const issueMultipart = await fetchWithRetry(artifactURL(filename, "/staged-upload-multipart"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }), redirect: "error" },
    { label: `staged multipart issue for ${filename}` });
  if (issueMultipart.ok) {
    const plan = await issueMultipart.json();
    const parts = await uploadParts(file, filename, size, plan);
    await postWithRetry(artifactURL(filename, "/staged-multipart"), { size, sha256: digest, uploadId: plan.uploadId, parts }, filename, "staged multipart register");
    return true;
  }
  if (issueMultipart.status !== 404 && issueMultipart.status !== 405) throw await uploadFailure(issueMultipart, filename, "staged multipart issue");
  await issueMultipart.body?.cancel();

  const issue = await fetchWithRetry(artifactURL(filename, "/staged-upload"), { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ size, sha256: digest }), redirect: "error" },
    { label: `staged upload issue for ${filename}` });
  if (issue.status === 404 || issue.status === 405) { await issue.body?.cancel(); return false; }
  if (!issue.ok) throw await uploadFailure(issue, filename, "staged upload issue");
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
  if (await hasRegisteredArtifact(filename, size, digest)) {
    console.log(`Reused registered ${filename} (SHA-256 and size match; upload skipped)`);
    continue;
  }
  const staged = await uploadStaged(file, filename, size, digest);
  if (!staged) {
    await uploadWithRetry(async () => fetch(artifactURL(filename), { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(size), "X-Content-SHA256": digest }, body: createReadStream(file), duplex: "half", redirect: "error" }), filename);
  }
  console.log(`Uploaded ${filename}${staged ? " (oss-staged)" : ""}`);
}
