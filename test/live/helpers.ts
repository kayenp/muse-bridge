import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const serverPath = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));

export async function connect(env: Record<string, string> = {}): Promise<Client> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...merged, ...env }, stderr: "ignore" });
  const client = new Client({ name: "muse-bridge-test", version: "0" });
  await client.connect(transport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const content = res.content as { type: string; text: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
  return JSON.parse(content[0].text) as Record<string, any>;
}

/** muse_send, following a pending result with muse_wait until it finishes (Muse's agent replies can be slow). */
export async function sendFull(client: Client, args: Record<string, unknown>) {
  let r = await call(client, "muse_send", { wait_s: 110, ...args });
  for (let i = 0; i < 10 && r.status === "pending"; i++) r = await call(client, "muse_wait", { job_id: r.job_id, wait_s: 110 });
  return r;
}

export interface ViewerEntry {
  id: number;
  kind: "send" | "latest" | "transcript" | "error";
  prompt?: string;
  raw: string;
  summaryState: string;
  summary?: string;
}

/**
 * Tool results carry summaries only, so exact-text checks read the raw reply from the bridge's local viewer,
 * the same way the user does: the URL (with token) from MUSE_HOME/viewer-url, then the /events snapshot.
 */
export async function viewerEntries(): Promise<ViewerEntry[]> {
  const home = process.env.MUSE_HOME ?? join(homedir(), ".muse-bridge");
  const url = new URL(readFileSync(join(home, "viewer-url"), "utf8").trim());
  const token = new URLSearchParams(url.hash.slice(1)).get("t") ?? "";
  const ctrl = new AbortController();
  const res = await fetch(new URL(`/events?t=${token}`, url), { signal: ctrl.signal });
  const reader = res.body!.getReader();
  let buf = "";
  try {
    while (!buf.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
  } finally {
    ctrl.abort();
  }
  const data = buf.split("\n").find((l) => l.startsWith("data: "));
  return data ? (JSON.parse(data.slice(6)) as ViewerEntry[]) : [];
}

/** Raw text of the newest viewer entry of a kind. */
export async function lastRaw(kind: ViewerEntry["kind"]): Promise<string> {
  const e = (await viewerEntries()).filter((x) => x.kind === kind).at(-1);
  assert.ok(e, `no ${kind} entry in the viewer`);
  return e.raw;
}

/** No field that carries raw Muse text may reach the agent. */
export function assertNoRaw(r: Record<string, unknown>): void {
  for (const k of ["text", "text_so_far", "turns"]) assert.equal(r[k], undefined, `raw field ${k} leaked: ${JSON.stringify(r)}`);
}
