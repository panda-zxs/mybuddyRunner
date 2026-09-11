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

test("extracts GitLab ZIP sources with platform-native tools", () => {
  assert.match(workflow, /unzip -q core-source\.zip -d core-source/);
  assert.match(workflow, /unzip -q aionrs-source\.zip -d aionrs-source/);
  assert.match(workflow, /unzip -q desktop-source\.zip -d source/);
  assert.match(workflow, /Expand-Archive -Path core-source\.zip -DestinationPath core-source/);
  assert.match(workflow, /Expand-Archive -Path aionrs-source\.zip -DestinationPath aionrs-source/);
  assert.match(workflow, /Expand-Archive -Path desktop-source\.zip -DestinationPath source/);
  assert.doesNotMatch(workflow, /tar -xf (?:core|desktop)-source\.zip/);
});

test("downloads frozen mybuddyRS and patches Cargo to the local source", () => {
  assert.match(workflow, /Download frozen mybuddyRS source[\s\S]*scripts\/download\.mjs source aionrs/);
  assert.match(workflow, /node scripts\/configure-aionrs\.mjs "\$SOURCE_DIR" "\$AIONRS_DIR"/);
  assert.doesNotMatch(workflow, /git clone[\s\S]*aionrs/);
});

test("reuses task-bound Core only through Update Server", () => {
  assert.match(workflow, /core_needed: \$\{\{ steps\.plan\.outputs\.core_needed \}\}/);
  assert.match(workflow, /Download task-bound Core from Update Server[\s\S]*scripts\/download\.mjs dependency/);
  assert.doesNotMatch(workflow, /actions\/download-artifact|Preserve Core binary/);
});
