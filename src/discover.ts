// `npm run discover`: selector discovery helper. Opens a visible logged-in window and records, for later
// analysis, the page's network/websocket traffic, a timeline of chat UI state, and DOM snapshots.
//
// Snapshots are taken automatically when something interesting changes: a message is added, streaming
// starts or stops, text is typed in the composer, or a menu/dialog opens. You can also type a label in the
// terminal and press Enter for a manual one. Close the browser window (or type 'q') to finish.
// Everything stays local under ~/.muse-bridge/discovery/ (owner-only), and may include your chat content.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { closeBrowser, getPage } from "./browser.js";
import { config } from "./config.js";

const say = (msg: string) => console.error(msg);
const dir = `${config.discoveryDir}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(dir, { recursive: true });
const append = (file: string, o: Record<string, unknown>) =>
  appendFileSync(`${dir}/${file}`, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const rec = (o: Record<string, unknown>) => append("network.jsonl", o);

const page = await getPage("headed");
const host = new URL(config.url).hostname;

page.on("websocket", (ws) => {
  rec({ kind: "ws-open", url: ws.url() });
  ws.on("framereceived", (f) => rec({ kind: "ws-in", url: ws.url(), payload: String(f.payload).slice(0, 4000) }));
  ws.on("framesent", (f) => rec({ kind: "ws-out", url: ws.url(), payload: String(f.payload).slice(0, 2000) }));
  ws.on("close", () => rec({ kind: "ws-close", url: ws.url() }));
});
page.on("response", async (res) => {
  const req = res.request();
  if (!["fetch", "xhr", "eventsource", "other"].includes(req.resourceType())) return;
  if (!new URL(res.url()).hostname.endsWith(host.replace(/^www\./, ""))) return;
  const type = res.headers()["content-type"] ?? "";
  let body: string | undefined;
  if (/json|event-stream|text/.test(type)) body = (await res.text().catch(() => "")).slice(0, 20000);
  rec({ kind: "http", method: req.method(), url: res.url(), status: res.status(), type, body });
});

let n = 0;
let busy = false;
async function snapshot(label: string) {
  if (busy || page.isClosed()) return;
  busy = true;
  try {
    n++;
    const base = `${dir}/${String(n).padStart(3, "0")}-${label.replace(/\W+/g, "_") || "snap"}`;
    writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png` });
    rec({ kind: "snapshot", file: base, label });
    say(`snapshot ${n}: ${label}`);
  } catch {
    // page closed mid-snapshot
  } finally {
    busy = false;
  }
}

/** Compact view of the chat UI, read every 300 ms. Field changes trigger snapshots. */
const probeState = () =>
  page.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s));
    const items = q("[data-message-item]");
    const last = items[items.length - 1];
    const composer = document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null;
    const row = document.querySelector("[data-hatch-composer-input-row]");
    return {
      messages: items.length,
      lastRole: last?.getAttribute("data-message-role") ?? null,
      lastTurn: last?.getAttribute("data-message-turn-id") ?? null,
      lastLen: (last?.textContent ?? "").length,
      streamingAttrs: q("[data-hatch-markdown-streaming]").map((e) => e.getAttribute("data-hatch-markdown-streaming")).join(","),
      busyTrue: q('[aria-busy="true"]').length,
      composerHasText: !!composer?.value,
      composerButtons: row ? Array.from(row.closest("form, [data-hatch-chat-composer-anchor]")?.querySelectorAll("button, [role=button]") ?? row.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || (b.textContent ?? "").trim().slice(0, 20)).join("|") : "",
      stopLike: q("button[aria-label]").map((b) => b.getAttribute("aria-label")!).filter((l) => /stop|cancel|pause/i.test(l)).join("|"),
      overlays: q('[role="dialog"], [role="menu"], [role="listbox"], [data-state="open"]').length,
      alerts: q('[role="alert"], [role="status"]').map((e) => (e.textContent ?? "").trim().slice(0, 60)).filter(Boolean).join(" / "),
      url: location.pathname + location.search,
    };
  });

type State = Awaited<ReturnType<typeof probeState>>;
let prev: State | null = null;

function reason(a: State, b: State): string | null {
  if (b.messages !== a.messages) return `message-count-${a.messages}-to-${b.messages}-${b.lastRole}`;
  if (b.streamingAttrs !== a.streamingAttrs) return `streaming-${b.streamingAttrs || "none"}`;
  if (b.busyTrue !== a.busyTrue) return `aria-busy-${b.busyTrue}`;
  if (b.stopLike !== a.stopLike) return `stop-buttons-${b.stopLike || "none"}`;
  if (b.composerHasText !== a.composerHasText) return b.composerHasText ? "composer-typed" : "composer-cleared";
  if (b.composerButtons !== a.composerButtons) return "composer-buttons-changed";
  if (b.overlays !== a.overlays) return b.overlays > a.overlays ? "overlay-opened" : "overlay-closed";
  if (b.alerts !== a.alerts && b.alerts) return "alert-shown";
  if (b.url !== a.url) return "url-changed";
  return null;
}

say(`Recording to ${dir}`);
say("Chat in the window. Snapshots are automatic; type a label + Enter for a manual one. Close the window or type 'q' to finish.");

let stopped = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "q") stopped = true;
  else void snapshot(`manual-${line.trim()}`);
});
page.on("close", () => (stopped = true));

const deadline = Date.now() + 30 * 60_000;
let lastMidStream = 0;
await snapshot("start");
while (!stopped && Date.now() < deadline && !page.isClosed()) {
  try {
    const s = await probeState();
    append("timeline.jsonl", s);
    const why = prev ? reason(prev, s) : null;
    if (why) await snapshot(why);
    // While a reply is growing, also grab one mid-stream snapshot every 3 s.
    else if (prev && s.lastLen !== prev.lastLen && Date.now() - lastMidStream > 3000) {
      lastMidStream = Date.now();
      await snapshot("mid-stream");
    }
    prev = s;
  } catch {
    // navigation in progress; try again
  }
  await new Promise((r) => setTimeout(r, 300));
}
rl.close();
await closeBrowser();
say(`Done: ${n} snapshots. Files in ${dir}`);
process.exit(0);
