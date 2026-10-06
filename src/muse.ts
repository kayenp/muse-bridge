import type { Page } from "playwright";
import { browserState, closeBrowser, currentPage, getPage, screenshot } from "./browser.js";
import { config } from "./config.js";
import { BridgeError } from "./errors.js";
import { log } from "./log.js";
import { lock } from "./queue.js";
import { count, probe, SelectorError } from "./selectors.js";
import { checkSession } from "./session.js";

export type LoginState = "idle" | "logging_in" | "failed";

let loginState: LoginState = "idle";
let lastSession: "ok" | "logged_out" | "unknown" = "unknown";

export const LOGIN_HINT = "Call the muse_login tool (or run `npm run login` with the MCP server stopped), then log in in the window that opens.";

/** Page ready for chat work, or a LOGGED_OUT error. Call only while holding the lock. */
export async function readyPage(): Promise<Page> {
  if (loginState === "logging_in") {
    throw new BridgeError("LOGIN_IN_PROGRESS", "A login window is open; finish logging in first.");
  }
  const page = await getPage();
  lastSession = await checkSession(page);
  if (lastSession !== "ok") throw new BridgeError("LOGGED_OUT", "Not logged in to muse.ai.", { hint: LOGIN_HINT });
  return page;
}

export async function newChat(page: Page): Promise<void> {
  await page.goto(new URL(config.newThreadPath, config.url).href, { waitUntil: "domcontentloaded" });
  await probe(page, "chatInput", 10_000);
  // The new chat must start empty, or replies would be read from the old one.
  for (let i = 0; i < 20; i++) {
    if ((await count(page, "userTurn")) === 0 && (await count(page, "assistantTurn")) === 0) return;
    await page.waitForTimeout(250);
  }
  throw new BridgeError("INTERNAL", `Opened ${config.newThreadPath} but old messages are still on the page`);
}

/** Opens a visible (WSLg) window on the same profile and waits in the background for the user to log in. */
export function startLogin(): { status: string; message: string } {
  if (loginState === "logging_in") return { status: "pending", message: "Login window already open." };
  loginState = "logging_in";
  void lock
    .run(async () => {
      const page = await getPage("headed");
      await page.goto(config.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        if (page.isClosed()) break;
        if ((await checkSession(page, 0)) === "ok") {
          lastSession = "ok";
          loginState = "idle";
          log.info("login complete");
          await closeBrowser(); // reopen in the normal (xvfb) mode on next use
          return;
        }
        await page.waitForTimeout(1000);
      }
      loginState = "failed";
      log.warn("login window closed or timed out before login completed");
      await closeBrowser();
    })
    .catch((err) => {
      loginState = "failed";
      log.error({ err }, "login flow failed");
    });
  return {
    status: "pending",
    message: "A browser window opened on muse.ai. Log in there (up to 5 minutes), then check muse_status until session is ok.",
  };
}

export async function status(): Promise<Record<string, unknown>> {
  const b = browserState();
  let session: string = loginState === "logging_in" ? "logging_in" : lastSession;
  // Refresh the session view without taking the lock: this only reads the page.
  if (b.running && loginState !== "logging_in" && !lock.busy) {
    const page = currentPage();
    if (page) session = lastSession = await checkSession(page, 0);
  }
  return {
    session,
    login: loginState,
    busy: lock.busy,
    queue_depth: lock.depth,
    browser: b.running ? "running" : "not_started",
    display: b.mode ?? config.display,
    url: b.url,
  };
}

/** Turn any thrown error into a structured tool result, with a screenshot for selector failures. */
export async function errorResult(err: unknown): Promise<Record<string, unknown>> {
  if (err instanceof SelectorError) {
    return {
      status: "error",
      error: "SELECTOR_MISSING",
      key: err.key,
      selector: err.selector,
      url: err.url,
      screenshot: await screenshot(`selector-${err.key}`),
      hint: "Update this key in src/selectors.ts, or patch it via MUSE_SELECTOR_OVERRIDES.",
    };
  }
  if (err instanceof BridgeError) {
    const out: Record<string, unknown> = { status: "error", error: err.code, message: err.message, ...err.extra };
    if (err.code === "LOGGED_OUT") out.hint = LOGIN_HINT;
    return out;
  }
  log.error({ err }, "unexpected error");
  return { status: "error", error: "INTERNAL", message: String(err), screenshot: await screenshot("internal") };
}

