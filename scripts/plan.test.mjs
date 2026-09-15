import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matrices, validatePlan, verifyPlanDigest } from "./plan.mjs";

const id = "bt_0102030405060708090a0b0c";
const core = { repository: "core", tag: "v0.2.2", commit: "a".repeat(40) };
const desktop = { repository: "desktop", tag: "v0.2.2", commit: "b".repeat(40) };
function plan(mode = "bundle", changes = {}) {
  return {
    schemaVersion: 3, taskId: id, mode, channel: "internal", targets: ["darwin-arm64", "windows-x64"],
    ...(mode === "core" ? {} : { uiVersion: "0.2.2", coreVersion: "0.2.2", buildNumber: 1, applicationVersion: "0.2.2-build.1" }),
    sources: mode === "core" ? { core } : mode === "desktop" ? { desktop } : { core, desktop },
    ...(mode === "desktop" ? { coreReleaseId: "c".repeat(32) } : {}),
    ...changes,
  };
}

test("validates Core, Desktop and bundle plans without an external SDK source", () => {
  for (const mode of ["core", "desktop", "bundle"]) {
    const selected = validatePlan(plan(mode), id);
    assert.equal(matrices(selected).desktop.include.length, 2);
    assert.deepEqual(Object.keys(selected.sources).sort(), mode === "core" ? ["core"] : mode === "desktop" ? ["desktop"] : ["core", "desktop"]);
  }
});
test("rejects pre-migration plans, extraneous sources and invalid targets", () => {
  for (const schemaVersion of [1, 2]) assert.throws(() => validatePlan(plan("core", { schemaVersion }), id), /invalid task plan/);
  assert.throws(() => validatePlan(plan("core", { targets: ["android"] }), id), /invalid task targets/);
  assert.throws(() => validatePlan(plan("core", { sources: { core, retired: core } }), id), /invalid task sources/);
  assert.throws(() => validatePlan(plan("core", { sources: { core: { ...core, commit: "main" } } }), id), /invalid source selection/);
});
test("requires Core v0.2.2 or newer for both source and candidate builds", () => {
  for (const tag of ["v0.2.2", "v0.3.0", "v1.0.0"]) assert.doesNotThrow(() => validatePlan(plan("core", { sources: { core: { ...core, tag } } }), id));
  for (const tag of ["v0.1.71", "v0.2.1"]) assert.throws(() => validatePlan(plan("core", { sources: { core: { ...core, tag } } }), id), /unsupported Core version/);
  assert.throws(() => validatePlan(plan("desktop", { coreVersion: "0.2.1" }), id), /unsupported Core version/);
});
test("omits cached Core and completed Desktop targets from retry matrices", () => {
  const selected = validatePlan(plan("bundle", { coreCachedTargets: ["darwin-arm64", "windows-x64"], desktopCachedTargets: ["darwin-arm64"] }), id);
  assert.deepEqual(matrices(selected).core.include, []);
  assert.deepEqual(matrices(selected).desktop.include.map(item => item.target), ["windows-x64"]);
  assert.throws(() => validatePlan(plan("bundle", { coreCachedTargets: ["linux-x64"] }), id), /invalid cached Core targets/);
});
test("uses branded binaries and native Windows ARM64 runners", () => {
  const selected = validatePlan(plan("bundle", { targets: ["darwin-arm64", "windows-x64", "windows-arm64"] }), id);
  const definitions = matrices(selected).core.include;
  assert.equal(definitions[0].binary, "mybuddy-core");
  assert.equal(definitions[1].binary, "mybuddy-core.exe");
  assert.equal(definitions[2].os, "windows-11-arm");
  assert.equal(definitions[2].arch, "arm64");
});
test("validates managed application version and immutable plan digest", () => {
  assert.throws(() => validatePlan(plan("bundle", { applicationVersion: "0.2.2-build.2" }), id), /managed application version/);
  const raw = JSON.stringify(plan());
  const digest = createHash("sha256").update(raw).digest("hex");
  assert.doesNotThrow(() => verifyPlanDigest(raw, digest));
  assert.throws(() => verifyPlanDigest(raw + " ", digest), /task plan digest mismatch/);
});
