#!/usr/bin/env node
/**
 * npm run sandbox-run -- <export_dir> [--ro PATH]... [--timeout SECONDS] [--no-scope-limits] -- <command> [args...]
 *
 * Runs a command against a throwaway copy of exported code inside the bubblewrap sandbox (see sandbox.ts).
 * Prints what happened and how much output there was; the output itself (untrusted text) goes to a log file
 * in the export folder, for the user. Exit status: 0 the command succeeded, 1 it failed, timed out or was
 * killed by a limit, 2 the sandbox couldn't start (or bad arguments).
 */
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { readManifest } from "./codeExport.js";
import { PRIVATE_FILE_MODE } from "./config.js";
import { loadExport } from "./exportReview.js";
import { DEFAULT_TIMEOUT_S, runSandboxed, type SandboxResult } from "./sandbox.js";

const USAGE =
  "usage: npm run sandbox-run -- <export_dir> [--ro PATH]... [--timeout SECONDS] [--no-scope-limits] -- <command> [args...]";
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
  console.error(USAGE);
  process.exit(2);
}
const cmd = argv.slice(sep + 1);
const opts = argv.slice(0, sep);
const dir = resolve(opts.shift()!);
const readOnly: string[] = [];
let timeoutS = DEFAULT_TIMEOUT_S;
let noScope = false;
while (opts.length) {
  const flag = opts.shift();
  if (flag === "--no-scope-limits") {
    noScope = true;
    continue;
  }
  const value = opts.shift();
  if (flag === "--ro" && value) readOnly.push(value);
  else if (flag === "--timeout" && value && Number(value) > 0) timeoutS = Number(value);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}

/** "139 (SIGSEGV)": bwrap reports a signal death as 128 + the signal number. */
function describeExit(code: number | null): string {
  if (code === null) return "none";
  const name = Object.entries(constants.signals).find(([, n]) => n === code - 128)?.[0];
  return code > 128 && name ? `${code} (${name})` : String(code);
}

function describe(r: SandboxResult, timeout: number): string {
  switch (r.outcome) {
    case "exited":
      return `exit code ${describeExit(r.code)}`;
    case "timed-out":
      return `timed out after ${timeout}s and was killed`;
    case "killed":
      return `killed by ${r.signal ?? "a signal"}, most likely the sandbox's memory or task limit`;
    case "not-started":
      return "not started";
  }
}

try {
  // Hash-verified contents, read as regular files only; the sandbox is built from these, not from disk again.
  const files = loadExport(dir, readManifest(dir).files);
  const r = await runSandboxed(files, cmd, { readOnly, timeoutS, noScope });
  if (r.outcome === "not-started") {
    // The tools' own error (systemd-run, prlimit or bwrap). The command never ran, so this isn't untrusted text.
    const why = r.output.trim().split("\n")[0] || "no detail";
    console.error(
      `sandbox failed to start, command not run: ${why}` +
        (noScope ? "" : "\n(If this machine has no systemd user session, --no-scope-limits runs without the task and whole-tree memory limits.)"),
    );
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const log = join(dir, `sandbox-${stamp}.log`);
  const header = [
    `command: ${JSON.stringify(cmd)}`,
    `read-only extras: ${JSON.stringify(readOnly)}${noScope ? " (no scope limits)" : ""}`,
    `result: ${describe(r, timeoutS)}`,
    `output${r.truncated ? " (truncated)" : ""}, untrusted:`,
    "-".repeat(70),
  ].join("\n");
  writeFileSync(log, `${header}\n${r.output}`, { mode: PRIVATE_FILE_MODE });
  const lines = r.output ? r.output.split("\n").length : 0;
  process.stdout.write(
    `sandbox: ${describe(r, timeoutS)}; ${lines} line(s) of output${r.truncated ? " (truncated)" : ""}. Log for the user: ${log}\n`,
  );
  process.exit(r.outcome === "exited" && r.code === 0 ? 0 : 1);
} catch (err) {
  console.error(`sandbox-run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
