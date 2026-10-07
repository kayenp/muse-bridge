import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { config, PRIVATE_FILE_MODE } from "./config.js";
import { log } from "./log.js";

/**
 * Local page that shows each raw Muse reply next to the summary the agent got. This is the only place raw
 * Muse text goes: tool results carry the summary alone. The page is for the human user:
 *  - bound to 127.0.0.1, Host header checked (blocks DNS rebinding), data endpoint gated by a random token;
 *  - the URL with the token is written only to an owner-only file and never returned by a tool;
 *  - Muse text is rendered with textContent under a strict CSP, so nothing in a reply can run on the page;
 *  - history lives in memory only and is gone when the bridge exits.
 * It keeps raw text out of the agent's tool results; it can't stop a same-user agent with shell access from
 * reading that file and fetching the page on purpose.
 */

export type EntryKind = "send" | "latest" | "transcript" | "error";
export type SummaryState = "waiting" | "running" | "done" | "failed";

export interface Entry {
  id: number;
  kind: EntryKind;
  at: number;
  prompt?: string;
  raw: string;
  streaming: boolean;
  summaryState: SummaryState;
  summary?: string;
  note?: string;
}

const MAX_ENTRIES = 200;
const entries = new Map<number, Entry>();
const clients = new Set<ServerResponse>();
let nextId = 1;
let token = "";
let started = false;

function broadcast(e: Entry): void {
  const msg = `event: entry\ndata: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) res.write(msg);
}

export function addEntry(kind: EntryKind, init: Partial<Omit<Entry, "id" | "kind" | "at">> = {}): Entry {
  const e: Entry = { id: nextId++, kind, at: Date.now(), raw: "", streaming: false, summaryState: "waiting", ...init };
  entries.set(e.id, e);
  for (const id of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    entries.delete(id);
  }
  broadcast(e);
  return e;
}

export function updateEntry(e: Entry, patch: Partial<Omit<Entry, "id" | "kind" | "at">>): void {
  Object.assign(e, patch);
  broadcast(e);
}

function loadToken(): string {
  if (existsSync(config.viewerTokenFile)) {
    const t = readFileSync(config.viewerTokenFile, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(config.viewerTokenFile, t + "\n", { mode: PRIVATE_FILE_MODE });
  chmodSync(config.viewerTokenFile, PRIVATE_FILE_MODE);
  return t;
}

const tokenOk = (given: string | null) => {
  if (!given || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse, port: number): void {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, "text/plain", "Wrong host\n");
  if (req.method !== "GET") return send(res, 405, "text/plain", "Method not allowed\n");
  const url = new URL(req.url ?? "/", `http://${host}`);
  switch (url.pathname) {
    case "/":
      return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
    case "/app.js":
      return send(res, 200, "text/javascript; charset=utf-8", PAGE_JS);
    case "/app.css":
      return send(res, 200, "text/css; charset=utf-8", PAGE_CSS);
    case "/events": {
      if (!tokenOk(url.searchParams.get("t"))) return send(res, 403, "text/plain", "Bad or missing token\n");
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(`event: snapshot\ndata: ${JSON.stringify([...entries.values()])}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => (clearInterval(ping), clients.delete(res)));
      return;
    }
    default:
      return send(res, 404, "text/plain", "Not found\n");
  }
}

/** Start the viewer once. Failure is logged, never fatal: the bridge works without it. */
export function startViewer(): void {
  if (started) return;
  started = true;
  token = loadToken();
  const server = createServer((req, res) => handle(req, res, (server.address() as AddressInfo).port));
  const listen = (port: number) => server.listen(port, "127.0.0.1");
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && config.viewerPort !== 0) {
      log.warn({ port: config.viewerPort }, "viewer port in use; using a free port instead");
      listen(0);
    } else {
      log.error({ code: err.code }, "viewer failed to start");
    }
  });
  server.on("listening", () => {
    const { port } = server.address() as AddressInfo;
    writeFileSync(config.viewerUrlFile, `http://127.0.0.1:${port}/#t=${token}\n`, { mode: PRIVATE_FILE_MODE });
    chmodSync(config.viewerUrlFile, PRIVATE_FILE_MODE);
    log.info({ port }, "viewer listening; URL in viewer-url");
  });
  server.unref();
  listen(config.viewerPort);
}

// The token travels in the URL fragment, which browsers never send to the server or put in Referer headers;
// app.js reads it and passes it to /events.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Bridge Viewer</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header>
  <h1>Muse Bridge Viewer</h1>
  <p class="sub">Raw Muse replies (left) next to the summary the agent received (right). Raw text never reaches the agent.</p>
  <p id="conn" class="conn">Connecting…</p>
</header>
<main id="list"></main>
<template id="entry-tpl">
  <article class="entry">
    <div class="meta"><span class="kind"></span><time></time><span class="badge"></span></div>
    <div class="prompt"><span class="label">Prompt</span><pre></pre></div>
    <div class="cols">
      <section class="raw"><h2>Raw from Muse <span class="warn">untrusted</span></h2><pre></pre></section>
      <section class="summary"><h2>Summary sent to agent</h2><pre></pre></section>
    </div>
  </article>
</template>
</body>
</html>
`;

const PAGE_JS = `"use strict";
const token = new URLSearchParams(location.hash.slice(1)).get("t");
const list = document.getElementById("list");
const tpl = document.getElementById("entry-tpl");
const conn = document.getElementById("conn");
const nodes = new Map();
const KIND = { send: "Send", latest: "Read latest", transcript: "Transcript", error: "Error" };
const STATE = { waiting: "Waiting for reply", running: "Summarizing…", done: "Summarized", failed: "Summary failed" };

function render(e) {
  let el = nodes.get(e.id);
  if (!el) {
    el = tpl.content.firstElementChild.cloneNode(true);
    nodes.set(e.id, el);
    list.prepend(el);
  }
  el.querySelector(".kind").textContent = KIND[e.kind] || e.kind;
  const t = el.querySelector("time");
  t.textContent = new Date(e.at).toLocaleTimeString();
  t.dateTime = new Date(e.at).toISOString();
  const badge = el.querySelector(".badge");
  badge.textContent = e.streaming ? "Muse is replying…" : STATE[e.summaryState] || "";
  badge.dataset.state = e.streaming ? "streaming" : e.summaryState;
  const p = el.querySelector(".prompt");
  p.hidden = !e.prompt;
  p.querySelector("pre").textContent = e.prompt || "";
  el.querySelector(".raw pre").textContent = e.raw || (e.streaming ? "…" : "(empty)");
  el.querySelector(".summary pre").textContent =
    e.summary || e.note || (e.summaryState === "failed" ? "No summary was produced; the agent got none." : "…");
}

if (!token) {
  conn.textContent = "Missing token: open the URL from ~/.muse-bridge/viewer-url.";
} else {
  const es = new EventSource("/events?t=" + encodeURIComponent(token));
  es.addEventListener("snapshot", (ev) => {
    list.replaceChildren();
    nodes.clear();
    const all = JSON.parse(ev.data);
    for (const e of all) render(e);
    if (!all.length) list.textContent = "";
  });
  es.addEventListener("entry", (ev) => render(JSON.parse(ev.data)));
  es.onopen = () => { conn.textContent = "Live"; conn.dataset.ok = "1"; };
  es.onerror = () => { conn.textContent = "Disconnected — retrying (is the bridge running?)"; conn.dataset.ok = ""; };
}
`;

const PAGE_CSS = `:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc;
  --raw: #fff8ef; --raw-line: #f0d9b5; --sum: #f1f6ff; --sum-line: #c9d9f5; --warn: #9a5b00; --ok: #2f7a3e;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #a09f98; --line: #34332f;
    --raw: #2a2219; --raw-line: #5a4426; --sum: #1a2230; --sum-line: #2f4366; --warn: #f0b35a; --ok: #74c487;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #a09f98; --line: #34332f;
  --raw: #2a2219; --raw-line: #5a4426; --sum: #1a2230; --sum-line: #2f4366; --warn: #f0b35a; --ok: #74c487;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
header, main { max-width: 1280px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 24px; padding-bottom: 8px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { margin: 0; color: var(--muted); }
.conn { margin: 8px 0 0; font-size: 13px; color: var(--warn); }
.conn[data-ok="1"] { color: var(--ok); }
main:empty::before { content: "No Muse activity yet. Replies appear here as the bridge receives them."; color: var(--muted); display: block; padding: 32px 0; }
.entry { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin: 16px 0; }
.meta { display: flex; gap: 12px; align-items: baseline; font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.kind { font-weight: 600; color: var(--text); }
.badge { margin-left: auto; }
.badge[data-state="streaming"], .badge[data-state="running"] { color: var(--warn); }
.badge[data-state="done"] { color: var(--ok); }
.badge[data-state="failed"] { color: var(--warn); font-weight: 600; }
.prompt { margin-bottom: 10px; }
.label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
section { border-radius: 8px; padding: 10px 12px; min-width: 0; }
.raw { background: var(--raw); border: 1px solid var(--raw-line); }
.summary { background: var(--sum); border: 1px solid var(--sum-line); }
h2 { font-size: 13px; margin: 0 0 6px; }
.warn { font-weight: 500; color: var(--warn); margin-left: 6px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 70vh; overflow-y: auto; }
`;
