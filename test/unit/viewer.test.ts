import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "muse-viewer-"));
process.env.MUSE_HOME = home;
process.env.MUSE_VIEWER_PORT = "0";
const { addEntry, startViewer, updateEntry } = await import("../../src/viewer.js");

startViewer();
const urlFile = join(home, "viewer-url");
for (let i = 0; i < 50; i++) {
  try {
    readFileSync(urlFile);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}
const viewerUrl = new URL(readFileSync(urlFile, "utf8").trim());
const token = new URLSearchParams(viewerUrl.hash.slice(1)).get("t")!;
const port = Number(viewerUrl.port);

/** Raw HTTP GET so the Host header can be set freely. */
function get(path: string, host = `127.0.0.1:${port}`, readMs = 0): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      const done = () => resolve({ status: res.statusCode!, headers: res.headers, body });
      if (readMs) setTimeout(() => (req.destroy(), done()), readMs);
      else res.on("end", done);
    });
    req.on("error", reject);
    req.end();
  });
}

test("URL and token files are owner-only; the token is in the fragment, not the path or query", () => {
  assert.equal(statSync(urlFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "viewer-token")).mode & 0o777, 0o600);
  assert.equal(viewerUrl.hostname, "127.0.0.1");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(viewerUrl.search, "");
});

test("the page shell is served with a strict CSP", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-security-policy"]), /default-src 'none'; script-src 'self'/);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.doesNotMatch(r.body, new RegExp(token), "the shell never embeds the token");
});

test("events need the token", async () => {
  assert.equal((await get("/events")).status, 403);
  assert.equal((await get("/events?t=" + "0".repeat(64))).status, 403);
});

test("a foreign Host header is rejected (DNS rebinding)", async () => {
  assert.equal((await get("/", `evil.example:${port}`)).status, 421);
  assert.equal((await get(`/events?t=${token}`, `evil.example:${port}`)).status, 421);
});

test("events stream a snapshot with raw text and summary", async () => {
  const e = addEntry("send", { prompt: "P", streaming: true });
  updateEntry(e, { raw: "<img src=x onerror=alert(1)>", streaming: false, summaryState: "done", summary: "S" });
  const r = await get(`/events?t=${token}`, undefined, 200);
  assert.equal(r.status, 200);
  const snap = JSON.parse(r.body.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  const got = snap.find((x: { id: number }) => x.id === e.id);
  assert.equal(got.raw, "<img src=x onerror=alert(1)>");
  assert.equal(got.summary, "S");
});

test("the page renders Muse text as text, never HTML", async () => {
  const js = (await get("/app.js")).body;
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});
