import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { extractTurnText, injectExtract } from "./extract.js";
import { sel, TURN_ID_ATTR } from "./selectors.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

interface Seen extends Turn {
  key: string;
}

/** All turns currently in the DOM, in page order. */
async function visibleTurns(page: Page, includeReasoning: boolean): Promise<Seen[]> {
  const loc = page.locator(`${sel.userTurn}, ${sel.assistantTurn}`);
  const raw = await loc.evaluateAll(
    (els, o) =>
      els.map((el) => ({
        // Messages of one reply share a turn id; they are merged below.
        id: el.getAttribute(o.turnAttr) ?? el.getAttribute("data-message-id") ?? "",
        role: el.matches(o.user) ? "user" : "assistant",
        // extractTurnText is injected below as a string; see readTranscript.
        text: (window as unknown as { __museExtract: typeof extractTurnText }).__museExtract(el, o.x),
      })),
    {
      turnAttr: TURN_ID_ATTR,
      user: sel.userTurn,
      x: { strip: sel.chromeStrip, reasoning: sel.reasoning, card: sel.card, includeReasoning },
    },
  );
  const merged: Seen[] = [];
  for (const t of raw) {
    const key = t.id || createHash("sha1").update(`${t.role}\0${t.text}`).digest("hex");
    const prev = merged[merged.length - 1];
    if (prev && t.id && prev.key === key) {
      if (t.text) prev.text = prev.text ? `${prev.text}\n\n${t.text}` : t.text;
    } else {
      merged.push({ role: t.role as Turn["role"], text: t.text, key });
    }
  }
  return merged;
}

/**
 * Read the last `limit` turns. If the message list is virtualized (older turns leave the DOM), scroll up
 * step by step to bring them back, merge by stable key, then scroll back to the bottom.
 */
export async function readTranscript(page: Page, limit: number, includeReasoning = false): Promise<Turn[]> {
  await page.evaluate(injectExtract);

  let all = await visibleTurns(page, includeReasoning);
  // The message column itself may not scroll; tag its nearest scrollable ancestor so we can drive that.
  const hasScroller = await page
    .locator(sel.messageScroller)
    .first()
    .evaluate((el) => {
      document.querySelectorAll("[data-muse-bridge-scroller]").forEach((e) => e.removeAttribute("data-muse-bridge-scroller"));
      for (let e: HTMLElement | null = el as HTMLElement; e; e = e.parentElement) {
        const oy = getComputedStyle(e).overflowY;
        if (e.scrollHeight > e.clientHeight + 4 && (oy === "auto" || oy === "scroll")) {
          e.setAttribute("data-muse-bridge-scroller", "");
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  const scroller = page.locator("[data-muse-bridge-scroller]").first();

  if (hasScroller) {
    for (let step = 0; step < 200 && all.length < limit; step++) {
      const atTop = await scroller.evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 0.8);
        return el.scrollTop === 0;
      });
      await page.waitForTimeout(300);
      const batch = await visibleTurns(page, includeReasoning);
      const known = new Set(all.map((t) => t.key));
      const firstKnown = batch.findIndex((t) => known.has(t.key));
      const older = (firstKnown === -1 ? batch : batch.slice(0, firstKnown)).filter((t) => !known.has(t.key));
      all = [...older, ...all];
      if (atTop) break;
    }
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight)).catch(() => {});
  }

  return all.slice(-limit).map(({ role, text }) => ({ role, text }));
}
