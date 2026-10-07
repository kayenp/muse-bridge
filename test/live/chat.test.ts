// Needs a logged-in profile (`npm run login`) and the MCP server NOT already running on that profile.
// Runs against the real muse.ai, sequentially, through the real MCP server, and calls `claude -p` for summaries.
// Tool results carry summaries only; exact-text checks read the raw reply from the local viewer.
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { after, before, test } from "node:test";
import { assertNoRaw, call, connect, lastRaw, sendFull } from "./helpers.js";

let c: Client;
let skip: string | false = false;
before(async () => {
  c = await connect();
  await call(c, "muse_read_latest"); // launches the browser
  const s = await call(c, "muse_status");
  if (s.session !== "ok") skip = `not logged in (session=${s.session}); run npm run login`;
});
after(() => c?.close());

const UI_JUNK = /\b(Copy|Share|Like|Dislike|Regenerate)\b|\d{1,2}:\d{2}/;

test("1. happy path: exact reply, no page UI", async (t) => {
  if (skip) return t.skip(skip);
  const r = await sendFull(c, { prompt: "Reply with exactly: PONG", new_chat: true });
  assert.equal(r.status, "done", JSON.stringify(r));
  assertNoRaw(r);
  assert.match(r.summary, /PONG/);
  assert.ok(r.untrusted, "summaries stay marked untrusted");
  const raw = await lastRaw("send");
  assert.equal(raw.trim(), "PONG");
  assert.doesNotMatch(raw, UI_JUNK);
});

test("2+3. context persists within a chat; a new chat starts an empty thread", async (t) => {
  if (skip) return t.skip(skip);
  // Muse keeps a memory file that spans threads, so a new thread is not guaranteed to have forgotten things.
  // This checks thread-level isolation (the new thread's transcript holds only the new exchange), not memory.
  await sendFull(c, { prompt: "For this conversation only, my test token is ZEBRA-42. Do not save it to memory. Reply only with OK.", new_chat: true });
  const same = await sendFull(c, { prompt: "What test token did I just give you? Reply with just the token." });
  assert.match(same.summary, /ZEBRA-42/, JSON.stringify(same));
  const fresh = await sendFull(c, { prompt: "Reply with exactly: FRESH", new_chat: true });
  assert.equal(fresh.status, "done", JSON.stringify(fresh));
  const tr = await call(c, "muse_read_transcript", { limit: 50 });
  assertNoRaw(tr);
  assert.equal(tr.turn_count, 2);
  assert.equal(await lastRaw("transcript"), "[user]\nReply with exactly: FRESH\n\n[assistant]\nFRESH");
});

test("4. long reasoning reply is not cut short", async (t) => {
  if (skip) return t.skip(skip);
  const r = await call(c, "muse_send", {
    prompt: "Think step by step: what is 17 * 23 * 31? Show your working, then end with the line FINAL: <number>.",
    new_chat: true,
    wait_s: 110,
  });
  const done = r.status === "pending" ? await call(c, "muse_wait", { job_id: r.job_id, wait_s: 110 }) : r;
  assert.equal(done.status, "done", JSON.stringify(done));
  assertNoRaw(done);
  assert.match(done.summary, /12,?121/);
  const sent = await lastRaw("send");
  assert.match(sent, /FINAL:\s*12,?121/);
  const latest = await call(c, "muse_read_latest");
  assertNoRaw(latest);
  assert.equal(await lastRaw("latest"), sent, "text at completion must equal the settled page text");
});

test("5. timeout returns partial text, stops generation, next send works", async (t) => {
  if (skip) return t.skip(skip);
  const r = await call(c, "muse_send", { prompt: "Write a 2000-word essay on the history of rivers.", new_chat: true, job_timeout_s: 3, wait_s: 30 });
  // A partial reply gets summarized too; if that fails, the Muse error is kept as muse_error.
  assert.ok(r.error === "TIMEOUT" || r.muse_error === "TIMEOUT", JSON.stringify(r));
  assert.equal(r.partial, true);
  assertNoRaw(r);
  const next = await sendFull(c, { prompt: "Reply with exactly: AFTER" });
  assert.match(next.summary, /AFTER/);
  assert.equal((await lastRaw("send")).trim(), "AFTER");
});

test("6. async path: pending then muse_wait", async (t) => {
  if (skip) return t.skip(skip);
  const r = await call(c, "muse_send", { prompt: "List 40 river names, one per line.", new_chat: true, wait_s: 1 });
  assert.equal(r.status, "pending");
  assertNoRaw(r);
  const busy = await call(c, "muse_read_transcript");
  assert.equal(busy.error, "BUSY", "reads must fail fast while a send runs, not queue behind it");
  let w = r;
  for (let i = 0; i < 10 && w.status === "pending"; i++) w = await call(c, "muse_wait", { job_id: r.job_id, wait_s: 30 });
  assert.equal(w.status, "done", JSON.stringify(w));
  assertNoRaw(w);
  assert.ok((await lastRaw("send")).split("\n").length >= 20);
});

test("7. concurrent sends are serialized", async (t) => {
  if (skip) return t.skip(skip);
  await call(c, "muse_new_chat");
  const a = sendFull(c, { prompt: "Reply with exactly: ALPHA" });
  const b = sendFull(c, { prompt: "Reply with exactly: BETA" });
  await new Promise((r) => setTimeout(r, 1500));
  const s = await call(c, "muse_status");
  assert.equal(s.busy, true);
  assert.ok(s.queue_depth >= 1, JSON.stringify(s));
  const [ra, rb] = await Promise.all([a, b]);
  assert.match(ra.summary, /ALPHA/);
  assert.match(rb.summary, /BETA/);
  await call(c, "muse_read_transcript", { limit: 10 });
  assert.equal(
    await lastRaw("transcript"),
    "[user]\nReply with exactly: ALPHA\n\n[assistant]\nALPHA\n\n[user]\nReply with exactly: BETA\n\n[assistant]\nBETA",
  );
});

test("8. forced selector failure names the broken key", async (t) => {
  if (skip) return t.skip(skip);
  await c.close();
  const bad = await connect({ MUSE_SELECTOR_OVERRIDES: JSON.stringify({ assistantTurn: "#nope", sendButton: "#nope-send" }) });
  try {
    const r = await call(bad, "muse_send", { prompt: "Reply with exactly: X", new_chat: true });
    assert.equal(r.error, "SELECTOR_MISSING", JSON.stringify(r));
    assert.equal(r.key, "sendButton");
    assert.ok(r.screenshot, "a screenshot path should be returned");
  } finally {
    await bad.close();
    c = await connect();
  }
});
