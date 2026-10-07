import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { chromiumLaunch } from "../../src/browser.js";
import { load } from "./load.js";
import { chromium, type Browser, type Page } from "playwright";
import { BridgeError } from "../../src/errors.js";
import { matchesPrompt, sendAndWait } from "../../src/reply.js";

const html = readFileSync(new URL("../../../test/fixtures/fake-chat.html", import.meta.url), "utf8");
let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch(chromiumLaunch());
});
after(() => browser.close());
beforeEach(async () => {
  page = await browser.newPage();
  await load(page, html);
});
const scenario = (s: string) => page.evaluate((x) => ((window as unknown as { scenario: string }).scenario = x), s);
const opts = { timeoutMs: 20_000, includeReasoning: false };

test("returns the full reply after the stop indicator goes away, without page UI", async () => {
  const out = await sendAndWait(page, "hello", opts);
  assert.equal(out.text, "reply to: hello");
  assert.equal(out.warning, undefined);
});

test("a thinking pause with the indicator still showing does not end the wait", async () => {
  await scenario("thinkPause");
  const out = await sendAndWait(page, "hard question", opts);
  assert.equal(out.text, "thinking done");
});

test("timeout returns partial text and clicks stop", async () => {
  await scenario("slow");
  await assert.rejects(sendAndWait(page, "essay", { ...opts, timeoutMs: 2000 }), (e: BridgeError) => {
    assert.equal(e.code, "TIMEOUT");
    assert.equal(e.extra.partial, true);
    assert.match(String(e.extra.text), /^w0 w1/);
    return true;
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('button[aria-label*="stop" i]').count(), 0, "stop button should be gone after clicking it");
});

test("an error that appears mid-reply ends the wait with its own code", async () => {
  await scenario("error");
  await assert.rejects(sendAndWait(page, "x", opts), (e: BridgeError) => {
    assert.equal(e.code, "NETWORK_ERROR");
    assert.match(e.message, /connection lost/);
    assert.equal(e.extra.text, "partial");
    return true;
  });
});

test("no indicator at all falls back to text stability, with a warning", async () => {
  await scenario("noIndicator");
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "instant answer");
  assert.match(out.warning ?? "", /No streaming indicator/);
});

test("multi-line prompt arrives as a single user turn", async () => {
  await sendAndWait(page, "line one\nline two", opts);
  const users = page.locator('[data-message-role="user"]');
  assert.equal(await users.count(), 1);
  assert.equal(await users.first().locator("p").textContent(), "line one\nline two");
});

test("a reply split across several messages with one turn id is returned whole", async () => {
  await scenario("multiPart");
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "part one\n\npart two");
});

test("composer Stop vanishing before the text arrives does not end the wait early", async () => {
  await scenario("earlyStopGone");
  const out = await sendAndWait(page, "hello", opts);
  assert.equal(out.text, "reply to: hello");
});

test("an agent task still running after the text pauses keeps the wait open", async () => {
  await scenario("agentTask");
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "checking\n\nresult");
  assert.equal(out.agentBusy, undefined, "the task had finished by the time the reply settled");
});

test("an agent task that outlives the text returns after the agent settle window, flagged agentBusy", async () => {
  await scenario("agentLongTask");
  const t0 = Date.now();
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "answer");
  assert.equal(out.agentBusy, true);
  assert.ok(Date.now() - t0 < 12_000, "must not wait for the task to finish");
});

test("a reply that is stopped before any text appears returns NO_REPLY", async () => {
  await scenario("stoppedNoReply");
  await assert.rejects(sendAndWait(page, "x", opts), (e: BridgeError) => {
    assert.equal(e.code, "NO_REPLY");
    return true;
  });
});

test("a typing placeholder that comes back after the text returns after the agent settle window, flagged agentBusy", async () => {
  await scenario("typingAfterText");
  const t0 = Date.now();
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "answer");
  assert.equal(out.agentBusy, true);
  assert.ok(Date.now() - t0 < 10_000, "must not wait for the placeholder to go away");
});

test("a tool call between two parts of a reply, shorter than the agent settle window, keeps the wait open", async () => {
  await scenario("toolGap");
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "part one\n\npart two");
  assert.equal(out.agentBusy, undefined);
});

test("the composer Stop dropping out for one poll does not end the wait early", async () => {
  await scenario("stopFlicker");
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "first\n\nsecond");
});

test("a streaming flag stuck on static text returns after the stall bound, with a warning", async () => {
  await scenario("stuckStreaming");
  const t0 = Date.now();
  const out = await sendAndWait(page, "x", { ...opts, stallMs: 2000 });
  assert.equal(out.text, "stuck reply");
  assert.match(out.warning ?? "", /had not changed/);
  assert.ok(Date.now() - t0 < 8000);
});

test("an older reply left flagged as streaming does not hold up the new one", async () => {
  await page.evaluate(() => {
    const w = window as unknown as { assistantMsg: (id: string) => HTMLElement };
    w.assistantMsg("old").querySelector("p")!.textContent = "old reply";
  });
  const out = await sendAndWait(page, "hello", opts);
  assert.equal(out.text, "reply to: hello");
});

test("chat history that renders after the send is not mistaken for the reply", async () => {
  await scenario("lateHistory");
  const out = await sendAndWait(page, "hello", opts);
  assert.equal(out.text, "reply to: hello");
});

test("late history holding the same prompt does not pass for the new one", async () => {
  await scenario("lateHistorySamePrompt");
  const out = await sendAndWait(page, "hello", opts);
  assert.equal(out.text, "reply to: hello");
});

test("a reply with no readable text finishes with a warning instead of timing out", async () => {
  await scenario("cardOnly");
  const t0 = Date.now();
  const out = await sendAndWait(page, "x", opts);
  assert.equal(out.text, "");
  assert.match(out.warning ?? "", /no readable text/);
  assert.ok(Date.now() - t0 < 10_000);
});

test("prompt matching ignores markdown, spacing and a cut-short display", () => {
  assert.ok(matchesPrompt("Reply with exactly: PONG", "Reply with *exactly*:\n  PONG"));
  assert.ok(matchesPrompt("Critique this plan: Plan: muse-bridge", "Critique this plan: Plan: muse-bridge, with many more details after this"));
  assert.ok(!matchesPrompt("hi", "hi there"), "a short prefix is too weak to count as a match");
  assert.ok(!matchesPrompt("an older question", "hello"));
});
