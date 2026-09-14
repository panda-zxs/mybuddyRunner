import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetCodexPackage } from "./install-target-codex.mjs";

test("resolves the aliased target package and exact native version", () => {
  const root = mkdtempSync(join(tmpdir(), "target-codex-test-"));
  try {
    const wrapper = join(root, "node_modules", "@openai", "codex");
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(
      join(wrapper, "package.json"),
      JSON.stringify({
        optionalDependencies: {
          "@openai/codex-darwin-x64": "npm:@openai/codex@0.148.0-darwin-x64",
        },
      }),
    );

    assert.deepEqual(targetCodexPackage(root, "darwin", "x64"), {
      packageName: "@openai/codex-darwin-x64",
      packageSpec: "@openai/codex@0.148.0-darwin-x64",
      expectedVersion: "0.148.0-darwin-x64",
      destination: join(root, "node_modules", "@openai", "codex-darwin-x64"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects targets that are not part of the managed platform matrix", () => {
  assert.throws(() => targetCodexPackage(".", "freebsd", "x64"), /unsupported Codex target/);
});
