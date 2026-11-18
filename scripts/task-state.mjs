import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./request-retry.mjs";

export function assertTaskActive(taskId, status) {
  // Older servers do not advertise this header. Upload conflicts still fail
  // closed, with recovery instructions, until the server is upgraded.
  if (status === null) return;
  // Dispatch acknowledgement can race the first runner GET. Only terminal
  // tasks are rejected here; write endpoints retain their stricter policy.
  if (["pending", "dispatching", "dispatched", "running"].includes(status)) return;
  const state = ["failed", "succeeded", "canceled"].includes(status) ? status : "unknown";
  const recovery = state === "failed"
    ? "retry the failed task in Pilot/Update Server, then dispatch it again"
    : state === "succeeded" || state === "canceled"
      ? "use its registered artifacts or create a new task in Pilot/Update Server"
      : "check the task in Pilot/Update Server before dispatching it again";
  throw new Error(`Task ${taskId} is ${state} and cannot accept uploads; ${recovery}. GitHub Re-run does not reopen an ended build task.`);
}

export async function checkTaskState({ serverURL, taskId, secret }, request = fetch, retryOptions = {}) {
  const base = new URL(serverURL);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !/^bt_[a-f0-9]{24}$/.test(taskId) || !secret) throw new Error("invalid task state configuration");
  const response = await fetchWithRetry(new URL(`/releases/ci/v1/tasks/${taskId}/plan`, base), {
    headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
  }, { ...retryOptions, request, label: "task state check" });
  try {
    if (response.status !== 200) throw new Error(`task state check failed (${response.status})`);
    assertTaskActive(taskId, response.headers.get("x-mybuddy-task-status"));
    const plan = await response.json().catch(() => { throw new Error("invalid task state response"); });
    if (plan?.taskId !== taskId) throw new Error("task state response identity mismatch");
    return response.headers.get("x-mybuddy-task-status");
  } finally { await response.body?.cancel().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const status = await checkTaskState({ serverURL: process.env.UPDATE_SERVER_URL || "", taskId: process.env.TASK_ID || "", secret: process.env.MYBUDDY_BUILD_SECRET || "" });
  console.log(status ? `Task is active (${status})` : "Task endpoint available; this server does not advertise task state, so upload conflicts will provide recovery instructions");
}
