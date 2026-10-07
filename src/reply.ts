import type { Locator, Page } from "playwright";
import { screenshot } from "./browser.js";
import { BridgeError, detectError, errorBaseline } from "./errors.js";
import { extractTurnText, injectExtract, type ExtractOptions } from "./extract.js";
import { log } from "./log.js";
import { count, cssString, isVisible, MESSAGE_ID_ATTR, probe, sel, TURN_ID_ATTR } from "./selectors.js";
import { quickLoggedOut } from "./session.js";

const POLL_MS = 500;
/** After the text stops streaming, it must hold still this long before we return. */
const SETTLE_MS = 750;
/**
 * Same, while Muse's agent still shows Stop / Stop task. The agent can work for minutes after the text is done,
 * so we don't wait for it to finish; this longer window catches follow-up messages it adds soon after.
 */
const AGENT_SETTLE_MS = 5000;
/** If no indicator has shown up this long after the new turn appeared, assume the reply was instant. */
const NO_INDICATOR_MS = 5000;
/** Fallback stability window used only when the indicator was never seen. */
const FALLBACK_STABLE_MS = 3000;
/** Indicator came and went but no reply appeared for this long: the reply was stopped or dropped. */
const NO_REPLY_MS = 5000;
/** The reply's text has not changed for this long while still flagged as streaming: the flag is stuck. */
const STALL_MS = 60_000;
/** A reply with no readable text (e.g. a card only) counts as finished once everything has been idle this long. */
const EMPTY_SETTLE_MS = 5000;
/** How long the sent prompt has to show up as a new user message. */
const ANCHOR_TIMEOUT_MS = 10_000;
/** A page loaded less than this long ago may still be rendering its chat history. */
const FRESH_PAGE_MS = 15_000;
/** History counts as loaded once the message count holds still this long (bounded by HISTORY_MAX_MS). */
const HISTORY_QUIET_MS = 1000;
const HISTORY_MAX_MS = 10_000;

const EMPTY_WARNING =
  "Muse's reply has no readable text (it may be only a card, image or attachment). Check the viewer or muse_read_transcript.";

export interface SendOptions {
  timeoutMs: number;
  includeReasoning: boolean;
  onProgress?: (text: string) => void;
  /** Overrides STALL_MS (for tests). */
  stallMs?: number;
}

export interface SendOutcome {
  text: string;
  /** Set when completion was uncertain: no streaming indicator seen, a stuck streaming flag, or no readable text. */
  warning?: string;
  /** Muse's agent was still working when the text settled; later messages may follow. */
  agentBusy?: boolean;
}

function extractOpts(includeReasoning: boolean): ExtractOptions {
  return { strip: sel.chromeStrip, reasoning: sel.reasoning, card: sel.card, includeReasoning };
}

export async function extractTurn(turn: Locator, includeReasoning = false): Promise<string> {
  return turn.evaluate(extractTurnText, extractOpts(includeReasoning));
}

/** Locator for the assistant messages of one turn. */
export function turnParts(page: Page, turnId: string): Locator {
  return page.locator(sel.assistantTurn).and(page.locator(`[${TURN_ID_ATTR}=${cssString(turnId)}]`));
}

/** Text of each message a locator matches, in page order, joined into one reply. */
async function extractParts(parts: Locator, includeReasoning: boolean): Promise<string> {
  const texts: string[] = [];
  for (let i = 0, n = await parts.count(); i < n; i++) {
    const t = await extractTurn(parts.nth(i), includeReasoning);
    if (t) texts.push(t);
  }
  return texts.join("\n\n");
}

/**
 * Text of one whole reply. Muse can split a reply across several message elements that share a turn id,
 * so this reads every assistant message with the anchor's turn id, in page order.
 */
export async function extractReply(page: Page, anchor: Locator, includeReasoning = false): Promise<string> {
  const turnId = await anchor.getAttribute(TURN_ID_ATTR).catch(() => null);
  if (!turnId) return extractTurn(anchor, includeReasoning);
  return extractParts(turnParts(page, turnId), includeReasoning);
}

/** Lowercase letters and digits only, so markdown rendering, line breaks and truncation marks don't matter. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a user message on the page shows the prompt we sent. The page may show a long prompt cut short. */
export function matchesPrompt(shown: string, prompt: string): boolean {
  const a = normalizeForMatch(shown);
  const b = normalizeForMatch(prompt);
  return a === b || (a.length >= 16 && b.startsWith(a));
}

/** Message id and text of every user message on the page, in page order. */
async function userMessages(page: Page): Promise<{ id: string; text: string }[]> {
  // Again on every call: the first send in a new chat moves the page to the thread's own URL, which drops it.
  await page.evaluate(injectExtract).catch(() => {});
  return page
    .locator(sel.userTurn)
    .evaluateAll(
      (els, o) =>
        els.map((el) => ({
          id: el.getAttribute(o.idAttr) ?? "",
          text: (window as unknown as { __museExtract: typeof extractTurnText }).__museExtract(el, o.x),
        })),
      { idAttr: MESSAGE_ID_ATTR, x: extractOpts(false) },
    )
    .catch(() => []);
}

/**
 * Message id of the prompt we just sent, if it is on the page: the last user message, new since `before`, showing
 * the prompt's text. Chat history that renders late is inserted above it, so none of it can pass for the new message.
 */
async function matchAnchor(page: Page, prompt: string, before: Set<string>): Promise<string | null> {
  const last = (await userMessages(page)).at(-1);
  return last?.id && !before.has(last.id) && matchesPrompt(last.text, prompt) ? last.id : null;
}

async function findAnchor(page: Page, prompt: string, before: Set<string>): Promise<string | null> {
  const deadline = Date.now() + ANCHOR_TIMEOUT_MS;
  for (;;) {
    const id = await matchAnchor(page, prompt, before);
    if (id || Date.now() >= deadline) return id;
    await page.waitForTimeout(250);
  }
}

/**
 * Message ids of the reply to user message `anchorId`: every assistant message after it, up to the next user
 * message. null when the anchor is not in the DOM (e.g. a virtualized list unmounted it).
 */
async function replyIds(page: Page, anchorId: string): Promise<string[] | null> {
  return page
    .evaluate(
      ({ user, assistant, idAttr, anchor }) => {
        const els = Array.from(document.querySelectorAll(`${user}, ${assistant}`));
        const i = els.findIndex((e) => e.matches(user) && e.getAttribute(idAttr) === anchor);
        if (i < 0) return null;
        const ids: string[] = [];
        for (const e of els.slice(i + 1)) {
          if (e.matches(user)) break;
          const id = e.getAttribute(idAttr);
          if (id) ids.push(id);
        }
        return ids;
      },
      { user: sel.userTurn, assistant: sel.assistantTurn, idAttr: MESSAGE_ID_ATTR, anchor: anchorId },
    )
    .catch(() => null);
}

function messagesById(page: Page, ids: string[]): Locator {
  return page.locator(ids.map((id) => `[${MESSAGE_ID_ATTR}=${cssString(id)}]`).join(", "));
}

/**
 * On a page loaded moments ago, wait for the chat history to stop rendering in. The prompt anchor already keeps
 * history from passing for the reply; this also covers re-sending the same prompt right after a restart.
 */
async function settleHistory(page: Page): Promise<void> {
  const age = await page.evaluate(() => performance.now()).catch(() => Infinity);
  if (age >= FRESH_PAGE_MS) return;
  const total = async () => (await count(page, "userTurn")) + (await count(page, "assistantTurn"));
  const deadline = Date.now() + HISTORY_MAX_MS;
  let last = await total();
  let since = Date.now();
  while (Date.now() < deadline && Date.now() - since < HISTORY_QUIET_MS) {
    await page.waitForTimeout(200);
    const n = await total();
    if (n !== last) {
      last = n;
      since = Date.now();
    }
  }
}

/** The page signals read on each poll. `markdown` is checked only inside the reply's own messages. */
interface Signals {
  typing: boolean;
  markdown: boolean;
  stop: boolean;
  task: boolean;
}

async function readSignals(page: Page, parts: Locator | null): Promise<Signals> {
  return {
    typing: await isVisible(page, "typingIndicator"),
    markdown: parts ? await parts.locator(sel.markdownStreaming).first().isVisible().catch(() => false) : false,
    stop: await isVisible(page, "stopButton"),
    task: await isVisible(page, "agentTaskButton"),
  };
}

/** Names of the signals that are on, for logs (never page text). */
const signalsOn = (s: Signals) => (Object.keys(s) as (keyof Signals)[]).filter((k) => s[k]);

/** Type the prompt into the (likely contenteditable) input without letting newlines submit early. */
async function typePrompt(page: Page, prompt: string): Promise<void> {
  const input = await probe(page, "chatInput");
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(prompt);
}

/**
 * Send a prompt and wait for the reply to finish.
 *
 * The reply is every assistant message after our own prompt's user message, up to the next user message. It is
 * found by position, never by counting messages: on a freshly loaded page the chat history can render after a
 * count is taken, and an old message would then pass for the reply.
 *
 * "Finished" = a reply has text, it is no longer streaming (its markdown isn't flagged as streaming), and:
 *  - nothing shows the agent working (Stop, Stop task, typing placeholder) and the text has held still, both for
 *    SETTLE_MS; or
 *  - the agent is still working but the text has held still for AGENT_SETTLE_MS. The result carries agentBusy.
 * A reply with no readable text finishes once everything has been idle for EMPTY_SETTLE_MS, with a warning.
 * The typing placeholder counts as streaming only before the reply has text; after that Muse shows it while the
 * agent works (e.g. runs a tool), which can last minutes. Text stability never ends the wait while the text is
 * streaming, so thinking pauses don't cause early returns, unless the text has been static for STALL_MS (a stuck
 * flag). Errors that appear mid-reply end the wait immediately with the partial text.
 */
export async function sendAndWait(page: Page, prompt: string, opts: SendOptions): Promise<SendOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  const stallMs = opts.stallMs ?? STALL_MS;
  await settleHistory(page);
  const before = new Set((await userMessages(page)).map((m) => m.id));
  const errBase = await errorBaseline(page);

  await typePrompt(page, prompt);
  const send = await probe(page, "sendButton");
  await send.click();

  // 1. Our prompt must appear as a new user message, otherwise the send didn't go through.
  let anchorId = await findAnchor(page, prompt, before);
  if (!anchorId) {
    throw new BridgeError("SEND_NOT_ACCEPTED", "The prompt did not appear as a new user message within 10 s", {
      selector_key: "userTurn",
    });
  }
  log.info({ anchor_id: anchorId, elapsed_ms: Date.now() - startedAt }, "prompt anchored");

  /** Message ids of the reply so far, and a locator for them. */
  let ids: string[] = [];
  let parts: Locator | null = null;
  let replySeenAt = 0;
  let anchorLost = false;
  let indicatorGoneAt: number | null = null;
  let seenIndicator = false;
  let text = "";
  let lastChange = Date.now();
  /** Since when the text has not been streaming. */
  let quietSince: number | null = null;
  /** Since when nothing at all has been on: not streaming and the agent not busy. */
  let idleSince: number | null = null;

  const partial = (code: BridgeError["code"], message: string, extra: Record<string, unknown> = {}) =>
    new BridgeError(code, message, { partial: true, text, ...extra });
  const finish = (decision: string, sig: Signals, out: SendOutcome): SendOutcome => {
    const now = Date.now();
    log.info(
      { decision, signals: signalsOn(sig), reply_parts: ids.length, text_chars: text.length, stable_ms: now - lastChange, elapsed_ms: now - startedAt },
      "reply finished",
    );
    return out;
  };

  for (;;) {
    if (quickLoggedOut(page)) throw partial("LOGGED_OUT", "Session ended while waiting for the reply");

    let found = await replyIds(page, anchorId);
    if (found === null) {
      // Muse shows a sent message under a client-side id, then swaps in the server's id once it is saved.
      const rekeyed = await matchAnchor(page, prompt, before);
      if (rekeyed) {
        log.info({ from: anchorId, to: rekeyed }, "prompt message re-keyed");
        anchorId = rekeyed;
        found = await replyIds(page, anchorId);
      }
    }
    if (found === null) {
      // Keep the messages found so far; they may still be on the page.
      if (!anchorLost) log.warn({ anchor_id: anchorId }, "prompt message left the page");
      anchorLost = true;
    } else {
      anchorLost = false;
      if (found.join("\0") !== ids.join("\0")) {
        if (!ids.length) replySeenAt = Date.now();
        ids = found;
        parts = ids.length ? messagesById(page, ids) : null;
        log.info({ reply_ids: ids }, "reply messages");
      }
    }

    // Skip a read while any reply message is missing from the DOM, so a virtualized list can't blank the text.
    if (parts && (await parts.count().catch(() => 0)) === ids.length) {
      const next = await extractParts(parts, opts.includeReasoning).catch(() => text);
      if (next !== text) {
        text = next;
        lastChange = Date.now();
        opts.onProgress?.(text);
      }
    }

    // After reading the text, so an error still returns everything that streamed before it.
    const err = await detectError(page, errBase, parts?.last() ?? null);
    if (err) throw partial(err.code, err.message);

    const sig = await readSignals(page, parts);
    const hasReply = ids.length > 0;
    const hasText = text.trim() !== "";
    const streaming = sig.markdown || (sig.typing && !hasText);
    const busy = sig.stop || sig.task || (sig.typing && hasText);
    if (streaming || busy) seenIndicator = true;

    const now = Date.now();
    if (now >= deadline) {
      log.warn(
        { signals: signalsOn(sig), anchor_id: anchorId, reply_parts: ids.length, text_chars: text.length, stable_ms: now - lastChange },
        "reply timed out",
      );
      // Before clicking Stop, so the screenshot shows what kept the wait open.
      const shot = await screenshot("timeout");
      if (streaming || busy) {
        // Only the composer Stop: stopping an agent task is a bigger step than ending this reply.
        const stop = page.locator(sel.stopButton).first();
        await stop.click({ timeout: 2000 }).catch(() => {});
      }
      throw partial("TIMEOUT", `Reply not finished after ${Math.round(opts.timeoutMs / 1000)} s`, {
        ...(shot ? { screenshot: shot } : {}),
      });
    }

    if (!hasReply && seenIndicator) {
      indicatorGoneAt = streaming || busy ? null : (indicatorGoneAt ?? now);
      if (indicatorGoneAt && now - indicatorGoneAt >= NO_REPLY_MS) {
        throw partial("NO_REPLY", "Muse stopped without replying (the reply was stopped or dropped)");
      }
    }

    if (hasReply) {
      const stable = now - lastChange;
      if (seenIndicator) {
        const settleMs = hasText ? SETTLE_MS : EMPTY_SETTLE_MS;
        quietSince = streaming ? null : (quietSince ?? now);
        idleSince = streaming || busy ? null : (idleSince ?? now);
        if (idleSince !== null && now - idleSince >= settleMs && stable >= settleMs) {
          return hasText ? finish("settled", sig, { text }) : finish("empty", sig, { text, warning: EMPTY_WARNING });
        }
        if (hasText && busy && quietSince !== null && now - quietSince >= AGENT_SETTLE_MS && stable >= AGENT_SETTLE_MS) {
          return finish("agent_busy", sig, { text, agentBusy: true });
        }
        if (hasText && streaming && stable >= stallMs) {
          return finish("stalled", sig, {
            text,
            ...(busy ? { agentBusy: true } : {}),
            warning: `The reply still looked like it was streaming, but its text had not changed for ${Math.round(stallMs / 1000)} s. It may be incomplete.`,
          });
        }
      } else if (now - replySeenAt >= NO_INDICATOR_MS && stable >= (hasText ? FALLBACK_STABLE_MS : EMPTY_SETTLE_MS)) {
        log.warn("reply finished without a visible streaming indicator; stopButton/typingIndicator may be stale");
        return finish("no_indicator", sig, {
          text,
          warning: hasText
            ? "No streaming indicator was seen; completion was judged by text stability. Check stopButton."
            : EMPTY_WARNING,
        });
      }
    }

    await page.waitForTimeout(POLL_MS);
  }
}
