import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Running exported code (its tests, or the code itself) under bubblewrap (npm run sandbox-run).
 *
 * Running untrusted code is code execution, not just reading, so it gets its own controls:
 *  - no network (all namespaces unshared), and a fresh session so it can't push input into the terminal;
 *  - an empty environment apart from PATH, HOME=/work and LANG: no tokens, no SSH agent;
 *  - the system read-only (/usr, /etc), no home folder, a private /tmp;
 *  - a throwaway workspace written from the hash-verified export contents, so the export stays as reviewed;
 *  - limits on the whole process tree from a systemd user scope (task count, memory, no swap), limits on
 *    each process from prlimit (address space, file size, open files, no core dumps), and a time limit;
 *  - output goes to a log file for the user; the caller gets the exit code and a line count.
 * Whether the command ran, and its exit code, come from bwrap's --json-status-fd, never bwrap's own exit
 * status, so a sandbox that failed to set up is never mistaken for the command failing.
 */

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_LOG_BYTES = 1024 * 1024;

export interface Limits {
  /** Per process (RLIMIT_AS), and for the whole tree (the scope's MemoryMax, with swap off). */
  memoryBytes: number;
  /** Largest file any process may write (RLIMIT_FSIZE). */
  fileBytes: number;
  /** Open files per process (RLIMIT_NOFILE). */
  openFiles: number;
  /** Processes and threads in the whole tree (the scope's TasksMax): stops fork bombs. */
  tasks: number;
}

export const LIMITS: Limits = { memoryBytes: 4 * 1024 ** 3, fileBytes: 256 * 1024 ** 2, openFiles: 1024, tasks: 256 };

/**
 * systemd-run --user --scope puts the whole tree in its own cgroup and then execs the next program, so the
 * pid, stdio and the status pipe carry straight through. MemorySwapMax=0 matters: without it, going over
 * MemoryMax just swaps. When a limit stops the tree, systemd ends the scope (bwrap is killed from outside).
 * RLIMIT_NPROC isn't used for the task limit because it counts all of the user's processes.
 */
export function scopeArgs(limits: Limits): string[] {
  return [
    "--user", "--scope", "--quiet", "--collect",
    "-p", `TasksMax=${limits.tasks}`, "-p", `MemoryMax=${limits.memoryBytes}`, "-p", "MemorySwapMax=0", "--",
  ];
}

/** The prlimit arguments put in front of bwrap. */
export function limitArgs(limits: Limits): string[] {
  return [`--as=${limits.memoryBytes}`, `--fsize=${limits.fileBytes}`, `--nofile=${limits.openFiles}`, "--core=0", "--"];
}

/** bwrap writes its status as JSON documents to this fd. */
const STATUS_FD = 3;

/** bwrap arguments for running `cmd` in `workspace`, with extra read-only paths (e.g. a Node install). */
export function sandboxArgs(workspace: string, readOnly: string[], cmd: string[]): string[] {
  const path = ["/usr/local/bin", "/usr/bin", "/bin"];
  const binds: string[] = [];
  for (const p of readOnly) {
    if (!isAbsolute(p)) throw new Error(`--ro paths must be absolute: ${p}`);
    binds.push("--ro-bind", p, p);
    // A read-only tool folder is usually one you'll want on PATH (e.g. ~/.nvm/.../bin).
    if (p.endsWith("/bin")) path.unshift(p);
  }
  return [
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--json-status-fd", String(STATUS_FD),
    "--setenv", "PATH", path.join(":"), "--setenv", "HOME", "/work", "--setenv", "LANG", "C.UTF-8",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, "/work", "--chdir", "/work",
    ...binds,
    "--", ...cmd,
  ];
}

export interface BwrapStatus {
  /** bwrap created the sandbox ({"child-pid": n}). Written before mounts are set up, so not proof the command ran. */
  created: boolean;
  /** The command's exit code ({"exit-code": n}); written only if the command actually ran and exited. */
  exitCode: number | null;
}

/** Parse bwrap's status documents. The sandboxed code can't write to this fd. */
export function parseStatus(raw: string): BwrapStatus {
  const out: BwrapStatus = { created: false, exitCode: null };
  for (const doc of raw.match(/\{[^{}]*\}/g) ?? []) {
    try {
      const s = JSON.parse(doc) as Record<string, unknown>;
      if (typeof s["child-pid"] === "number") out.created = true;
      if (typeof s["exit-code"] === "number") out.exitCode = s["exit-code"];
    } catch {
      // ignore anything that isn't a status document
    }
  }
  return out;
}

export type Outcome =
  /** The command ran and exited (a signal death shows as 128 + signal, from bwrap). */
  | "exited"
  /** We killed it at the time limit. */
  | "timed-out"
  /** Something outside killed it after the sandbox was created: in practice the scope's memory or task limit. */
  | "killed"
  /** The sandbox didn't set up, or the command couldn't be exec'd. `output` holds the tools' own error. */
  | "not-started";

export interface SandboxResult {
  outcome: Outcome;
  /** The command's exit code, when outcome is "exited". */
  code: number | null;
  /** The signal that ended bwrap itself, if any (not the command's). */
  signal: string | null;
  output: string;
  truncated: boolean;
}

/** Decide what happened from bwrap's status and how the launcher process ended. */
export function classify(status: BwrapStatus, timedOut: boolean, signal: string | null): Outcome {
  if (status.exitCode !== null) return "exited";
  if (timedOut) return "timed-out";
  if (status.created && signal) return "killed";
  return "not-started";
}

/** Variables systemd-run needs to reach the user's service manager. Nothing else reaches the launcher. */
function launcherEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export interface SandboxOptions {
  readOnly?: string[];
  timeoutS?: number;
  limits?: Limits;
  /** Skip the systemd scope (no task or whole-tree memory limit). Only for machines without user systemd. */
  noScope?: boolean;
}

/** Write the given files into a fresh workspace, run the command there, then delete the workspace. */
export async function runSandboxed(files: Map<string, string>, cmd: string[], opts: SandboxOptions = {}): Promise<SandboxResult> {
  const limits = opts.limits ?? LIMITS;
  const workspace = mkdtempSync(join(tmpdir(), "muse-sandbox-"));
  try {
    for (const [name, text] of files) writeFileSync(join(workspace, name), text, { mode: 0o600 });
    const inner = [
      "prlimit", ...limitArgs(limits),
      "bwrap", ...sandboxArgs(workspace, (opts.readOnly ?? []).map((p) => resolve(p)), cmd),
    ];
    const [file, ...args] = opts.noScope ? inner : ["systemd-run", ...scopeArgs(limits), ...inner];
    return await new Promise<SandboxResult>((done, fail) => {
      // Each launcher execs the next (systemd-run -> prlimit -> bwrap): one pid, and fd 3 reaches bwrap.
      const proc = spawn(file, args, { env: launcherEnv(), stdio: ["ignore", "pipe", "pipe", "pipe"] });
      let output = "";
      let status = "";
      let truncated = false;
      let timedOut = false;
      const take = (d: Buffer) => {
        if (output.length >= MAX_LOG_BYTES) return void (truncated = true);
        output += d.toString("utf8").slice(0, MAX_LOG_BYTES - output.length);
      };
      proc.stdout!.on("data", take);
      proc.stderr!.on("data", take);
      (proc.stdio[STATUS_FD] as NodeJS.ReadableStream).on("data", (d: Buffer) => (status = (status + d.toString("utf8")).slice(-65536)));
      const timer = setTimeout(() => ((timedOut = true), proc.kill("SIGKILL")), (opts.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000);
      proc.on("error", (err) => (clearTimeout(timer), fail(err)));
      proc.on("close", (_launcherCode, signal) => {
        clearTimeout(timer);
        const s = parseStatus(status);
        done({ outcome: classify(s, timedOut, signal), code: s.exitCode, signal, output, truncated });
      });
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
