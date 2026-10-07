import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A fake `claude` that floods stdout, to check the output cap without calling the real CLI.
const dir = mkdtempSync(join(tmpdir(), "muse-isolated-"));
const fake = join(dir, "fake-claude");
writeFileSync(fake, "#!/bin/sh\ncat >/dev/null\nyes 0123456789abcdef | head -c 20000000\n");
chmodSync(fake, 0o755);
process.env.MUSE_HOME = dir;
process.env.MUSE_CLAUDE_PATH = fake;
const { runIsolatedClaude } = await import("../../src/isolated.js");

test("a run that produces more output than allowed is killed and fails", async () => {
  await assert.rejects(runIsolatedClaude({ system: "s", input: "i", timeoutMs: 20_000 }), /output over \d+ bytes/);
});
