import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matrices, validatePlan, verifyPlanDigest } from "./plan.mjs";

const id = "bt_0102030405060708090a0b0c";
const core = { repository: "core", tag: "v0.2.1", commit: "a".repeat(40) };
const aionrs = { repository: "aionrs", tag: "v0.2.11", commit: "c".repeat(40) };
test("validates each build mode and expands supported targets", () => {
  for (const plan of [
    { schemaVersion: 1, taskId: id, mode: "core", channel: "stable", targets: ["darwin-arm64"], sources: { core, aionrs } },
    { schemaVersion: 1, taskId: id, mode: "desktop", channel: "beta", targets: ["windows-x64"], sources: { desktop: { repository: "desktop", tag: "v2.1.60", commit: "b".repeat(40) } }, coreReleaseId: "c".repeat(32) },
    { schemaVersion: 1, taskId: id, mode: "bundle", channel: "internal", targets: ["linux-arm64"], sources: { core, aionrs, desktop: { repository: "desktop", tag: "v2.1.60", commit: "b".repeat(40) } } }
  ]) assert.equal(matrices(validatePlan(plan, id)).core.include.length, 1);
});
test("rejects arbitrary source and target input", () => {
  assert.throws(() => validatePlan({ schemaVersion: 1, taskId: id, mode: "core", channel: "stable", targets: ["android"], sources: { core, aionrs } }, id));
  assert.throws(() => validatePlan({ schemaVersion: 1, taskId: id, mode: "core", channel: "stable", targets: ["darwin-arm64"], sources: { core, desktop: core } }, id));
});
test("omits cached Core targets from the build matrix", () => {
  const plan = validatePlan({ schemaVersion: 1, taskId: id, mode: "bundle", channel: "internal", targets: ["darwin-arm64", "windows-x64"], coreCachedTargets: ["darwin-arm64"], sources: { core, aionrs, desktop: { repository: "desktop", tag: "v2.1.60", commit: "b".repeat(40) } } }, id);
  assert.deepEqual(matrices(plan).core.include.map((item) => item.target), ["windows-x64"]);
});
test("rejects a plan whose response bytes do not match the server digest", () => {
  const raw = `{"schemaVersion":1,"taskId":"${id}"}`;
  const digest = createHash("sha256").update(raw).digest("hex");
  assert.doesNotThrow(() => verifyPlanDigest(raw, digest));
  assert.throws(() => verifyPlanDigest(raw + " ", digest));
});
