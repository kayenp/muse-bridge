import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromiumLaunch } from "../../src/browser.js";
import { load } from "./load.js";
import { chromium, type Browser, type Page } from "playwright";
import { extractTurn } from "../../src/reply.js";

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch(chromiumLaunch());
  page = await browser.newPage();
});
after(() => browser.close());

const turn = async (html: string) => {
  await load(page, `<div data-message-author-role="assistant">${html}</div>`);
  return page.locator('[data-message-author-role="assistant"]');
};

test("strips page UI around the reply", async () => {
  const t = await turn(`<p>Hello there.</p>
    <div role="toolbar"><button>Copy</button><button aria-label="Like">👍</button></div>
    <time>10:42</time><span aria-hidden="true">•</span>`);
  assert.equal(await extractTurn(t), "Hello there.");
});

test("keeps code as fenced markdown with its language", async () => {
  const t = await turn(`<p>Try:</p><pre><button>Copy code</button><code class="language-js">const a = 1;\n  if (a) {}\n</code></pre>`);
  assert.equal(await extractTurn(t), "Try:\n\n```js\nconst a = 1;\n  if (a) {}\n```");
});

test("non-text items become placeholders", async () => {
  const t = await turn(`<p>See</p><img alt="a red barn"><div data-testid="weather-card"><h3>Weather</h3><button>Open</button></div>
    <a download="report.pdf" href="#">report.pdf</a>`);
  const out = await extractTurn(t);
  assert.match(out, /\[image: a red barn\]/);
  assert.match(out, /\[card: Weather\]/);
  assert.match(out, /\[attachment: report\.pdf\]/);
  assert.doesNotMatch(out, /Open/);
});

test("reasoning is excluded by default and included on request", async () => {
  const t = await turn(`<details><summary>Thinking</summary>step one</details><p>Answer: 4</p>`);
  assert.equal(await extractTurn(t), "Answer: 4");
  assert.match(await extractTurn(t, true), /\[reasoning\][\s\S]*step one[\s\S]*Answer: 4/);
});

test("real muse.ai markup: user and assistant messages come out clean", async () => {
  const html = readFileSync(new URL("../../../test/fixtures/muse-real-turns.html", import.meta.url), "utf8");
  await load(page, html);
  const user = await extractTurn(page.locator('[data-message-role="user"]'));
  // The double space in the source collapses when rendered, as it does on screen.
  assert.equal(user, "Explain step by step how ariver delta forms, with a short code example in Python");

  const reply = await extractTurn(page.locator('[data-message-role="assistant"]'));
  assert.match(reply, /^Here's how it happens:/);
  assert.match(reply, /```python\n[\s\S]*print\(''\.join\(row\)\)\n```/);
  assert.match(reply, /bird-foot\.$/);
  // Page UI: action buttons, accessibility labels, code-block header and its copy/download buttons.
  assert.doesNotMatch(reply, /Copy|React|Reply|Download|Assistant message:|^python$/m);
});

// The live Muse structure (2026-10-07): one display:block span per line, no newline characters between them,
// a blank line as a span holding just "\n", line numbers from CSS counters (not in the DOM).
const MUSE_CODE =
  `<pre class="language-python"><code>` +
  `<span class="block"><span>#</span><span> path: src/t.py</span></span>` +
  `<span class="block"><span>import</span><span> math</span></span>` +
  `<span class="block">\n</span>` +
  `<span class="block"><span>def</span><span> f</span><span>():</span></span>` +
  `<span class="block"><span>    return</span><span> 1</span></span>` +
  `</code></pre>`;
const MUSE_EXPECTED = "# path: src/t.py\nimport math\n\ndef f():\n    return 1";

test("keeps line breaks in Muse's one-span-per-line code blocks", async () => {
  const t = await turn(MUSE_CODE);
  assert.equal(await extractTurn(t), "```python\n" + MUSE_EXPECTED + "\n```");
});

test("leaves highlighters that already have newlines between tokens alone", async () => {
  const t = await turn(`<pre><code class="language-js"><span>const</span> a = 1;\n<span>let</span> b;\n</code></pre>`);
  assert.equal(await extractTurn(t), "```js\nconst a = 1;\nlet b;\n```");
  const lines = await turn(`<pre><code class="language-js"><span class="line">a</span>\n<span class="line">b</span></code></pre>`);
  assert.equal(await extractTurn(lines), "```js\na\nb\n```");
});

