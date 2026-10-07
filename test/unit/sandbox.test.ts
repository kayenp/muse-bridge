import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.MUSE_HOME = mkdtempSync(join(tmpdir(), "muse-sandbox-test-"));
const { planExport, readManifest, writeExport } = await import("../../src/codeExport.js");
const { loadExport } = await import("../../src/exportReview.js");
const { classify, LIMITS, parseStatus, runSandboxed, sandboxArgs, scopeArgs } = await import("../../src/sandbox.js");
type Limits = typeof LIMITS;

test("bwrap arguments: no network, empty env, read-only system, extras must be absolute", () => {
  const args = sandboxArgs("/tmp/ws", ["/opt/node/bin"], ["python3", "t.py"]);
  for (const flag of ["--unshare-all", "--clearenv", "--new-session", "--die-with-parent"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-3), ["--", "python3", "t.py"]);
  assert.equal(args[args.indexOf("PATH") + 1], "/opt/node/bin:/usr/local/bin:/usr/bin:/bin");
  assert.throws(() => sandboxArgs("/tmp/ws", ["relative/dir"], ["true"]), /absolute/);
});

test("the scope caps tasks and memory with swap off", () => {
  const args = scopeArgs(LIMITS);
  assert.ok(args.includes(`TasksMax=${LIMITS.tasks}`));
  assert.ok(args.includes(`MemoryMax=${LIMITS.memoryBytes}`));
  assert.ok(args.includes("MemorySwapMax=0"), "without it, going over MemoryMax just swaps");
});

test("bwrap status and outcome: only an exit-code means the command ran and exited", () => {
  assert.deepEqual(parseStatus('{ "child-pid": 12 }\n{ "exit-code": 7 }\n'), { created: true, exitCode: 7 });
  assert.deepEqual(parseStatus('{ "child-pid": 12, "net-namespace": 1 }\n'), { created: true, exitCode: null });
  assert.deepEqual(parseStatus("garbage {not json}"), { created: false, exitCode: null });
  assert.equal(classify({ created: true, exitCode: 0 }, false, null), "exited");
  assert.equal(classify({ created: true, exitCode: null }, true, "SIGKILL"), "timed-out");
  assert.equal(classify({ created: true, exitCode: null }, false, "SIGTERM"), "killed");
  assert.equal(classify({ created: true, exitCode: null }, false, null), "not-started", "setup failed after the child was created");
  assert.equal(classify({ created: false, exitCode: null }, false, null), "not-started");
});

/** Export one Python file and run it in the sandbox, from the verified contents as sandbox-run does. */
async function run(source: string, opts: { timeoutS?: number; readOnly?: string[]; limits?: Limits; noScope?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "muse-exports-"));
  const out = writeExport(planExport([{ language: "python", code: source }]), { replyId: 1, key: source }, root);
  const files = loadExport(out.dir, readManifest(out.dir).files);
  const r = await runSandboxed(files, ["python3", "block-01.py"], { timeoutS: 20, ...opts });
  return { ...r, dir: out.dir };
}

test("the command's own exit code is reported, distinct from a sandbox that failed to start", async () => {
  const ok = await run("import sys\nsys.exit(7)");
  assert.equal(ok.outcome, "exited");
  assert.equal(ok.code, 7);
  const segv = await run("import os, signal\nos.kill(os.getpid(), signal.SIGSEGV)");
  assert.equal(segv.outcome, "exited");
  assert.equal(segv.code, 128 + 11, "a signal death is the command's exit, not a sandbox failure");
  const broken = await run("print('never runs')", { readOnly: ["/definitely/not/a/real/path"] });
  assert.equal(broken.outcome, "not-started");
  assert.equal(broken.code, null);
  assert.match(broken.output, /bwrap: /);
  assert.doesNotMatch(broken.output, /never runs/);
});

test("a run past its time limit is killed, really dies, and is reported as timed out", async () => {
  // A distinctive sleep length, so we can look for any process left behind afterwards.
  const r = await run("import time\ntime.sleep(31.4159)", { timeoutS: 2 });
  assert.equal(r.outcome, "timed-out");
  assert.equal(r.code, null);
  await new Promise((ok) => setTimeout(ok, 500));
  const left = spawnSync("pgrep", ["-f", "time.sleep\\(31.4159\\)"]).stdout.toString().trim();
  assert.equal(left, "", "no sandboxed process survives the timeout");
});

test("per-process limits: memory and file size", async () => {
  const mem = await run("try:\n    b = bytearray(6 * 1024**3)\n    print('ALLOCATED')\nexcept MemoryError:\n    print('memory limited')");
  assert.match(mem.output, /memory limited/);
  const big = await run(
    "import signal\nsignal.signal(signal.SIGXFSZ, signal.SIG_IGN)\ntry:\n    open('/tmp/big', 'wb').write(b'x' * (300 * 1024**2))\n" +
      "    print('WROTE')\nexcept OSError:\n    print('file size limited')",
  );
  assert.match(big.output, /file size limited/);
});

test("the scope stops a fork bomb at the task limit", async () => {
  const r = await run(
    "import os, time\nn = 0\ntry:\n    for _ in range(1000):\n        if os.fork() == 0:\n            time.sleep(5)\n            os._exit(0)\n" +
      "        n += 1\nexcept OSError:\n    pass\nprint('forked', n)",
    { limits: { ...LIMITS, tasks: 32 } },
  );
  const forked = Number(/forked (\d+)/.exec(r.output)?.[1]);
  assert.ok(forked > 0 && forked < 32, `forked ${forked}`);
});

test("the scope's whole-tree memory limit kills the run, reported as killed, not as not-started", async () => {
  // Four processes of ~200 MB each stay under the per-process limit but not the 512 MB tree limit.
  const r = await run(
    "import os, time\nfor _ in range(3):\n    if os.fork() == 0:\n        break\nb = bytearray(200 * 1024**2)\nb[::4096] = b'x' * len(b[::4096])\ntime.sleep(10)",
    { limits: { ...LIMITS, memoryBytes: 512 * 1024 ** 2 } },
  );
  assert.equal(r.outcome, "killed", r.output);
});

test("code in the sandbox has no network", async () => {
  const r = await run(
    "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=3)\n    print('NETWORK')\n" +
      "except OSError as e:\n    print('blocked', type(e).__name__)",
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /^blocked/);
});

test("code in the sandbox sees no environment, no home folder, and only its own copy", async () => {
  process.env.MUSE_SANDBOX_TEST_SECRET = "s3cret";
  const source =
    "import os\nprint(sorted(os.environ))\n" +
    `print(os.path.exists(${JSON.stringify(homedir())}))\n` +
    "open('block-01.py', 'a').write('# appended')\nprint(os.getcwd())";
  const r = await run(source);
  delete process.env.MUSE_SANDBOX_TEST_SECRET;
  assert.equal(r.code, 0, r.output);
  const [env, home, cwd] = r.output.trim().split("\n");
  assert.equal(env, "['HOME', 'LANG', 'PATH', 'PWD']", "PWD=/work comes from --chdir; nothing else");
  assert.equal(home, "False");
  assert.equal(cwd, "/work");
  assert.equal(readFileSync(join(r.dir, "block-01.py"), "utf8"), source, "the export itself is untouched");
});

test("writes outside /work and /tmp fail", async () => {
  const r = await run("try:\n    open('/usr/x', 'w')\n    print('WROTE')\nexcept OSError:\n    print('read-only')");
  assert.match(r.output, /read-only/);
});

test("without the scope (--no-scope-limits), per-process limits still apply", async () => {
  const r = await run("import sys\nsys.exit(3)", { noScope: true });
  assert.equal(r.outcome, "exited");
  assert.equal(r.code, 3);
});
