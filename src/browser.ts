import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config, ensureDirs, PRIVATE_FILE_MODE, type DisplayMode } from "./config.js";
import { BridgeError } from "./errors.js";
import { log } from "./log.js";
import { isLoginUrl } from "./session.js";

let context: BrowserContext | null = null;
let page: Page | null = null;
let mode: DisplayMode | null = null;
let xvfb: ChildProcess | null = null;
let xvfbDisplay: string | null = null;

/**
 * Start a private Xvfb server for "headed but invisible" mode.
 *
 * WSLg mounts /tmp/.X11-unix where we can't create sockets, so Xvfb listens only on the Linux abstract socket
 * (Chromium's X client tries that first). Displays start at :99 so we never shadow WSLg's own :0.
 * Readiness comes from -displayfd: Xvfb writes the display number to fd 3 once it accepts connections.
 */
async function startXvfb(): Promise<string> {
  if (xvfb && xvfbDisplay) return xvfbDisplay;
  for (let n = 99; n < 130; n++) {
    const proc = spawn(
      "Xvfb",
      [`:${n}`, "-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-nolisten", "unix"],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      proc.stdio[3]!.once("data", () => (clearTimeout(timer), resolve(true)));
      proc.once("exit", () => (clearTimeout(timer), resolve(false)));
      proc.once("error", () => (clearTimeout(timer), resolve(false)));
    });
    if (ready) {
      xvfb = proc;
      xvfbDisplay = `:${n}`;
      log.info({ display: xvfbDisplay }, "xvfb started");
      return xvfbDisplay;
    }
    proc.kill();
  }
  throw new BridgeError("INTERNAL", "Could not start Xvfb (is the xvfb package installed?)");
}

function stopXvfb(): void {
  xvfb?.kill();
  xvfb = null;
  xvfbDisplay = null;
}

/**
 * Variables Chromium actually needs (display, locale, fonts, audio, temp dirs). Everything else in the MCP
 * host's environment (API keys, tokens) stays out of the browser process and its crash dumps.
 */
const BROWSER_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_\w+|DBUS_SESSION_BUS_ADDRESS|PULSE_SERVER|FONTCONFIG_\w+|LD_LIBRARY_PATH)$/;

/**
 * Executable + env for the configured Chromium. The AppImage's AppRun only adds its bundled usr/lib to
 * LD_LIBRARY_PATH before exec'ing chrome; we do the same here and run chrome directly, so Playwright's
 * signals reach the browser rather than a shell wrapper.
 */
export function chromiumLaunch(): { executablePath: string; env: Record<string, string> } {
  const exe = config.chromiumPath;
  if (!existsSync(exe)) {
    throw new BridgeError("INTERNAL", `Chromium not found at ${exe} (set MUSE_CHROMIUM_PATH)`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && BROWSER_ENV.test(k)) env[k] = v;
  const appLib = resolve(dirname(exe), "../../usr/lib");
  if (existsSync(appLib)) env.LD_LIBRARY_PATH = [appLib, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  return { executablePath: exe, env };
}

async function launch(m: DisplayMode): Promise<void> {
  ensureDirs();
  const { executablePath, env } = chromiumLaunch();
  if (m === "xvfb") {
    env.DISPLAY = await startXvfb();
    delete env.WAYLAND_DISPLAY; // keep Chromium on the private X display, not the WSLg desktop
  }
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      headless: m === "headless",
      executablePath,
      viewport: { width: 1280, height: 860 },
      env,
    });
  } catch (err) {
    const msg = String(err);
    if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(msg)) {
      throw new BridgeError(
        "PROFILE_IN_USE",
        "The muse-bridge browser profile is already open in another process (the MCP server or `npm run login`). Close that one first.",
      );
    }
    throw err;
  }
  mode = m;
  context.on("close", () => {
    context = null;
    page = null;
  });
  page = context.pages()[0] ?? (await context.newPage());
  log.info({ mode: m }, "browser launched");
}

/** The single shared page, launching the browser in the requested mode if needed. */
export async function getPage(m: DisplayMode = config.display): Promise<Page> {
  if (context && mode !== m) await closeBrowser();
  if (!context || !page || page.isClosed()) {
    if (context) await closeBrowser();
    await launch(m);
  }
  if (!page!.url().startsWith("http")) {
    await page!.goto(config.url, { waitUntil: "domcontentloaded" });
  }
  return page!;
}

/** The open page without launching anything; null if the browser isn't running. */
export function currentPage(): Page | null {
  return page && !page.isClosed() ? page : null;
}

export function browserState(): { running: boolean; mode: DisplayMode | null; url: string | null } {
  return { running: !!context, mode: context ? mode : null, url: page && !page.isClosed() ? page.url() : null };
}

export async function closeBrowser(): Promise<void> {
  const ctx = context;
  context = null;
  page = null;
  await ctx?.close().catch(() => {});
  stopXvfb();
}

/** Debug screenshots show the logged-in page, so only the most recent few are kept. */
const KEEP_SCREENSHOTS = 20;

function pruneScreenshots(): void {
  const shots = readdirSync(config.debugDir).filter((f) => f.endsWith(".png")).sort(); // names start with an ISO timestamp
  for (const f of shots.slice(0, -KEEP_SCREENSHOTS)) rmSync(join(config.debugDir, f), { force: true });
}

export async function screenshot(name: string): Promise<string | null> {
  // Never capture auth pages: they can show account details or one-time codes.
  if (!page || page.isClosed() || isLoginUrl(page.url())) return null;
  const path = `${config.debugDir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`;
  try {
    await page.screenshot({ path, fullPage: false });
    chmodSync(path, PRIVATE_FILE_MODE);
    pruneScreenshots();
    return path;
  } catch {
    return null;
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}
process.once("exit", stopXvfb);
