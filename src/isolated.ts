import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";

/**
 * Run a separate, tool-less `claude -p` on untrusted text. Shared by the summarizer and the export review.
 *   --tools ""             no built-in tools          --strict-mcp-config   no MCP servers (not even this bridge)
 *   --restricted           ignores user/project/local settings, so no hooks or permission rules apply
 *   --disable-slash-commands, --no-session-persistence, and an empty working dir (no CLAUDE.md, no memory)
 * The text goes in on stdin, never argv, so it doesn't show up in `ps`. Only the variables the CLI needs to
 * find its install and login are passed through.
 */
const CLI_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|XDG_\w+)$/;
/** More output than any summary or review needs; past this the run is killed and treated as failed. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface IsolatedRun {
  system: string;
  input: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs: number;
}

/** The model's final text. Throws an Error with a short reason on any failure. */
export async function runIsolatedClaude(run: IsolatedRun): Promise<string> {
  mkdirSync(config.summarizerDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && CLI_ENV.test(k)) env[k] = v;

  const args = [
    "-p", "--restricted", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
    "--no-session-persistence", "--output-format", "json",
    "--model", run.model ?? config.summaryModel, "--effort", run.effort ?? "low", "--system-prompt", run.system,
  ];

  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(config.claudePath, args, { cwd: config.summarizerDir, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), run.timeoutMs);
    let tooBig = false;
    proc.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_BYTES && !tooBig) {
        tooBig = true;
        proc.kill("SIGKILL");
      }
    });
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4096)));
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (tooBig) reject(new Error(`output over ${MAX_OUTPUT_BYTES} bytes`));
      else if (code === 0) resolve(stdout);
      else reject(new Error(signal ? `killed by ${signal} (timeout?)` : `exit ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    proc.stdin.end(run.input);
  });

  let parsed: { is_error?: boolean; result?: unknown; subtype?: string };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error("claude -p returned output that isn't JSON");
  }
  if (parsed.is_error || typeof parsed.result !== "string" || !parsed.result.trim()) {
    throw new Error(`claude -p returned no result (${parsed.subtype ?? "unknown"})`);
  }
  return parsed.result.trim();
}
