import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

// Keep the bridge's state dirs out of the real ~/.muse-bridge.
process.env.MUSE_HOME = mkdtempSync(join(tmpdir(), "muse-export-"));
const { chromiumLaunch } = await import("../../src/browser.js");
const { load } = await import("./load.js");
const { BridgeError } = await import("../../src/errors.js");
const { MAX_BLOCK_BYTES, MAX_BLOCKS, planExport, pruneExports, readCodeBlocks, replyKey, suggestedPath, writeExport, cleanLanguage } =
  await import("../../src/codeExport.js");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const code = (err: unknown) => (err instanceof BridgeError ? err.code : String(err));

test("names files itself and records hashes, sizes and languages", () => {
  const plan = planExport([
    { language: "python", code: "print('hi')\nprint('bye')" },
    { language: "", code: "plain" },
    { language: "TypeScript", code: "" },
  ]);
  assert.deepEqual(plan.files.map((f) => f.file), ["block-01.py", "block-02.txt", "block-03.ts"]);
  assert.equal(plan.files[0].lines, 2);
  assert.equal(plan.files[2].lines, 0);
  assert.equal(plan.files[0].sha256, sha("print('hi')\nprint('bye')"));
  assert.deepEqual(plan.contents, ["print('hi')\nprint('bye')", "plain", ""]);
});

test("odd language labels never reach a file name", () => {
  assert.equal(cleanLanguage("python"), "python");
  assert.equal(cleanLanguage("../../evil"), "");
  assert.equal(cleanLanguage("py thon"), "");
  assert.equal(planExport([{ language: "../../x", code: "a" }]).files[0].file, "block-01.txt");
});

test("fails closed on no code, too many blocks, or oversized code", () => {
  assert.throws(() => planExport([]), (e) => code(e) === "NO_CODE");
  const many = Array.from({ length: MAX_BLOCKS + 1 }, () => ({ language: "", code: "x" }));
  assert.throws(() => planExport(many), (e) => code(e) === "EXPORT_TOO_LARGE");
  assert.throws(() => planExport([{ language: "", code: "x".repeat(MAX_BLOCK_BYTES + 1) }]), (e) => code(e) === "EXPORT_TOO_LARGE");
  const big = Array.from({ length: 9 }, () => ({ language: "", code: "x".repeat(MAX_BLOCK_BYTES) }));
  assert.throws(() => planExport(big), (e) => code(e) === "EXPORT_TOO_LARGE");
});

test("a suggested path is only kept if it is a safe relative path", () => {
  assert.deepEqual(suggestedPath("# path: src/app.py\nprint(1)"), { path: "src/app.py" });
  assert.deepEqual(suggestedPath("// file: lib/a.ts"), { path: "lib/a.ts" });
  assert.deepEqual(suggestedPath("<!-- filename: docs/x.md -->"), { path: "docs/x.md" });
  for (const bad of ["../../.bashrc", "/etc/passwd", "a//b", "a/./b", "-rf", "a b", "src/$(id).py", "x".repeat(201)]) {
    assert.deepEqual(suggestedPath(`# path: ${bad}`), bad.includes(" ") ? { path: "a" } : { rejected: true }, bad);
  }
  assert.deepEqual(suggestedPath("print('no path comment')"), {});
  const plan = planExport([{ language: "sh", code: "# path: ../../.bashrc\necho hi" }]);
  assert.equal(plan.files[0].suggested_path, undefined);
  assert.equal(plan.files[0].suggested_path_rejected, true);
});

test("writes owner-only files and reuses an identical export of the same reply", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-exports-"));
  const plan = planExport([{ language: "py", code: "a = 1" }]);
  const key = replyKey("https://muse.ai/thread/1", ["m1", "m2"]);
  const first = writeExport(plan, { replyId: 7, key }, root);
  assert.equal(first.reused, false);
  assert.equal(readFileSync(join(first.dir, "block-01.py"), "utf8"), "a = 1");
  assert.equal(statSync(first.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(first.dir, "block-01.py")).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.reply_id, 7);
  assert.equal(manifest.files[0].sha256, sha("a = 1"));

  const again = writeExport(plan, { replyId: 7, key }, root);
  assert.equal(again.reused, true);
  assert.equal(again.dir, first.dir);
  const changed = writeExport(planExport([{ language: "py", code: "a = 2" }]), { replyId: 7, key }, root);
  assert.notEqual(changed.dir, first.dir);
  assert.equal(readdirSync(root).length, 2);
});

test("old exports are pruned; anything not provably ours is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-exports-"));
  const DAY = 86_400_000;
  const make = (name: string, daysAgo: number | null) => {
    mkdirSync(join(root, name));
    if (daysAgo !== null) {
      const at = new Date(Date.now() - daysAgo * DAY).toISOString();
      writeFileSync(join(root, name, "manifest.json"), JSON.stringify({ exported_at: at, files: [] }));
    }
  };
  make("20260101-000000-r1-aaaaaa", 31);        // old: pruned
  make("20260101-000000-r2-bbbbbb", 5);         // recent: kept
  make("my-notes", 90);                         // not named like an export: kept
  make("20260101-000000-r3-cccccc", null);      // no manifest: kept
  const outside = mkdtempSync(join(tmpdir(), "muse-outside-"));
  mkdirSync(join(outside, "t"));
  writeFileSync(join(outside, "t", "manifest.json"), JSON.stringify({ exported_at: "2020-01-01T00:00:00Z" }));
  symlinkSync(join(outside, "t"), join(root, "20260101-000000-r4-dddddd")); // symlink: kept, target untouched
  assert.deepEqual(pruneExports(root), ["20260101-000000-r1-aaaaaa"]);
  assert.deepEqual(readdirSync(root).sort(), ["20260101-000000-r2-bbbbbb", "20260101-000000-r3-cccccc", "20260101-000000-r4-dddddd", "my-notes"]);
  assert.ok(statSync(join(outside, "t", "manifest.json")).isFile());
});

// --------------------------------------------------------------------------- in the page

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch(chromiumLaunch());
  page = await browser.newPage();
});
after(() => browser.close());

const msg = (id: string, html: string) =>
  `<div data-message-item="true" data-message-role="assistant" data-message-id="${id}">${html}</div>`;

test("reads the page's code blocks exactly, without page UI, prose or reasoning", async () => {
  await load(
    page,
    msg("a1", `<p>Here you go:</p>
      <pre><button>Copy code</button><code class="language-python">def f():\n    return "\`\`\`"\n</code></pre>
      <details><summary>Thinking</summary><pre><code>secret scratch</code></pre></details>`) +
      msg("a2", `<div data-language="bash"><pre><code>echo "two"\n</code></pre></div><p>Done.</p>`) +
      msg("other", `<pre><code>not this reply</code></pre>`),
  );
  const blocks = await readCodeBlocks(page, ["a1", "a2"]);
  assert.deepEqual(blocks, [
    { language: "python", code: 'def f():\n    return "```"' },
    { language: "bash", code: 'echo "two"' },
  ]);
});

test("refuses nested code blocks and replies that aren't fully on the page", async () => {
  await load(page, msg("n1", `<pre><code>outer<pre>inner</pre></code></pre>`));
  await assert.rejects(readCodeBlocks(page, ["n1"]), (e) => code(e) === "EXPORT_AMBIGUOUS");
  await assert.rejects(readCodeBlocks(page, ["n1", "gone"]), (e) => code(e) === "REPLY_NOT_ON_PAGE");
  await assert.rejects(readCodeBlocks(page, []), (e) => code(e) === "REPLY_NOT_ON_PAGE");
});

// The live Muse structure (2026-10-07): see extract.test.ts.
const MUSE_CODE =
  `<pre class="language-python"><code>` +
  `<span class="block"><span>#</span><span> path: src/t.py</span></span>` +
  `<span class="block"><span>import</span><span> math</span></span>` +
  `<span class="block">\n</span>` +
  `<span class="block"><span>def</span><span> f</span><span>():</span></span>` +
  `<span class="block"><span>    return</span><span> 1</span></span>` +
  `</code></pre>`;
const MUSE_EXPECTED = "# path: src/t.py\nimport math\n\ndef f():\n    return 1";

test("exports Muse's one-span-per-line code with its line breaks, and a correct suggested path", async () => {
  await load(page, msg("m1", MUSE_CODE));
  const blocks = await readCodeBlocks(page, ["m1"]);
  assert.deepEqual(blocks, [{ language: "python", code: MUSE_EXPECTED }]);
  const plan = planExport(blocks);
  assert.equal(plan.files[0].lines, 5);
  assert.equal(plan.files[0].suggested_path, "src/t.py");
});

