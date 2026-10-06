export interface ExtractOptions {
  strip: string;
  reasoning: string;
  card: string;
  includeReasoning: boolean;
}

/**
 * Runs in the page (passed to locator.evaluate, so it must be self-contained).
 *
 * Clones a turn container, removes page UI, turns code blocks into fenced markdown and non-text items into
 * placeholder lines, then reads innerText from an off-screen copy so line breaks follow the real layout.
 */
export function extractTurnText(el: Element, o: ExtractOptions): string {
  const clone = el.cloneNode(true) as HTMLElement;
  const doc = el.ownerDocument;

  const replaceWith = (node: Element, text: string, block = true) => {
    const r = doc.createElement(block ? "div" : "span");
    r.textContent = text;
    node.replaceWith(r);
  };

  // Reasoning first: its own buttons/summary would otherwise be stripped and leave loose text behind.
  clone.querySelectorAll(o.reasoning).forEach((r) => {
    if (o.includeReasoning) {
      const body = (r.textContent ?? "").trim();
      replaceWith(r, body ? `[reasoning]\n${body}\n[/reasoning]` : "");
    } else {
      r.remove();
    }
  });

  // Code blocks -> fenced markdown. A <pre> holds whitespace exactly, so innerText keeps it.
  clone.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code") ?? pre;
    const langClass = Array.from(code.classList).find((c) => c.startsWith("language-"));
    const label =
      pre.closest("[data-language]")?.getAttribute("data-language") ?? (langClass ? langClass.slice(9) : "");
    const body = (code.textContent ?? "").replace(/\n$/, "");
    const fenced = doc.createElement("pre");
    fenced.textContent = "```" + label + "\n" + body + "\n```";
    pre.replaceWith(fenced);
  });

  // Non-text content -> placeholders, before stripping (cards may contain buttons).
  clone.querySelectorAll(o.card).forEach((c) => {
    const title =
      c.querySelector("h1,h2,h3,h4,[role=heading]")?.textContent?.trim() ||
      c.getAttribute("aria-label") ||
      (c.textContent ?? "").trim().slice(0, 80);
    replaceWith(c, `[card: ${title}]`);
  });
  clone.querySelectorAll("img").forEach((img) => {
    replaceWith(img, `[image: ${img.getAttribute("alt") || "untitled"}]`);
  });
  clone.querySelectorAll("video").forEach((v) => replaceWith(v, `[video: ${v.getAttribute("aria-label") || "untitled"}]`));
  clone.querySelectorAll("a[download]").forEach((a) => {
    replaceWith(a, `[attachment: ${a.getAttribute("download") || a.textContent?.trim() || "file"}]`);
  });

  clone.querySelectorAll(o.strip).forEach((n) => n.remove());

  // Muse sets content-visibility:auto on code blocks; off-screen that skips rendering and innerText comes back empty.
  [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))].forEach((e) => {
    if (e.style?.contentVisibility) e.style.contentVisibility = "visible";
  });

  const holder = doc.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;width:900px;opacity:0;pointer-events:none;";
  holder.appendChild(clone);
  doc.body.appendChild(holder);
  try {
    return clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    holder.remove();
  }
}
