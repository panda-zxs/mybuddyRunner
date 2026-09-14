import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

export function targetCodexPackage(projectRoot, platform, arch) {
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(arch)) {
    throw new Error(`unsupported Codex target: ${platform}-${arch}`);
  }

  const wrapperPath = join(projectRoot, "node_modules", "@openai", "codex", "package.json");
  if (!existsSync(wrapperPath)) throw new Error("@openai/codex is missing after host dependency install");

  const wrapper = readJson(wrapperPath);
  const packageName = `@openai/codex-${platform}-${arch}`;
  const packageSpec = wrapper.optionalDependencies?.[packageName];
  if (typeof packageSpec !== "string" || !packageSpec.startsWith("npm:@openai/codex@")) {
    throw new Error(`@openai/codex does not declare ${packageName}`);
  }

  return {
    packageName,
    packageSpec: packageSpec.slice("npm:".length),
    expectedVersion: packageSpec.slice("npm:@openai/codex@".length),
    destination: join(projectRoot, "node_modules", "@openai", `codex-${platform}-${arch}`),
  };
}

export function ensureTargetCodexPackage(
  projectRoot,
  platform,
  arch,
  run = execFileSync,
) {
  const target = targetCodexPackage(resolve(projectRoot), platform, arch);
  const installedMetadata = join(target.destination, "package.json");
  if (existsSync(installedMetadata)) {
    const installed = readJson(installedMetadata);
    if (installed.version !== target.expectedVersion) {
      throw new Error(
        `${target.packageName} version mismatch: expected ${target.expectedVersion}, got ${installed.version || "unknown"}`,
      );
    }
    console.log(`${target.packageName}@${target.expectedVersion} is already installed`);
    return target.destination;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "mybuddy-codex-"));
  try {
    const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = run(
      npmExecutable,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory, target.packageSpec],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const packResult = JSON.parse(packed);
    const filename = packResult?.[0]?.filename;
    if (typeof filename !== "string" || basename(filename) !== filename) {
      throw new Error(`npm pack returned an invalid archive for ${target.packageName}`);
    }

    mkdirSync(target.destination, { recursive: true });
    run(
      "tar",
      ["-xzf", join(temporaryDirectory, filename), "-C", target.destination, "--strip-components=1"],
      { stdio: "inherit" },
    );

    const installed = readJson(installedMetadata);
    if (installed.name !== "@openai/codex" || installed.version !== target.expectedVersion) {
      throw new Error(`downloaded ${target.packageName} metadata does not match the lockfile declaration`);
    }
    console.log(`Installed ${target.packageName}@${target.expectedVersion}`);
    return target.destination;
  } catch (error) {
    rmSync(target.destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const [projectRoot, platform, arch] = process.argv.slice(2);
  if (!projectRoot || !platform || !arch) {
    throw new Error("usage: install-target-codex.mjs <project-root> <platform> <arch>");
  }
  ensureTargetCodexPackage(projectRoot, platform, arch);
}
