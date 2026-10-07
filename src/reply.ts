import type { Locator, Page } from "playwright";
import { screenshot } from "./browser.js";
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
/** The reply's text has not changed for this long while still flagged as streaming: the flag is stuck. */
const STALL_MS = 60_000;

export interface SendOptions {
  timeoutMs: number;
  includeReasoning: boolean;
  onProgress?: (text: string) => void;
  /** Overrides STALL_MS (for tests). */
  stallMs?: number;
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
 * "Finished" = a reply has text, it is no longer streaming (its markdown isn't flagged as streaming), and:
 *  - nothing shows the agent working (Stop, Stop task, typing placeholder) and the text has held still, both for
 *    SETTLE_MS; or
 *  - the agent is still working but the text has held still for AGENT_SETTLE_MS. The result carries agentBusy.
 * The typing placeholder counts as streaming only before the reply has text; after that Muse shows it while the
 * agent works (e.g. runs a tool), which can last minutes. Text stability never ends the wait while the text is
 * streaming, so thinking pauses don't cause early returns, unless the text has been static for STALL_MS (a stuck
 * flag). Errors that appear mid-reply end the wait immediately with the partial text.
 */
export async function sendAndWait(page: Page, prompt: string, opts: SendOptions): Promise<SendOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  const stallMs = opts.stallMs ?? STALL_MS;
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
  let parts: Locator | null = null;
  let turnSeenAt = 0;
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
      { decision, signals: signalsOn(sig), text_chars: text.length, stable_ms: now - lastChange, elapsed_ms: now - startedAt },
      "reply finished",
    );
    return out;
  };

  for (;;) {
    if (quickLoggedOut(page)) throw partial("LOGGED_OUT", "Session ended while waiting for the reply");

    if (!turn && (await count(page, "assistantTurn")) > baseAssistant) {
      // Pin the reply's first message by its turn id, so later messages in other turns can't be picked up.
      const first = page.locator(sel.assistantTurn).nth(baseAssistant);
      const id = await first.getAttribute(TURN_ID_ATTR).catch(() => null);
      parts = id ? turnParts(page, id) : first;
      turn = parts.first();
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

    const sig = await readSignals(page, parts);
    const hasText = text.trim() !== "";
    const streaming = sig.markdown || (sig.typing && !hasText);
    const busy = sig.stop || sig.task || (sig.typing && hasText);
    if (streaming || busy) seenIndicator = true;

    const now = Date.now();
    if (now >= deadline) {
      log.warn(
        { signals: signalsOn(sig), text_chars: text.length, stable_ms: now - lastChange, turn_found: !!turn },
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

    if (!turn && seenIndicator) {
      indicatorGoneAt = streaming || busy ? null : (indicatorGoneAt ?? now);
      if (indicatorGoneAt && now - indicatorGoneAt >= NO_REPLY_MS) {
        throw partial("NO_REPLY", "Muse stopped without replying (the reply was stopped or dropped)");
      }
    }

    if (turn && hasText) {
      const stable = now - lastChange;
      if (seenIndicator) {
        quietSince = streaming ? null : (quietSince ?? now);
        idleSince = streaming || busy ? null : (idleSince ?? now);
        if (idleSince !== null && now - idleSince >= SETTLE_MS && stable >= SETTLE_MS) {
          return finish("settled", sig, { text });
        }
        if (busy && quietSince !== null && now - quietSince >= AGENT_SETTLE_MS && stable >= AGENT_SETTLE_MS) {
          return finish("agent_busy", sig, { text, agentBusy: true });
        }
        if (streaming && stable >= stallMs) {
          return finish("stalled", sig, {
            text,
            ...(busy ? { agentBusy: true } : {}),
            warning: `The reply still looked like it was streaming, but its text had not changed for ${Math.round(stallMs / 1000)} s. It may be incomplete.`,
          });
        }
      } else if (now - turnSeenAt >= NO_INDICATOR_MS && stable >= FALLBACK_STABLE_MS) {
        log.warn("reply finished without a visible streaming indicator; stopButton/typingIndicator may be stale");
        return finish("no_indicator", sig, {
          text,
          warning: "No streaming indicator was seen; completion was judged by text stability. Check stopButton.",
        });
      }
    }

    await page.waitForTimeout(POLL_MS);
  }
}
