import type { Page } from "playwright";
import { config } from "./config.js";
import { isVisible } from "./selectors.js";

export type SessionState = "ok" | "logged_out";

const LOGIN_HOSTS = new Set(["auth.muse.ai", "facebook.com", "www.facebook.com", "m.facebook.com"]);

/** True when the URL alone says we're on a login / auth bounce page. */
export function isLoginUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return LOGIN_HOSTS.has(u.hostname) || /\/login|\/aymh\//.test(u.pathname);
  } catch {
    return false;
  }
}

function onMuse(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === new URL(config.url).hostname;
  } catch {
    return false;
  }
}

/**
 * Logged in  = on the muse.ai host AND the chat input is visible.
 * Logged out = on an auth/facebook URL, OR a login button is visible, OR no chat input once the page settles.
 */
export async function checkSession(page: Page, settleMs = 5000): Promise<SessionState> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const url = page.url();
    if (isLoginUrl(url)) return "logged_out";
    if (onMuse(url) && (await isVisible(page, "chatInput"))) return "ok";
    if (await isVisible(page, "loginButton")) return "logged_out";
    if (Date.now() >= deadline) return "logged_out";
    await page.waitForTimeout(250);
  }
}

/** Cheap check usable on every poll while a reply streams. */
export function quickLoggedOut(page: Page): boolean {
  return isLoginUrl(page.url());
}
