import { execFile, spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const processNames = new Set(["node", "bun", "bash", "codesign", "notarytool", "stapler", "xcrun", "ditto", "7za", "7zz", "app-builder", "hdiutil", "security"]);

// ps comm contains executable names, unlike args/command which can contain
// signing passwords. Only report known build tools belonging to this build.
export function buildProcesses(output, rootPID) {
  const rows = output.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3], cpu: match[4], name: basename(match[5]) }] : [];
  });
  const children = new Set([rootPID]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (children.has(row.ppid) && !children.has(row.pid)) {
      children.add(row.pid);
      changed = true;
    }
  }
  return rows.filter(row => children.has(row.pid) && processNames.has(row.name)).slice(0, 40);
}

export function runBuild(command, args, { timeoutMs = 45 * 60_000, intervalMs = 60_000, killDelayMs = 5_000, report = console.log } = {}) {
  return new Promise(resolveExit => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: "inherit", detached: true });
    let stoppingCode, killTimer, inspecting = false, finished = false;
    const signalGroup = signal => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = code => {
      if (stoppingCode !== undefined || finished) return;
      stoppingCode = code;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), killDelayMs);
    };
    const onInterrupt = () => stop(130), onTerminate = () => stop(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const timer = setTimeout(() => {
      report(`::error::Desktop build exceeded ${Math.round(timeoutMs / 60_000)} minutes; stopping the build process group. Inspect the last codesign/notarytool progress above.`);
      stop(124);
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      if (inspecting || finished || stoppingCode !== undefined) return;
      inspecting = true;
      execFile("ps", ["-axo", "pid=,ppid=,etime=,pcpu=,comm="], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, output) => {
        inspecting = false;
        if (finished) return;
        const elapsed = Math.round((Date.now() - started) / 1000);
        report(`[build progress] elapsed=${elapsed}s; active processes (names only): ${error ? "snapshot unavailable" : JSON.stringify(buildProcesses(output, child.pid))}`);
      });
    }, intervalMs);
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      // Keep escalation armed after cancellation: a grandchild may outlive its
      // parent after SIGTERM. Do not let it keep signing/uploading in background.
      if (stoppingCode === undefined) clearTimeout(killTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      const exit = stoppingCode ?? code;
      report(`[build progress] finished exit=${exit}, elapsed=${Math.round((Date.now() - started) / 1000)}s`);
      resolveExit(exit);
    };
    child.once("error", error => { report(`::error::Cannot start Desktop build (${error.code || "spawn failed"})`); finish(1); });
    child.once("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : 143)));
    report(`[build progress] monitoring Desktop packaging, codesign and Apple notarization; maximum ${Math.round(timeoutMs / 60_000)} minutes.`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("build command is required");
  process.exitCode = await runBuild(command, args);
}
