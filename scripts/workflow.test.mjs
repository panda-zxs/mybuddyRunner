import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mainWorkflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
const platformWorkflow = readFileSync(new URL("../.github/workflows/platform.yml", import.meta.url), "utf8");
const workflow = mainWorkflow + "\n" + platformWorkflow;


test("keeps the build secret out of job-wide and business-source environments", () => {
  const beforeJobs = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.doesNotMatch(beforeJobs, /MYBUDDY_BUILD_SECRET/);
  assert.match(workflow, /Fetch and validate immutable task plan[\s\S]*?env:\n\s+MYBUDDY_BUILD_SECRET:/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 5);
});

test("does not accept a dispatch-provided server URL", () => {
  assert.doesNotMatch(workflow, /inputs:\n[\s\S]*update_server_url:/);
  assert.equal((workflow.match(/UPDATE_SERVER_URL: \$\{\{ secrets\.MYBUDDY_UPDATE_SERVER_URL \}\}/g) || []).length, 5);
  assert.match(mainWorkflow, /platforms:\n[\s\S]*?uses: \.\/\.github\/workflows\/platform\.yml\n    secrets: inherit\n    with:/);
});

test("uses the MYBUDDY environment and injects public update trust only into desktop packaging", () => {
  assert.equal((workflow.match(/environment: MYBUDDY/g) || []).length, 5);
  assert.match(workflow, /outputs:\n[\s\S]*?mode:[\s\S]*?channel: \$\{\{ steps\.plan\.outputs\.channel \}\}/);
  const desktopBuild = workflow.slice(workflow.indexOf("      - name: Build Desktop"), workflow.indexOf("      - name: Collect Desktop artifacts"));
  assert.match(desktopBuild, /MYBUDDY_UPDATE_BASE_URL: \$\{\{ matrix\.platform != 'linux' && format\('\{0\}\/releases\/\{1\}', secrets\.MYBUDDY_UPDATE_SERVER_URL, inputs\.channel\) \|\| '' \}\}/);
  assert.match(desktopBuild, /MYBUDDY_UPDATE_PUBLIC_KEYS: \$\{\{ secrets\.MYBUDDY_UPDATE_PUBLIC_KEYS \}\}/);
  assert.equal((workflow.match(/secrets\.MYBUDDY_UPDATE_PUBLIC_KEYS/g) || []).length, 2);
});

test("extracts GitLab ZIP sources with platform-native tools", () => {
  assert.match(workflow, /ditto -x -k core-source\.zip core-source/);
  assert.match(workflow, /ditto -x -k desktop-source\.zip source/);
  assert.match(workflow, /unzip -q core-source\.zip -d core-source/);
  assert.match(workflow, /unzip -q desktop-source\.zip -d source/);
  assert.match(workflow, /Expand-Archive -Path core-source\.zip -DestinationPath core-source-archive/);
  assert.match(workflow, /Expand-Archive -Path desktop-source\.zip -DestinationPath source-archive/);
  assert.match(workflow, /Get-ChildItem -Force \$sourceDir\.FullName \| Move-Item -Destination core-src/);
  assert.match(workflow, /Get-ChildItem -Force \$sourceDir\.FullName \| Move-Item -Destination src/);
  assert.match(workflow, /SOURCE_DIR=\$\(\(Resolve-Path src\)\.Path\)/);
  assert.doesNotMatch(workflow, /tar -xf (?:core|desktop)-source\.zip/);
});

test("builds Core directly without an external agent SDK source", () => {
  assert.match(workflow, /cargo build --locked --release[^\n]*-p mybuddy-core-app/);
  assert.doesNotMatch(workflow, /source aionrs|configure-aionrs|cargo update -p aion-agent/);
});

test("reuses task-bound Core only through Update Server", () => {
  assert.match(workflow, /core_needed: \$\{\{ steps\.plan\.outputs\.core_needed \}\}/);
  assert.match(workflow, /Download task-bound Core from Update Server[\s\S]*scripts\/download\.mjs dependency/);
  assert.doesNotMatch(workflow, /actions\/download-artifact|Preserve Core binary/);
});

test("binds Desktop packaging to the Core tag selected by Update Server", () => {
  assert.match(workflow, /core_tag: \$\{\{ steps\.plan\.outputs\.core_tag \}\}/);
  assert.match(workflow, /Prepare task-bound Core resources[\s\S]*prepare-core-bundle\.mjs/);
  const desktopBuild = workflow.slice(workflow.indexOf("      - name: Build Desktop"), workflow.indexOf("      - name: Collect Desktop artifacts"));
  assert.match(desktopBuild, /MYBUDDY_BACKEND_LOCAL_BUNDLE_DIR: \$\{\{ github\.workspace \}\}\/core-bundle/);
  assert.match(desktopBuild, /MYBUDDY_BACKEND_VERSION: \$\{\{ inputs\.core_tag \}\}/);
});

test("applies the task-managed MyBuddy version and avoids the empty Go cache warning", () => {
  assert.match(workflow, /application_version: \$\{\{ steps\.plan\.outputs\.application_version \}\}/);
  assert.match(workflow, /Apply task-managed MyBuddy version[\s\S]*set-application-version\.mjs "\$SOURCE_DIR" "\$\{\{ inputs\.application_version \}\}"/);
  assert.match(workflow, /actions\/setup-go@v6[\s\S]*?go-version: '1\.24'\n\s+cache: false/);
});

test("preserves host build dependencies and supplements only the target Codex package", () => {
  const installStep = workflow.slice(
    workflow.indexOf("      - name: Install Desktop dependencies"),
    workflow.indexOf("      - name: Apply task-managed MyBuddy version"),
  );
  assert.match(installStep, /bun install --frozen-lockfile\n/);
  assert.match(installStep, /install-target-codex\.mjs" "\$PWD" "\$\{\{ matrix\.platform \}\}" "\$\{\{ matrix\.arch \}\}"/);
  assert.doesNotMatch(installStep, /bun install[^\n]*--os=/);
});

test("disables the unsupported automatic update feed for Linux installers", () => {
  const desktopBuild = workflow.slice(workflow.indexOf("      - name: Build Desktop"), workflow.indexOf("      - name: Collect Desktop artifacts"));
  assert.match(desktopBuild, /matrix\.platform != 'linux'/);
});

test("packages and extracts every Core artifact as ZIP", () => {
  assert.match(workflow, /zip -q -j "\$GITHUB_WORKSPACE\/dist\/mybuddy-core-\$\{\{ matrix\.target \}\}\.zip"/);
  assert.match(workflow, /Compress-Archive[\s\S]*mybuddy-core-\$\{\{ matrix\.target \}\}\.zip/);
  assert.match(workflow, /ditto -x -k core-dependency core-input/);
  assert.match(workflow, /unzip -q core-dependency -d core-input/);
  assert.match(workflow, /Expand-Archive -Path core-dependency -DestinationPath core-input/);
  assert.doesNotMatch(workflow, /mybuddy-core-\$\{\{ matrix\.target \}\}\.tar\.gz|tar -xf core-dependency/);
});


test("uses native stable Windows ARM64 tools and propagates install failure from PowerShell", () => {
  assert.match(workflow, /bun-v1\.4\.2\/bun-windows-aarch64\.zip/);
  assert.match(workflow, /architecture: \$\{\{ runner\.arch == 'ARM64' && 'arm64' \|\| 'x64' \}\}/);
  const install = workflow.slice(workflow.indexOf("      - name: Install Desktop dependencies on Windows"), workflow.indexOf("      - name: Apply task-managed MyBuddy version"));
  assert.match(install, /shell: pwsh/);
  assert.match(install, /MYBUDDY_BUILD_BUN_EXECUTABLE=.*Get-Command bun -CommandType Application/);
  assert.match(install, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
});


test("verifies frozen Core source before completing a parallel platform build", () => {
  assert.match(mainWorkflow, /platforms:\n    needs: prepare/);
  assert.match(mainWorkflow, /if \[ "\$CORE_NEEDED" = true \] && \[ "\$VERIFY" != success \]; then SUCCESS=false; fi/);
  assert.match(platformWorkflow, /needs: core/);
  const verifier = readFileSync(new URL("./verify-core.sh", import.meta.url), "utf8");
  assert.match(verifier, /cargo fmt --all -- --check/);
  assert.match(verifier, /cargo clippy --workspace --locked -- -D warnings/);
  assert.match(verifier, /cargo test --workspace --locked/);
  assert.match(workflow, /needs: \[prepare, verify-core, platforms\]/);
});

test("reuses verification only for an exact source and verification contract", () => {
  const verify = mainWorkflow.slice(mainWorkflow.indexOf("\n  verify-core:"), mainWorkflow.indexOf("\n  platforms:"));
  const restore = verify.slice(verify.indexOf("      - name: Restore successful"), verify.indexOf("      - name: Download frozen"));
  assert.match(restore, /actions\/cache\/restore@v4/);
  assert.match(restore, /runner\.os.*runner\.arch.*steps\.config\.outputs\.toolchain.*needs\.prepare\.outputs\.core_commit.*hashFiles\('scripts\/verify-core\.sh', 'scripts\/core-verification\.json'/);
  assert.doesNotMatch(restore, /restore-keys:|lookup-only:/);
  for (const name of ["Download frozen Core source for verification", "Extract Core verification source", "Cache Core verification dependencies", "Verify Core formatting, lint and workspace tests"]) {
    assert.ok(verify.includes(`- name: ${name}\n        if: steps.verified.outputs.cache-hit != 'true'`));
  }
  const save = verify.slice(verify.indexOf("      - name: Record successful"));
  assert.equal((save.match(/if: success\(\) && steps\.verified\.outputs\.cache-hit != 'true'/g) || []).length, 2);
  assert.match(save, /key: \$\{\{ steps\.verified\.outputs\.cache-primary-key \}\}/);
  assert.doesNotMatch(verify, /continue-on-error:/);
  assert.ok(verify.indexOf("run: bash scripts/verify-core.sh") < verify.indexOf("      - name: Record successful"));
});

test("platform jobs preserve exact package caches and per-platform dependencies", () => {
  assert.match(mainWorkflow, /uses: \.\/\.github\/workflows\/platform.yml/);
  assert.match(platformWorkflow, /if: inputs.core_needed/);
  assert.match(platformWorkflow, /if: always\(\) && !cancelled\(\) && inputs.desktop_needed && \(needs.core.result == 'success' \|\| !inputs.core_needed\)/);
  const core = platformWorkflow.slice(platformWorkflow.indexOf('\n  core:'), platformWorkflow.indexOf('\n  desktop:'));
  assert.ok(core.indexOf('Verify Core Linux GLIBC baseline') < core.indexOf('Save packaged Core files before upload'));
  assert.ok(core.indexOf('Save packaged Core files before upload') < core.indexOf('Upload Core package to Update Server'));
  assert.match(core, /core-package-v1-.*inputs.core_commit.*hashFiles/);
  assert.match(platformWorkflow, /key: desktop-v2-.*inputs.source_commit.*inputs.core_commit.*hashFiles.*steps.update-config.outputs.digest/);
  assert.ok(platformWorkflow.indexOf('Restore packaged Desktop files') < platformWorkflow.indexOf('oven-sh/setup-bun'));
});
