import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DisplayMode = "xvfb" | "headless" | "headed";

const home = process.env.MUSE_HOME ?? join(homedir(), ".muse-bridge");

/**
 * The browser carries a Facebook session too, so the bridge must only ever be pointed at an https Muse origin:
 * a MUSE_URL on facebook.com (or plain http) would have bridge tools acting as the user's Facebook account.
 */
function museUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error(`MUSE_URL must be https: ${raw}`);
  if (/(^|\.)facebook\.com$/i.test(u.hostname)) throw new Error(`MUSE_URL must not point at Facebook: ${raw}`);
  return u.href;
}

export const config = {
  home,
  profileDir: join(home, "profile"),
  debugDir: join(home, "debug"),
  discoveryDir: join(home, "discovery"),
  logFile: join(home, "bridge.log"),
  url: museUrl(process.env.MUSE_URL ?? "https://muse.ai/"),
  /** Opening this path starts a fresh thread; it becomes /thread/<uuid> after the first send. */
  newThreadPath: "thread/new",
  display: (process.env.MUSE_DISPLAY ?? "xvfb") as DisplayMode,
  /** Chromium build to drive. Defaults to the local ungoogled-chromium 148 (an extracted AppImage). */
  chromiumPath:
    process.env.MUSE_CHROMIUM_PATH ??
    join(homedir(), "applications/ungoogled-chromium-148/opt/ungoogled-chromium/chrome"),
  logLevel: process.env.MUSE_LOG_LEVEL ?? "info",
  /** `claude` CLI that summarizes Muse replies, and the model it uses. */
  claudePath: process.env.MUSE_CLAUDE_PATH ?? "claude",
  summaryModel: process.env.MUSE_SUMMARY_MODEL ?? "claude-opus-5-5",
  /** Empty working dir for the summarizer, so it picks up no CLAUDE.md or project memory. */
  summarizerDir: join(home, "summarizer"),
  /** Local raw-vs-summary viewer. 0 picks a free port; the URL (with its token) is written to viewerUrlFile. */
  viewerPort: Number(process.env.MUSE_VIEWER_PORT ?? 7391),
  viewerUrlFile: join(home, "viewer-url"),
  viewerTokenFile: join(home, "viewer-token"),
  /** Code exported from Muse replies (muse_export_code), one owner-only folder per export. */
  exportsDir: join(home, "exports"),
};

/** Owner-only mode for files the bridge writes (logs, screenshots, page dumps). */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create the state dirs, all owner-only: the profile holds a muse.ai *and* a Facebook session, and the log,
 * screenshot and discovery dirs can hold chat content. Each is locked down on its own so a copied or
 * re-parented dir doesn't silently become readable.
 */
export function ensureDirs(): void {
  for (const dir of [config.home, config.profileDir, config.debugDir, config.discoveryDir, config.summarizerDir, config.exportsDir]) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
}
