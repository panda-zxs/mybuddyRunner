import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [target, directory] = process.argv.slice(2);
const base = new URL(process.env.UPDATE_SERVER_URL || "");
const taskId = process.env.TASK_ID || "";
const secret = process.env.MYBUDDY_BUILD_SECRET || "";
if (base.protocol !== "https:" || !/^bt_[a-f0-9]{24}$/.test(taskId) || !/^(darwin|windows|linux)-(arm64|x64)$/.test(target) || !secret || !directory) throw new Error("invalid artifact reuse configuration");
for (const entry of readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = join(directory, entry.name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const response = await fetch(new URL(`/releases/ci/v1/tasks/${taskId}/artifacts/desktop/${target}/${encodeURIComponent(entry.name)}`, base), {
    headers: { Authorization: `Bearer ${secret}`, "If-None-Match": `"${hash.digest("hex")}"` }, redirect: "error",
  });
  if (response.status === 304 || response.status === 404) { await response.body?.cancel(); continue; }
  if (!response.ok || !response.body) throw new Error(`artifact reuse failed (${response.status})`);
  const digest = response.headers.get("x-content-sha256");
  const size = Number(response.headers.get("content-length"));
  if (!/^[a-f0-9]{64}$/.test(digest || "") || !Number.isSafeInteger(size) || size < 1) throw new Error("invalid artifact metadata");
  const temporary = `${file}.partial`;
  try {
    const actual = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { actual.update(chunk); callback(null, chunk); } }), createWriteStream(temporary));
    if (statSync(temporary).size !== size || actual.digest("hex") !== digest) throw new Error(`artifact integrity check failed: ${entry.name}`);
    renameSync(temporary, file);
    console.log(`Reused uploaded ${entry.name}`);
  } finally { rmSync(temporary, { force: true }); }
}
