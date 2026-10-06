// Runs without a login: an empty profile against the real site, through the real MCP server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { serverPath } from "./helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw JSON-RPC messages */

test("stdout carries only JSON-RPC, and an empty profile reports LOGGED_OUT everywhere", async () => {
  const home = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir(), "muse-empty-"));
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, MUSE_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const lines: string[] = [];
  const waiting = new Map<number, (v: any) => void>();
  createInterface({ input: proc.stdout! }).on("line", (line) => {
    lines.push(line);
    const msg = JSON.parse(line); // throws (fails the test) on any non-JSON stdout
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  const tool = async (name: string, args = {}) =>
    JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);

  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(tools, ["muse_login", "muse_new_chat", "muse_read_latest", "muse_read_transcript", "muse_send", "muse_status", "muse_wait"]);

    const before = await tool("muse_status");
    assert.equal(before.browser, "not_started");

    for (const [name, args] of [["muse_read_latest", {}], ["muse_send", { prompt: "hi" }], ["muse_new_chat", {}], ["muse_read_transcript", {}]] as const) {
      const r = await tool(name, args);
      assert.equal(r.error, "LOGGED_OUT", `${name}: ${JSON.stringify(r)}`);
      assert.match(r.hint, /muse_login/);
    }
    const after = await tool("muse_status");
    assert.equal(after.session, "logged_out");
    assert.equal(after.display, "xvfb");
    // Logged out lands back on the muse.ai landing page (e.g. /?aymh_complete=1), so the DOM decides, not the URL.
    assert.match(after.url, /muse\.ai|facebook\.com/, `unexpected url ${after.url}`);

    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  } finally {
    proc.kill("SIGTERM");
  }
});
