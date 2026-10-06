#!/usr/bin/env node
import "./guard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser } from "./browser.js";
import { log } from "./log.js";
import { errorResult, newChat, readyPage, startLogin, status } from "./muse.js";
import { createJob, currentJob, getJob, lock, waitFor, type Job, type JobResult } from "./queue.js";
import { extractReply, sendAndWait } from "./reply.js";
import { count, sel } from "./selectors.js";
import { readTranscript } from "./transcript.js";
import { markUntrusted, UNTRUSTED_DESCRIPTION } from "./untrusted.js";

const server = new McpServer({ name: "muse-bridge", version: "1.0.0" });

type Result = Record<string, unknown>;
const reply = (r: Result) => ({
  content: [{ type: "text" as const, text: JSON.stringify(markUntrusted(r), null, 2) }],
  isError: r.status === "error",
});

/**
 * Run non-send page work under the lock, mapping thrown errors to structured results.
 * Sends queue, but reads and new-chat fail fast while a send runs: Muse's agent replies can take minutes,
 * and a read stuck behind one would exceed the client's tool timeout.
 */
const locked = (fn: () => Promise<Result>): Promise<Result> => {
  const job = currentJob();
  if (lock.busy || lock.depth > 0) {
    return Promise.resolve({
      status: "error",
      error: "BUSY",
      message: "A send is in progress. Use muse_wait with its job_id, or muse_read_latest for the partial reply.",
      current_job: job ? { job_id: job.id, status: job.status } : null,
      queue_depth: lock.depth,
    });
  }
  return lock.run(fn).catch(errorResult);
};

function jobView(job: Job, r: JobResult | null): Result {
  if (r) return { job_id: job.id, ...r };
  return { status: "pending", job_id: job.id, job_status: job.status, text_so_far: job.text || undefined };
}

server.registerTool(
  "muse_send",
  {
    description:
      "Send a prompt to the muse.ai chat and return its reply. Waits up to wait_s; if the reply is still " +
      "streaming after that, returns status 'pending' with a job_id — call muse_wait with it. " +
      "Calls are queued, so concurrent sends never interleave." +
      UNTRUSTED_DESCRIPTION,
    inputSchema: {
      prompt: z.string().min(1),
      new_chat: z.boolean().optional().describe("Start a fresh chat before sending (no earlier context)."),
      wait_s: z.number().min(0).max(110).optional().describe("How long to block before returning pending. Default 45."),
      job_timeout_s: z.number().min(1).max(1800).optional().describe("Give up on the reply after this long. Default 300."),
      include_reasoning: z.boolean().optional().describe("Include collapsible thinking/reasoning sections."),
    },
  },
  async ({ prompt, new_chat, wait_s = 45, job_timeout_s = 300, include_reasoning = false }) => {
    const job = createJob(prompt, async (j) => {
      try {
        const page = await readyPage();
        if (new_chat) await newChat(page);
        const out = await sendAndWait(page, prompt, {
          timeoutMs: job_timeout_s * 1000,
          includeReasoning: include_reasoning,
          onProgress: (t) => (j.text = t),
        });
        j.text = out.text;
        return {
          status: "done",
          text: out.text,
          ...(out.warning ? { warning: out.warning } : {}),
          ...(out.agentBusy
            ? {
                agent_busy: true,
                note: "Muse is still working in the background; more messages may follow. Check later with muse_read_latest.",
              }
            : {}),
        };
      } catch (err) {
        return (await errorResult(err)) as JobResult;
      }
    });
    return reply(jobView(job, await waitFor(job, wait_s * 1000)));
  },
);

server.registerTool(
  "muse_wait",
  {
    description: "Wait for a pending muse_send job. Returns done, error, or pending again." + UNTRUSTED_DESCRIPTION,
    inputSchema: { job_id: z.string(), wait_s: z.number().min(0).max(110).optional() },
  },
  async ({ job_id, wait_s = 45 }) => {
    const job = getJob(job_id);
    if (!job) return reply({ status: "error", error: "UNKNOWN_JOB", message: `No job ${job_id}` });
    return reply(jobView(job, await waitFor(job, wait_s * 1000)));
  },
);

server.registerTool(
  "muse_read_latest",
  {
    description:
      "Read the most recent Muse reply. While a send is in progress, returns that reply's partial text." +
      UNTRUSTED_DESCRIPTION,
    inputSchema: { include_reasoning: z.boolean().optional() },
  },
  async ({ include_reasoning = false }) => {
    const job = currentJob();
    if (job) return reply({ status: "pending", job_id: job.id, partial: true, text: job.text });
    return reply(
      await locked(async () => {
        const page = await readyPage();
        if ((await count(page, "assistantTurn")) === 0) return { status: "done", text: "", note: "No replies in this chat yet." };
        return { status: "done", text: await extractReply(page, page.locator(sel.assistantTurn).last(), include_reasoning) };
      }),
    );
  },
);

server.registerTool(
  "muse_read_transcript",
  {
    description: "Read the recent turns of the current Muse chat as [{role, text}], oldest first." + UNTRUSTED_DESCRIPTION,
    inputSchema: { limit: z.number().int().min(1).max(500).optional(), include_reasoning: z.boolean().optional() },
  },
  async ({ limit = 20, include_reasoning = false }) =>
    reply(
      await locked(async () => {
        const page = await readyPage();
        return { status: "done", turns: await readTranscript(page, limit, include_reasoning) };
      }),
    ),
);

server.registerTool(
  "muse_new_chat",
  { description: "Start a new, empty Muse chat. Later sends have no memory of the previous chat." },
  async () =>
    reply(
      await locked(async () => {
        await newChat(await readyPage());
        return { status: "done" };
      }),
    ),
);

server.registerTool(
  "muse_status",
  {
    description:
      "Session and queue state: session (ok | logged_out | logging_in | unknown), busy, queue_depth, current job. " +
      "Never waits for the queue.",
  },
  async () => {
    const job = currentJob();
    const s = await status().catch(errorResult);
    return reply({
      ...s,
      current_job: job ? { job_id: job.id, status: job.status, elapsed_s: Math.round((Date.now() - job.startedAt) / 1000) } : null,
    });
  },
);

server.registerTool(
  "muse_login",
  {
    description:
      "Open a visible browser window on muse.ai so the user can log in. Returns immediately; poll muse_status " +
      "until session is ok. Use when a tool returned LOGGED_OUT.",
  },
  async () => reply(startLogin()),
);

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.stdin.on("close", () => void closeBrowser().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
log.info("muse-bridge MCP server ready");

