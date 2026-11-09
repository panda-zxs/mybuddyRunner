import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunPackage, installBunFallback, verifyBun } from "./setup-bun-fallback.mjs";

test("selects pinned native packages for every supported runner host", () => {
  for (const [platform, name] of [["darwin", "darwin"], ["win32", "windows"], ["linux", "linux"]]) {
    for (const [arch, suffix] of [["arm64", "aarch64"], ["x64", "x64"]]) {
      assert.equal(bunPackage("1.4.2", platform, arch).name, `@oven/bun-${name}-${suffix}`);
    }
  }
  for (const version of ["latest", "^1.4.2", "1.4.2;exit", undefined]) assert.throws(() => bunPackage(version), /exact release/);
  assert.throws(() => bunPackage("1.4.2", "win32", "ia32"), /Unsupported/);
});

function fixture(t, { platform = "win32", arch = "arm64", version = "1.4.2", metadata = {}, actual = {}, failInstall = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bun fallback test "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tempDirectory = join(root, "tools");
  const githubPath = join(root, "github-path");
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("install")) {
      if (failInstall) throw new Error("npm unavailable");
      const directory = args[args.indexOf("--prefix") + 1];
      const pkg = bunPackage(version, platform, arch);
      const destination = join(directory, "node_modules", ...pkg.name.split("/"));
      mkdirSync(join(destination, "bin"), { recursive: true });
      writeFileSync(join(destination, "package.json"), JSON.stringify({ name: pkg.name, version, os: [platform], cpu: [arch], ...metadata }));
      writeFileSync(join(destination, "bin", platform === "win32" ? "bun.exe" : "bun"), "native binary");
      return "";
    }
    return JSON.stringify({ version, platform, arch, ...actual });
  };
  return { calls, githubPath, tempDirectory, invoke: () => installBunFallback(version, { platform, arch, tempDirectory, githubPath, run }) };
}

test("fallback installs exact official package without scripts and exports verified bun and bunx", (t) => {
  const f = fixture(t);
  const executable = f.invoke();
  const install = f.calls[0];
  assert.equal(install.command, process.execPath);
  assert.match(install.args[0], /node_modules[/\\]npm[/\\]bin[/\\]npm-cli.js$/);
  assert.ok(install.args.includes("@oven/bun-windows-aarch64@1.4.2"));
  for (const arg of ["--ignore-scripts", "--registry=https://registry.npmjs.org", "--fetch-retries=3"]) assert.ok(install.args.includes(arg));
  assert.equal(install.options.shell, undefined);
  assert.equal(install.options.timeout, 240_000);
  assert.equal(readFileSync(f.githubPath, "utf8"), dirname(executable) + "\n");
  assert.equal(readFileSync(join(dirname(executable), "bunx.exe"), "utf8"), "native binary");
});

test("Unix fallback provides bunx and selects the host rather than a cross-compile target", (t) => {
  const f = fixture(t, { platform: "linux", arch: "x64", version: "1.3.5" });
  const executable = f.invoke();
  assert.equal(f.calls[0].command, "npm");
  assert.ok(f.calls[0].args.includes("@oven/bun-linux-x64@1.3.5"));
  assert.ok(existsSync(join(dirname(executable), "bunx")));
});

for (const [name, overrides] of [
  ["npm failure", { failInstall: true }],
  ["package substitution", { metadata: { name: "unexpected" } }],
  ["package version mismatch", { metadata: { version: "1.4.3" } }],
  ["emulated executable", { actual: { arch: "x64" } }],
  ["wrong executable version", { actual: { version: "1.3.5" } }],
]) {
  test(`${name} stops fallback without exporting a broken tool or leaving files`, (t) => {
    const f = fixture(t, overrides);
    assert.throws(f.invoke);
    assert.equal(existsSync(f.githubPath), false);
    assert.deepEqual(readdirSync(f.tempDirectory), []);
  });
}

test("the verification gate also rejects a wrong version from the primary installer", () => {
  assert.throws(() => verifyBun("bun", "1.3.5", { platform: "darwin", arch: "arm64", run: () => JSON.stringify({ version: "1.4.2", platform: "darwin", arch: "arm64" }) }), /identity mismatch/);
});
