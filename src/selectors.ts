import type { Locator, Page } from "playwright";

/**
 * Every DOM selector the bridge uses, under a named key.
 *
 * The defaults are generic guesses until selector discovery (`npm run discover`) has been run against
 * the live site. Patch a selector without rebuilding via MUSE_SELECTOR_OVERRIDES='{"key":"css"}'.
 * Prefer role / aria-label / data-* attributes over generated class names.
 */
const defaults = {
  // Confirmed against the live logged-in site with `npm run discover` (2026-10-05) unless noted.
  chatInput: 'textarea[aria-label="Message"]',
  // Only rendered while the composer has text.
  sendButton: 'button[aria-label="Send"]',
  // The composer's Stop. It can vanish ~0.7 s before the reply text arrives (the typing indicator covers that gap),
  // and it can stay up for minutes while Muse's agent works after the text is done.
  stopButton: '[data-hatch-composer-action="stop"] button, button[aria-label="Stop"]',
  // Shown while Muse's agent runs a background task. It can outlive the reply by minutes, so it only lengthens the
  // settle window (to catch follow-up messages) and is never clicked.
  agentTaskButton: 'button[aria-label="Stop task"]',
  // A standalone role=status item at the end of the log, not part of any reply. It shows before the reply starts,
  // and again while the agent works after the text is done (seen next to "Stop task").
  typingIndicator: '[data-testid="hatch-chat-typing-indicator"]',
  // The streaming flag on a reply's markdown body. Only checked inside the reply's own messages.
  markdownStreaming: '[data-hatch-markdown-streaming="true"]',
  userTurn: '[data-message-item="true"][data-message-role="user"]',
  // One reply may span several of these; they share data-message-turn-id (see TURN_ID_ATTR).
  assistantTurn: '[data-message-item="true"][data-message-role="assistant"]',
  // Confirmed on the live logged-out landing page: "Log in" button + phone/email field.
  loginButton: 'button:has-text("Log in"), input[aria-label="Mobile number or email"]',
  // Not yet observed live; generic until a real error is captured.
  errorBanner: '[role="alert"]',
  // Scoped to alert/status regions so a reply that merely *says* "try again later" doesn't match. Not yet observed live.
  rateLimitNotice:
    '[role="alert"]:text-matches("(rate limit|too many requests|try again later)", "i"), [role="status"]:text-matches("(rate limit|too many requests|try again later)", "i")',
  // Not yet observed live.
  regenerateButton: 'button[aria-label*="regenerate" i], button[aria-label*="retry" i], button:has-text("Try again")',
  // The message column; the scrollable element is found by walking up from here.
  messageScroller: '[role="log"][aria-label="Chat messages"]',
  // Inside a message: page UI that is not part of the reply. Muse marks its own with data-copy-exclude.
  chromeStrip:
    '[data-copy-exclude="true"], [data-message-accessibility-surrogate], [data-streamdown="code-block-header"], [data-streamdown="code-block-actions"], button, [role="button"], time, svg, [aria-hidden="true"], [role="toolbar"]',
  // Not yet observed live.
  reasoning: 'details, [data-testid*="reasoning" i], [aria-label*="thinking" i]',
  // Not yet observed live.
  card: '[data-testid*="card" i]',
};

/** Messages belonging to one reply share this attribute. */
export const TURN_ID_ATTR = "data-message-turn-id";

export type SelectorKey = keyof typeof defaults;

function loadOverrides(): Partial<Record<SelectorKey, string>> {
  const raw = process.env.MUSE_SELECTOR_OVERRIDES;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("MUSE_SELECTOR_OVERRIDES is not valid JSON");
  }
}

export const sel: Record<SelectorKey, string> = { ...defaults, ...loadOverrides() };

export class SelectorError extends Error {
  constructor(
    readonly key: SelectorKey,
    readonly selector: string,
    readonly url: string,
  ) {
    super(`Selector "${key}" (${selector}) matched nothing on ${url}`);
  }
}

/** Resolve a required element, or throw a SelectorError naming the key that failed. */
export async function probe(page: Page, key: SelectorKey, timeoutMs = 5000): Promise<Locator> {
  const loc = page.locator(sel[key]).first();
  try {
    await loc.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw new SelectorError(key, sel[key], page.url());
  }
  return loc;
}

export async function isVisible(page: Page, key: SelectorKey): Promise<boolean> {
  return page.locator(sel[key]).first().isVisible().catch(() => false);
}

export async function count(page: Page, key: SelectorKey): Promise<number> {
  return page.locator(sel[key]).count().catch(() => 0);
}
