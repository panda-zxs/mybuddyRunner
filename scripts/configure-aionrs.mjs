import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [coreInput, aionrsInput] = process.argv.slice(2);
const coreRoot = realpathSync(resolve(coreInput || ""));
const aionrsRoot = realpathSync(resolve(aionrsInput || ""));
const plan = JSON.parse(readFileSync("task-plan.json", "utf8"));
const source = plan.sources?.aionrs;
if (!source || source.repository !== "aionrs" || source.tag !== "v0.2.11" || !/^[a-f0-9]{40,64}$/.test(source.commit)) throw new Error("invalid frozen aionrs source");

const manifest = readFileSync(join(coreRoot, "Cargo.toml"), "utf8");
const tags = [...manifest.matchAll(/git\s*=\s*"https:\/\/github\.com\/iOfficeAI\/aionrs\.git"\s*,\s*tag\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
if (!tags.length || tags.some((tag) => tag !== source.tag)) throw new Error("Core aionrs dependency does not match the frozen task source");

const crates = ["aion-agent", "aion-compact", "aion-config", "aion-mcp", "aion-memory", "aion-process", "aion-protocol", "aion-providers", "aion-skills", "aion-tools", "aion-types"];
for (const crate of crates) {
  if (!existsSync(join(aionrsRoot, "crates", crate, "Cargo.toml"))) throw new Error(`aionrs source is missing ${crate}`);
}

const configPath = join(coreRoot, ".cargo", "config.toml");
mkdirSync(dirname(configPath), { recursive: true });
const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
if (/\[patch\.['"]https:\/\/github\.com\/iOfficeAI\/aionrs\.git['"]\]/.test(existing)) throw new Error("Core source already defines an aionrs patch");
const lines = [existing.trimEnd(), "", "[patch.'https://github.com/iOfficeAI/aionrs.git']"];
for (const crate of crates) lines.push(`${crate}.path = ${JSON.stringify(join(aionrsRoot, "crates", crate).replaceAll("\\", "/"))}`);
writeFileSync(configPath, lines.join("\n") + "\n", { mode: 0o600 });
