import { appendFileSync, writeFileSync } from "node:fs";
import { matrices, validatePlan, verifyPlanDigest } from "./plan.mjs";

const base = new URL(process.env.UPDATE_SERVER_URL || "");
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("UPDATE_SERVER_URL must be an HTTPS origin");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
if (!/^bt_[a-f0-9]{24}$/.test(taskId) || !secret) throw new Error("task id or build secret missing");
const response = await fetch(new URL(`/releases/ci/v1/tasks/${taskId}/plan`, base), { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, redirect: "error" });
if (!response.ok) throw new Error(`plan request failed (${response.status})`);
const rawPlan = (await response.text()).trimEnd();
verifyPlanDigest(rawPlan, response.headers.get("x-mybuddy-plan-sha256"));
const plan = validatePlan(JSON.parse(rawPlan), taskId);
const result = matrices(plan);
writeFileSync("task-plan.json", JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
appendFileSync(process.env.GITHUB_OUTPUT, `source_commit=${plan.sources.desktop?.commit || ""}\ncore_commit=${plan.sources.core?.commit || plan.coreReleaseId || ""}\nmode=${plan.mode}\nchannel=${plan.channel}\ncore_tag=${plan.sources.core?.tag || `v${plan.coreVersion}`}\napplication_version=${plan.applicationVersion || ""}\ncore_needed=${result.core.include.length > 0}\ndesktop_needed=${result.desktop.include.length > 0}\ncore_matrix=${JSON.stringify(result.core)}\ndesktop_matrix=${JSON.stringify(result.desktop)}\n`);
