import type { Locator, Page } from "playwright";
import { BridgeError, detectError, errorBaseline } from "./errors.js";
import { extractTurnText, type ExtractOptions } from "./extract.js";
import { log } from "./log.js";
import { count, isVisible, probe, sel, TURN_ID_ATTR } from "./selectors.js";
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

export interface SendOptions {
  timeoutMs: number;
  includeReasoning: boolean;
  onProgress?: (text: string) => void;
}

export interface SendOutcome {
  text: string;
  /** Set when the turn finished without ever showing a streaming indicator. */
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
  const quoted = '"' + turnId.replace(/["\\]/g, "\\$&") + '"';
  return page.locator(sel.assistantTurn).and(page.locator(`[${TURN_ID_ATTR}=${quoted}]`));
}

/**
 * Text of one whole reply. Muse can split a reply across several message elements that share a turn id,
 * so this reads every assistant message with the anchor's turn id, in page order.
 */
export async function extractReply(page: Page, anchor: Locator, includeReasoning = false): Promise<string> {
  const turnId = await anchor.getAttribute(TURN_ID_ATTR).catch(() => null);
  if (!turnId) return extractTurn(anchor, includeReasoning);
  const parts = turnParts(page, turnId);
  const texts: string[] = [];
  for (let i = 0, n = await parts.count(); i < n; i++) {
    const t = await extractTurn(parts.nth(i), includeReasoning);
    if (t) texts.push(t);
  }
  return texts.join("\n\n");
}

/** Reply text is still arriving: the typing placeholder, or the markdown body flagged as streaming. */
async function textStreaming(page: Page): Promise<boolean> {
  return isVisible(page, "streamingMarker");
}

/** Muse's agent is still working: the composer Stop or a running task. */
async function agentBusy(page: Page): Promise<boolean> {
  return (await isVisible(page, "stopButton")) || (await isVisible(page, "agentTaskButton"));
}

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
 * "Finished" = a reply exists, its text is no longer streaming (no typing placeholder, no streaming flag), and
 * the text has held still for SETTLE_MS, or for AGENT_SETTLE_MS if the agent is still busy. In that case
 * the result carries agentBusy. Text stability never ends the wait while text is streaming, so thinking pauses
 * don't cause early returns. Errors that appear mid-reply end the wait immediately with the partial text.
 */
export async function sendAndWait(page: Page, prompt: string, opts: SendOptions): Promise<SendOutcome> {
  const deadline = Date.now() + opts.timeoutMs;
  const baseAssistant = await count(page, "assistantTurn");
  const baseUser = await count(page, "userTurn");
  const errBase = await errorBaseline(page);

  await typePrompt(page, prompt);
  const send = await probe(page, "sendButton");
  await send.click();

  // 1. The user's turn must appear, otherwise the send didn't go through.
  try {
    await page.waitForFunction(
      ([s, n]) => document.querySelectorAll(s as string).length > (n as number),
      [sel.userTurn, baseUser] as const,
      { timeout: 10_000, polling: 250 },
    );
  } catch {
    throw new BridgeError("SEND_NOT_ACCEPTED", "The prompt did not appear as a new user message within 10 s", {
      selector_key: "userTurn",
    });
  }

  let turn: Locator | null = null;
  let turnSeenAt = 0;
  let indicatorGoneAt: number | null = null;
  let seenIndicator = false;
  let text = "";
  let lastChange = Date.now();
  let quietSince: number | null = null;

  const partial = (code: BridgeError["code"], message: string, extra: Record<string, unknown> = {}) =>
    new BridgeError(code, message, { partial: true, text, ...extra });

  for (;;) {
    if (quickLoggedOut(page)) throw partial("LOGGED_OUT", "Session ended while waiting for the reply");

    const isStreaming = await textStreaming(page);
    const busy = await agentBusy(page);
    if (isStreaming || busy) seenIndicator = true;

    if (!turn && (await count(page, "assistantTurn")) > baseAssistant) {
      // Pin the reply's first message by its turn id, so later messages in other turns can't be picked up.
      const first = page.locator(sel.assistantTurn).nth(baseAssistant);
      const id = await first.getAttribute(TURN_ID_ATTR).catch(() => null);
      turn = id ? turnParts(page, id).first() : first;
      turnSeenAt = Date.now();
    }

    if (turn) {
      const next = await extractReply(page, turn, opts.includeReasoning).catch(() => text);
      if (next !== text) {
        text = next;
        lastChange = Date.now();
        opts.onProgress?.(text);
      }
    }

    // After reading the text, so an error still returns everything that streamed before it.
    const err = await detectError(page, errBase, turn);
    if (err) throw partial(err.code, err.message);

    const now = Date.now();
    if (now >= deadline) {
      if (isStreaming || busy) {
        // Only the composer Stop: stopping an agent task is a bigger step than ending this reply.
        const stop = page.locator(sel.stopButton).first();
        await stop.click({ timeout: 2000 }).catch(() => {});
      }
      throw partial("TIMEOUT", `Reply not finished after ${Math.round(opts.timeoutMs / 1000)} s`);
    }

    if (!turn && seenIndicator) {
      indicatorGoneAt = isStreaming || busy ? null : (indicatorGoneAt ?? now);
      if (indicatorGoneAt && now - indicatorGoneAt >= NO_REPLY_MS) {
        throw partial("NO_REPLY", "Muse stopped without replying (the reply was stopped or dropped)");
      }
    }

    if (turn) {
      if (seenIndicator) {
        if (isStreaming) {
          quietSince = null;
        } else {
          quietSince ??= now;
          const settle = busy ? AGENT_SETTLE_MS : SETTLE_MS;
          if (now - quietSince >= settle && now - lastChange >= settle && text) {
            return busy ? { text, agentBusy: true } : { text };
          }
        }
      } else if (now - turnSeenAt >= NO_INDICATOR_MS && now - lastChange >= FALLBACK_STABLE_MS && text) {
        log.warn("reply finished without a visible streaming indicator; stopButton/streamingMarker may be stale");
        return {
          text,
          warning: "No streaming indicator was seen; completion was judged by text stability. Check stopButton.",
        };
      }
    }

    await page.waitForTimeout(POLL_MS);
  }
}
