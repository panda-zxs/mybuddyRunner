import { createHash } from "node:crypto";

const targetDefinitions = {
  "darwin-arm64": { coreOS: "macos-14", desktopOS: "macos-14", rustTarget: "aarch64-apple-darwin", binary: "aioncore", platform: "darwin", arch: "arm64", desktopCommand: "node scripts/build-with-builder.js arm64 --mac --arm64" },
  "darwin-x64": { coreOS: "macos-14", desktopOS: "macos-14", rustTarget: "x86_64-apple-darwin", binary: "aioncore", platform: "darwin", arch: "x64", desktopCommand: "node scripts/build-with-builder.js x64 --mac --x64" },
  "windows-x64": { coreOS: "windows-2022", desktopOS: "windows-2022", rustTarget: "x86_64-pc-windows-msvc", binary: "aioncore.exe", platform: "win32", arch: "x64", rustflags: "-C target-feature=+crt-static", desktopCommand: "node scripts/build-with-builder.js x64 --win --x64" },
  "windows-arm64": { coreOS: "windows-11-arm", desktopOS: "windows-11-arm", rustTarget: "aarch64-pc-windows-msvc", binary: "aioncore.exe", platform: "win32", arch: "arm64", rustflags: "-C target-feature=+crt-static", desktopCommand: "node scripts/build-with-builder.js arm64 --win --arm64" },
  "linux-x64": { coreOS: "ubuntu-22.04", desktopOS: "ubuntu-latest", rustTarget: "x86_64-unknown-linux-gnu", binary: "aioncore", platform: "linux", arch: "x64", desktopCommand: "node scripts/build-with-builder.js x64 --linux --x64" },
  "linux-arm64": { coreOS: "ubuntu-latest", desktopOS: "ubuntu-24.04-arm", rustTarget: "aarch64-unknown-linux-gnu", binary: "aioncore", platform: "linux", arch: "arm64", useCross: true, desktopCommand: "node scripts/build-with-builder.js arm64 --linux --arm64" }
};

export function validatePlan(plan, expectedTaskId) {
  if (!plan || plan.schemaVersion !== 1 || plan.taskId !== expectedTaskId || !["core", "desktop", "bundle"].includes(plan.mode) || !["stable", "beta", "internal"].includes(plan.channel)) throw new Error("invalid task plan");
  if (!Array.isArray(plan.targets) || plan.targets.length < 1 || new Set(plan.targets).size !== plan.targets.length || plan.targets.some((target) => !targetDefinitions[target])) throw new Error("invalid task targets");
  const cached = plan.coreCachedTargets || [];
  if (!Array.isArray(cached) || new Set(cached).size !== cached.length || cached.some((target) => !plan.targets.includes(target)) || plan.mode === "desktop" && cached.length) throw new Error("invalid cached Core targets");
  const sourceNames = Object.keys(plan.sources || {}).sort();
  const expectedSources = plan.mode === "core" ? ["aionrs", "core"] : plan.mode === "desktop" ? ["desktop"] : ["aionrs", "core", "desktop"];
  if (JSON.stringify(sourceNames) !== JSON.stringify(expectedSources)) throw new Error("invalid task sources");
  for (const name of sourceNames) {
    const source = plan.sources[name];
    if (source.repository !== name || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source.tag) || !/^[a-f0-9]{40,64}$/.test(source.commit)) throw new Error("invalid source selection");
  }
  if (plan.mode === "desktop" && !/^[a-f0-9]{32}$/.test(plan.coreReleaseId || "")) throw new Error("desktop task requires a Core candidate");
  if (plan.mode !== "desktop" && plan.coreReleaseId) throw new Error("unexpected Core candidate");
  return plan;
}

export function matrices(plan) {
  const cached = new Set(plan.coreCachedTargets || []);
  const core = plan.targets.filter((target) => !cached.has(target)).map((target) => ({ target, ...targetDefinitions[target], os: targetDefinitions[target].coreOS }));
  const desktop = plan.targets.map((target) => ({ target, ...targetDefinitions[target], os: targetDefinitions[target].desktopOS }));
  return { core: { include: core }, desktop: { include: desktop } };
}

export function verifyPlanDigest(raw, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("missing plan digest");
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== expected) throw new Error("task plan digest mismatch");
}
