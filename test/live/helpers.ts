import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
