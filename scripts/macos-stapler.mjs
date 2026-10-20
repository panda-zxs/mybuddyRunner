import { spawnSync } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const SUMMARY_RESERVE_BYTES = 4 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 45_000, 60_000];

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function redact(output, env) {
  let safe = text(output);
  const secrets = Object.entries(env)
    .filter(([name, value]) => /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTHORIZATION|API_KEY/i.test(name) && typeof value === "string" && value)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|access_token|api_key|password|secret)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:password|access[_-]?token|api[_-]?key|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, "$1[REDACTED]");
}

function truncate(output, bytes) {
  if (Buffer.byteLength(output) <= bytes) return output;
  // Keep the JSON valid and the byte limit conservative even for multibyte text.
  return Buffer.from(output).subarray(0, Math.max(0, bytes - 32)).toString("utf8").replace(/\uFFFD$/, "") + "\n[output truncated]";
}

function nativeExecute(command, args, options) {
  const result = spawnSync(command, args, options);
  return {
    code: Number.isInteger(result.status) ? result.status : result.error?.code === "ETIMEDOUT" ? 124 : 1,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.error?.code === "ETIMEDOUT",
    errorCode: result.error?.code,
    signal: result.signal,
  };
}

function appendBounded(path, line, options) {
  let size = 0;
  try { size = statSync(path).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) return false;
  appendFileSync(path, line, options);
  return true;
}

function failureReason(result) {
  const output = `${text(result.stdout)}\n${text(result.stderr)}`;
  // EX_DATAERR / 65 alone also covers corrupt or mismatched tickets. Never
  // interpret it as a transient error, and let explicit integrity failures win
  // over any accompanying networking text.
  if (/could not validate (?:the )?ticket|does not have a ticket stapled|ticket[^\n]*(?:invalid|revoked)|(?:invalid|bad|mismatch(?:ed)?)[^\n]*(?:signature|cdhash)|(?:signature|cdhash)[^\n]*(?:invalid|mismatch)|certificate[^\n]*(?:invalid|revoked|expired)|trust (?:evaluation|validation)[^\n]*fail|permission denied|operation not permitted|no such file|(?:file|path)[^\n]*(?:not found|does not exist)|unsupported file/i.test(output)) return { reason: "permanent" };
  if (result.timedOut) return { reason: "timeout" };
  const networkCode = output.match(/NSURLErrorDomain[^\n]*Code\s*=\s*(-(?:1001|1003|1004|1005|1006|1009))\b/i)?.[1];
  if (networkCode || /(?:request|connection|operation) timed out|network connection (?:was )?lost|could not connect to (?:the )?server|cannot connect to (?:the )?server|connection (?:reset|refused)|network is unreachable|(?:cloudkit|server|service)[^\n]*(?:temporarily unavailable|unavailable \(503\))/i.test(output)) {
    return { reason: "network", ...(networkCode ? { networkCode: Number(networkCode) } : {}) };
  }
  if (/record not found|no record found|recordnotfound/i.test(output)) return { reason: "ticket_missing" };
  return { reason: "unknown" };
}

function validArguments(action, args) {
  if (!["staple", "validate"].includes(action) || !Array.isArray(args) || !args.every(arg => typeof arg === "string" && !arg.includes("\0"))) return false;
  const options = args.filter(arg => arg.startsWith("-"));
  const paths = args.filter(arg => !arg.startsWith("-"));
  return options.length <= 1 && options.every(arg => ["-q", "-v"].includes(arg)) && paths.length === 1 && paths[0].length > 0;
}

/**
 * A CI-only wrapper for stapler. It neither submits for notarization nor
 * overrides native validation; the desktop hooks retain their validation and
 * Gatekeeper checks. The log survives hooks that capture and discard stderr.
 */
export async function runStapler(action, args, {
  execute = nativeExecute,
  sleep = delay,
  now = Date.now,
  env = process.env,
  append = appendBounded,
  stdout = value => process.stdout.write(value),
  stderr = value => process.stderr.write(value),
  budgetMs = action === "staple" ? 240_000 : 90_000,
  attemptTimeoutMs = action === "staple" ? 45_000 : 60_000,
  maxAttempts = action === "staple" ? 6 : 3,
} = {}) {
  if (!validArguments(action, args)) {
    stderr("[stapler] Expected staple|validate [ -v|-q ] <artifact path>; unsupported arguments.\n");
    return 64;
  }
  // Leave room below the existing desktop hooks' 300s / 120s parent timeouts.
  const budget = Math.max(1, Math.min(Number(budgetMs) || 1, action === "staple" ? 240_000 : 90_000));
  const timeout = Math.max(1, Math.min(Number(attemptTimeoutMs) || 1, action === "staple" ? 45_000 : 60_000));
  const attempts = Math.max(1, Math.min(Math.floor(Number(maxAttempts) || 1), action === "staple" ? 6 : 3));
  const started = now();
  let loggedBytes = 0, diagnosticUnavailable = false, lastCode = 1;
  const log = entry => {
    if (!env.MYBUDDY_STAPLER_LOG || diagnosticUnavailable) return;
    // Keep space for subsequent attempt/final summaries even if an attempt
    // returns a large verbose response. Do not log command arguments or env.
    const safe = { action, elapsedMs: Math.max(0, now() - started), ...entry };
    if (safe.stdout) safe.stdout = truncate(redact(safe.stdout, env), 6_000);
    if (safe.stderr) safe.stderr = truncate(redact(safe.stderr, env), 6_000);
    let line = JSON.stringify(safe) + "\n";
    if (loggedBytes + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES - SUMMARY_RESERVE_BYTES && (safe.stdout || safe.stderr)) {
      delete safe.stdout;
      delete safe.stderr;
      safe.outputOmitted = true;
      line = JSON.stringify(safe) + "\n";
    }
    if (loggedBytes + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) return;
    try {
      if (append(env.MYBUDDY_STAPLER_LOG, line, { encoding: "utf8", mode: 0o600 }) === false) {
        diagnosticUnavailable = true;
        stderr("[stapler] Diagnostic file reached its size limit; native result still determines success.\n");
        return;
      }
      loggedBytes += Buffer.byteLength(line);
    } catch {
      diagnosticUnavailable = true;
      stderr("[stapler] Could not write the diagnostic file; native result still determines success.\n");
    }
  };
  log({ event: "start", budgetMs: budget, maxAttempts: attempts });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = budget - (now() - started);
    if (remaining <= 0) {
      log({ event: "finished", reason: "budget_exhausted", exitCode: lastCode });
      return lastCode;
    }
    let result;
    try {
      result = await execute("/usr/bin/xcrun", ["stapler", action, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: Math.max(1, Math.floor(Math.min(timeout, remaining))),
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        env,
      });
    } catch (error) {
      result = {
        code: Number.isInteger(error.status) ? error.status : error.code === "ETIMEDOUT" ? 124 : 1,
        stdout: error.stdout,
        stderr: error.stderr,
        timedOut: error.code === "ETIMEDOUT",
        errorCode: typeof error.code === "string" ? error.code : undefined,
      };
    }
    // A timeout, signal, malformed executor response, or launch failure must
    // never masquerade as successful stapling.
    const code = Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255 ? result.code : 1;
    lastCode = result?.timedOut ? 124 : code === 0 && (result?.signal || result?.errorCode) ? 1 : code;
    const safeStdout = truncate(redact(result?.stdout, env), MAX_OUTPUT_BYTES);
    const safeStderr = truncate(redact(result?.stderr, env), MAX_OUTPUT_BYTES);
    if (safeStdout) stdout(safeStdout);
    if (safeStderr) stderr(safeStderr);
    const failure = lastCode === 0 ? { reason: "native_success" } : failureReason(result || {});
    const transient = lastCode !== 0 && (
      ["network", "timeout"].includes(failure.reason)
      || action === "staple" && failure.reason === "ticket_missing"
    );
    // A missing record can also mean a CDHash mismatch, so only networking
    // failures get the longer retry window.
    const attemptLimit = failure.reason === "ticket_missing" ? Math.min(attempts, 3) : attempts;
    if (lastCode !== 0) {
      stderr(`[stapler] ${action} attempt ${attempt}/${attempts} failed: exit=${lastCode} reason=${failure.reason}${failure.networkCode ? ` networkCode=${failure.networkCode}` : ""}\n`);
    }
    log({
      event: "attempt", attempt, exitCode: lastCode, timedOut: Boolean(result?.timedOut), transient,
      ...failure,
      ...(result?.errorCode ? { errorCode: redact(text(result.errorCode).slice(0, 128), env) } : {}),
      stdout: safeStdout, stderr: safeStderr,
    });
    if (lastCode === 0 || !transient || attempt >= attemptLimit) {
      log({ event: "finished", reason: lastCode === 0 ? "native_success" : transient ? "retries_exhausted" : "native_failure", exitCode: lastCode });
      return lastCode;
    }
    const backoff = RETRY_DELAYS_MS[attempt - 1];
    if (now() - started + backoff >= budget) {
      log({ event: "finished", reason: "budget_exhausted", exitCode: lastCode });
      return lastCode;
    }
    stderr(`[stapler] ${action} attempt ${attempt} failed temporarily; retrying in ${backoff / 1000}s.\n`);
    log({ event: "retry", attempt, delayMs: backoff });
    await sleep(backoff);
  }
  return lastCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  process.exitCode = await runStapler(action, args);
}
