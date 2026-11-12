import { createHash } from "node:crypto";

const targetDefinitions = {
  "darwin-arm64": { coreOS: "macos-15", desktopOS: "macos-15", rustTarget: "aarch64-apple-darwin", binary: "mybuddy-core", platform: "darwin", arch: "arm64", desktopCommand: "node scripts/build-with-builder.js arm64 --mac --arm64" },
  "darwin-x64": { coreOS: "macos-15-intel", desktopOS: "macos-15-intel", rustTarget: "x86_64-apple-darwin", binary: "mybuddy-core", platform: "darwin", arch: "x64", desktopCommand: "node scripts/build-with-builder.js x64 --mac --x64" },
  "windows-x64": { coreOS: "windows-2022", desktopOS: "windows-2022", rustTarget: "x86_64-pc-windows-msvc", binary: "mybuddy-core.exe", platform: "win32", arch: "x64", rustflags: "-C target-feature=+crt-static", desktopCommand: "node scripts/build-with-builder.js x64 --win --x64" },
  "windows-arm64": { coreOS: "windows-11-arm", desktopOS: "windows-11-arm", rustTarget: "aarch64-pc-windows-msvc", binary: "mybuddy-core.exe", platform: "win32", arch: "arm64", rustflags: "-C target-feature=+crt-static", desktopCommand: "node scripts/build-with-builder.js arm64 --win --arm64" },
  "linux-x64": { coreOS: "ubuntu-22.04", desktopOS: "ubuntu-latest", rustTarget: "x86_64-unknown-linux-gnu", binary: "mybuddy-core", platform: "linux", arch: "x64", desktopCommand: "node scripts/build-with-builder.js x64 --linux --x64" },
  "linux-arm64": { coreOS: "ubuntu-latest", desktopOS: "ubuntu-24.04-arm", rustTarget: "aarch64-unknown-linux-gnu", binary: "mybuddy-core", platform: "linux", arch: "arm64", useCross: true, desktopCommand: "node scripts/build-with-builder.js arm64 --linux --arm64" }
};

const minimumCoreVersion = [0, 2, 2];
const tauriTargets = new Set(["darwin-arm64", "darwin-x64", "windows-x64", "windows-arm64"]);

export function resolveDesktopBranch(plan) {
  if (plan?.mode === "core") return "";
  const explicit = plan?.desktopBranch;
  const sourceBranch = plan?.sources?.desktop?.branch;
  if (explicit !== undefined && sourceBranch !== undefined && explicit !== sourceBranch) {
    throw new Error("invalid desktop branch");
  }
  const branch = explicit ?? sourceBranch ?? "master";
  if (!["master", "tauri"].includes(branch)) throw new Error("invalid desktop branch");
  return branch;
}

export function resolveDesktopRuntime(plan) {
  if (plan?.mode === "core") return "";
  return resolveDesktopBranch(plan) === "tauri" ? "tauri" : "electron";
}

function coreVersionAtLeastMinimum(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag || "");
  if (!match) return false;
  const selected = match.slice(1).map(Number);
  for (let index = 0; index < 3; index++) {
    if (selected[index] !== minimumCoreVersion[index]) return selected[index] > minimumCoreVersion[index];
  }
  return true;
}

export function validatePlan(plan, expectedTaskId) {
  if (!plan || plan.schemaVersion !== 3 || plan.taskId !== expectedTaskId || !["core", "desktop", "bundle"].includes(plan.mode) || !["stable", "beta", "internal"].includes(plan.channel)) throw new Error("invalid task plan");
  if (!Array.isArray(plan.targets) || plan.targets.length < 1 || new Set(plan.targets).size !== plan.targets.length || plan.targets.some((target) => !targetDefinitions[target])) throw new Error("invalid task targets");
  const cached = plan.coreCachedTargets || [];
  if (!Array.isArray(cached) || new Set(cached).size !== cached.length || cached.some((target) => !plan.targets.includes(target)) || plan.mode === "desktop" && cached.length) throw new Error("invalid cached Core targets");
  const desktopCached = plan.desktopCachedTargets || [];
  if (!Array.isArray(desktopCached) || new Set(desktopCached).size !== desktopCached.length || desktopCached.some((target) => !plan.targets.includes(target)) || plan.mode === "core" && desktopCached.length) throw new Error("invalid cached Desktop targets");
  const sourceNames = Object.keys(plan.sources || {}).sort();
  const expectedSources = plan.mode === "core" ? ["core"] : plan.mode === "desktop" ? ["desktop"] : ["core", "desktop"];
  if (JSON.stringify(sourceNames) !== JSON.stringify(expectedSources)) throw new Error("invalid task sources");
  for (const name of sourceNames) {
    const source = plan.sources[name];
    if (source.repository !== name || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source.tag) || !/^[a-f0-9]{40,64}$/.test(source.commit)) throw new Error("invalid source selection");
  }
  if (plan.sources?.core && !coreVersionAtLeastMinimum(plan.sources.core.tag)) throw new Error("unsupported Core version");
  if (plan.mode === "desktop" && !/^[a-f0-9]{32}$/.test(plan.coreReleaseId || "")) throw new Error("desktop task requires a Core candidate");
  if (plan.mode !== "desktop" && plan.coreReleaseId) throw new Error("unexpected Core candidate");
  if (plan.mode !== "core") {
    const branch = resolveDesktopBranch(plan);
    if (branch === "tauri" && plan.targets.some((target) => !tauriTargets.has(target))) {
      throw new Error("invalid Tauri desktop targets");
    }
    if (!coreVersionAtLeastMinimum(plan.coreVersion)) throw new Error("unsupported Core version");
    if (!/^\d+\.\d+\.\d+$/.test(plan.uiVersion || "") || !/^\d+\.\d+\.\d+$/.test(plan.coreVersion || "") || !Number.isSafeInteger(plan.buildNumber) || plan.buildNumber < 1 || plan.applicationVersion !== `${plan.uiVersion}-build.${plan.buildNumber}`) throw new Error("invalid managed application version");
  } else if (plan.desktopBranch) {
    throw new Error("unexpected desktop branch");
  }
  return plan;
}

export function matrices(plan) {
  const cached = new Set(plan.coreCachedTargets || []);
  const desktopCached = new Set(plan.desktopCachedTargets || []);
  const desktopBranch = resolveDesktopBranch(plan);
  const desktopRuntime = resolveDesktopRuntime(plan);
  const core = plan.targets.filter((target) => !cached.has(target)).map((target) => ({ target, ...targetDefinitions[target], os: targetDefinitions[target].coreOS }));
  const desktop = plan.targets.filter((target) => !desktopCached.has(target)).map((target) => ({ target, ...targetDefinitions[target], os: targetDefinitions[target].desktopOS }));
  const platforms = plan.targets.map((target) => ({
    target, ...targetDefinitions[target],
    core_needed: plan.mode !== "desktop" && !cached.has(target),
    desktop_needed: plan.mode !== "core" && !desktopCached.has(target),
  })).filter((item) => item.core_needed || item.desktop_needed);
  return {
    core: { include: core }, desktop: { include: desktop }, platforms: { include: platforms },
    coreNeeded: platforms.some(item => item.core_needed),
    desktopNeeded: platforms.some(item => item.desktop_needed),
    desktopBranch,
    desktopRuntime,
  };
}

export function verifyPlanDigest(raw, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("missing plan digest");
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== expected) throw new Error("task plan digest mismatch");
}
