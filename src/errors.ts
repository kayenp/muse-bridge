import type { Locator, Page } from "playwright";
import { count, sel, type SelectorKey } from "./selectors.js";

export type ErrorCode =
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "GENERATION_FAILED"
  | "NO_REPLY"
  | "UNKNOWN_ERROR"
  | "LOGGED_OUT"
  | "LOGIN_IN_PROGRESS"
  | "SEND_NOT_ACCEPTED"
  | "SELECTOR_MISSING"
  | "TIMEOUT"
  | "PROFILE_IN_USE"
  | "INTERNAL";

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Counts of error-ish elements before a send, so pre-existing alerts aren't mistaken for new failures. */
export type ErrorBaseline = Record<"errorBanner" | "rateLimitNotice", number>;

export async function errorBaseline(page: Page): Promise<ErrorBaseline> {
  return {
    errorBanner: await count(page, "errorBanner"),
    rateLimitNotice: await count(page, "rateLimitNotice"),
  };
}

async function newVisibleText(page: Page, key: SelectorKey, before: number): Promise<string | null> {
  const loc = page.locator(sel[key]);
  const n = await loc.count().catch(() => 0);
  for (let i = before; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      // Muse leaves empty alert/live regions around (seen after a stopped reply); only text counts as an error.
      const text = (await el.innerText().catch(() => "")).trim();
      if (text) return text.slice(0, 500);
    }
  }
  return null;
}

/**
 * Look for an error state that appeared after the send.
 *
 * Only RATE_LIMITED and GENERATION_FAILED have dedicated signals so far. Other new alerts are reported as
 * UNKNOWN_ERROR with their visible text until a real occurrence is captured and given its own code.
 */
export async function detectError(
  page: Page,
  baseline: ErrorBaseline,
  turn: Locator | null,
): Promise<BridgeError | null> {
  const rate = await newVisibleText(page, "rateLimitNotice", baseline.rateLimitNotice);
  if (rate) return new BridgeError("RATE_LIMITED", rate);

  if (turn) {
    const regen = turn.locator(sel.regenerateButton).first();
    if (await regen.isVisible().catch(() => false)) {
      const text = (await turn.innerText().catch(() => "")).trim().slice(-500);
      return new BridgeError("GENERATION_FAILED", text || "Reply failed; the page offers to regenerate");
    }
  }

  const banner = await newVisibleText(page, "errorBanner", baseline.errorBanner);
  if (banner) {
    const code = /network|connection|offline/i.test(banner) ? "NETWORK_ERROR" : "UNKNOWN_ERROR";
    return new BridgeError(code, banner);
  }
  return null;
}
