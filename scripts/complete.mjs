import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

export const COMPLETION_TIMEOUT_MS = 60 * 60 * 1000;

// Release registration streams and verifies multi-platform installers before
// responding. Native HTTPS avoids fetch's independent five-minute header limit.
export function completeTask({ base, taskId, secret, succeeded, reason = "", timeoutMs = COMPLETION_TIMEOUT_MS, request = httpsRequest }) {
  const url = new URL(`/releases/ci/v1/tasks/${taskId}/complete`, base);
  if (url.protocol !== "https:" || !/^bt_[a-f0-9]{24}$/.test(taskId) || !secret || typeof succeeded !== "boolean") throw new Error("invalid completion configuration");
  const body = JSON.stringify({ succeeded, reason: succeeded ? "" : reason.slice(0, 1000) });
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const req = request(url, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      res.on("error", () => finish(new Error("task completion response interrupted")));
      res.on("end", () => finish(res.statusCode >= 200 && res.statusCode < 300 ? null : new Error(`task completion callback failed (${res.statusCode})`)));
      res.resume();
    });
    req.on("error", () => finish(new Error("task completion connection failed")));
    timer = setTimeout(() => {
      finish(new Error("task completion callback timed out"));
      req.destroy();
    }, timeoutMs);
    req.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await completeTask({
    base: process.env.UPDATE_SERVER_URL || "",
    taskId: process.env.TASK_ID || "",
    secret: process.env.MYBUDDY_BUILD_SECRET || "",
    succeeded: process.argv[2] === "true",
    reason: process.argv[3] || "GitHub Actions build failed",
  });
  console.log("Update Server confirmed task completion");
}
