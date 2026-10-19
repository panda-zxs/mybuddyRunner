import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithRetry } from "./request-retry.mjs";

// The server authorizes this task and serves only its already registered bytes.
// Checking this before restoring a local cache also avoids re-uploading a ZIP
// rebuilt with different timestamps after a workflow/cache-key change.
export async function hasUploadedCore({ serverURL, taskId, secret, target }, request = fetch, retryOptions = {}) {
  const base = new URL(serverURL);
  if (base.protocol !== "https:" || base.username || base.password || !/^bt_[a-f0-9]{24}$/.test(taskId) ||
      !/^(darwin|windows|linux)-(arm64|x64)$/.test(target) || !secret) throw new Error("invalid Core reuse configuration");
  const url = new URL(`/releases/ci/v1/tasks/${taskId}/artifacts/core/${target}/mybuddy-core-${target}.zip`, base);
  const response = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${secret}` }, redirect: "error",
  }, { ...retryOptions, request, label: `Core reuse check for ${target}` });
  try {
    if (response.status === 404) return false;
    if (response.status !== 200) throw new Error(`Core reuse check failed (${response.status})`);
    const digest = response.headers.get("x-content-sha256");
    const size = Number(response.headers.get("content-length"));
    if (!/^[a-f0-9]{64}$/.test(digest || "") || !Number.isSafeInteger(size) || size < 1) throw new Error("invalid registered Core metadata");
    return true;
  } finally {
    // Desktop downloads this exact artifact through its normal dependency path.
    // No need to transfer or upload it again in the Core job.
    await response.body?.cancel();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const available = await hasUploadedCore({ serverURL: process.env.UPDATE_SERVER_URL || "", taskId: process.env.TASK_ID || "",
    secret: process.env.MYBUDDY_BUILD_SECRET || "", target: process.argv[2] || "" });
  appendFileSync(process.env.GITHUB_OUTPUT, `available=${available}\n`);
  console.log(available ? "Reusing task-bound Core already registered with Update Server; compilation and upload skipped" : "No registered Core for this target; continuing with the package cache or build");
}
