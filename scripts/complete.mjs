const base = new URL(process.env.UPDATE_SERVER_URL || "");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
const succeeded = process.argv[2] === "true";
const reason = succeeded ? "" : (process.argv[3] || "GitHub Actions build failed").slice(0, 1000);
const response = await fetch(new URL(`/releases/ci/v1/tasks/${taskId}/complete`, base), { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ succeeded, reason }), redirect: "error" });
if (!response.ok) throw new Error(`task completion callback failed (${response.status})`);
