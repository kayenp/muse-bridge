import assert from "node:assert/strict";
import { test } from "node:test";
import { createJob, lock, waitFor } from "../../src/queue.js";

test("jobs run one at a time in FIFO order and report busy/depth", async () => {
  const events: string[] = [];
  const mk = (name: string) =>
    createJob(name, async () => {
      events.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 100));
      events.push(`end ${name}`);
      return { status: "done", text: name };
    });
  const a = mk("A");
  const b = mk("B");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lock.busy, true);
  assert.equal(lock.depth, 1);
  assert.equal(b.status, "queued");
  const [ra, rb] = await Promise.all([a.finished, b.finished]);
  assert.deepEqual([ra.text, rb.text], ["A", "B"]);
  assert.deepEqual(events, ["start A", "end A", "start B", "end B"]);
  assert.equal(lock.busy, false);
});

test("waitFor returns null while pending, then the result", async () => {
  const j = createJob("slow", async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { status: "done", text: "ok" };
  });
  assert.equal(await waitFor(j, 20), null);
  assert.equal((await waitFor(j, 1000))?.text, "ok");
});
