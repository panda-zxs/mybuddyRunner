import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");

test("keeps the build secret out of job-wide and business-source environments", () => {
  const beforeJobs = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.doesNotMatch(beforeJobs, /MYBUDDY_BUILD_SECRET/);
  assert.match(workflow, /Fetch and validate immutable task plan[\s\S]*?env:\n\s+MYBUDDY_BUILD_SECRET:/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 4);
});

test("does not accept a dispatch-provided server URL", () => {
  assert.doesNotMatch(workflow, /inputs:\n[\s\S]*update_server_url:/);
  assert.equal((workflow.match(/UPDATE_SERVER_URL: \$\{\{ secrets\.MYBUDDY_UPDATE_SERVER_URL \}\}/g) || []).length, 4);
});

test("uses the MYBUDDY environment and injects public update trust only into desktop packaging", () => {
  assert.equal((workflow.match(/environment: MYBUDDY/g) || []).length, 4);
  assert.match(workflow, /outputs:\n\s+mode:[\s\S]*?channel: \$\{\{ steps\.plan\.outputs\.channel \}\}/);
  const desktopBuild = workflow.slice(workflow.indexOf("      - name: Build Desktop"), workflow.indexOf("      - name: Collect Desktop artifacts"));
  assert.match(desktopBuild, /MYBUDDY_UPDATE_BASE_URL: \$\{\{ secrets\.MYBUDDY_UPDATE_SERVER_URL \}\}\/releases\/\$\{\{ needs\.prepare\.outputs\.channel \}\}/);
  assert.match(desktopBuild, /MYBUDDY_UPDATE_PUBLIC_KEYS: \$\{\{ secrets\.MYBUDDY_UPDATE_PUBLIC_KEYS \}\}/);
  assert.equal((workflow.match(/secrets\.MYBUDDY_UPDATE_PUBLIC_KEYS/g) || []).length, 1);
});
