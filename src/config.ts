import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DisplayMode = "xvfb" | "headless" | "headed";

const home = process.env.MUSE_HOME ?? join(homedir(), ".muse-bridge");

export const config = {
  home,
  profileDir: join(home, "profile"),
  debugDir: join(home, "debug"),
  discoveryDir: join(home, "discovery"),
  logFile: join(home, "bridge.log"),
  url: process.env.MUSE_URL ?? "https://muse.ai/",
  /** Opening this path starts a fresh thread; it becomes /thread/<uuid> after the first send. */
  newThreadPath: "thread/new",
  display: (process.env.MUSE_DISPLAY ?? "xvfb") as DisplayMode,
  /** Chromium build to drive. Defaults to the local ungoogled-chromium 148 (an extracted AppImage). */
  chromiumPath:
    process.env.MUSE_CHROMIUM_PATH ??
    join(homedir(), "applications/ungoogled-chromium-148/opt/ungoogled-chromium/chrome"),
  logLevel: process.env.MUSE_LOG_LEVEL ?? "info",
};

/** Create the state dirs. The profile holds a muse.ai *and* a Facebook session, so it is owner-only. */
export function ensureDirs(): void {
  for (const dir of [config.home, config.profileDir, config.debugDir, config.discoveryDir]) {
    mkdirSync(dir, { recursive: true });
  }
  chmodSync(config.home, 0o700);
  chmodSync(config.profileDir, 0o700);
}
