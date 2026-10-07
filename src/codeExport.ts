import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { config, PRIVATE_FILE_MODE } from "./config.js";
import { BridgeError } from "./errors.js";
import { cssString, MESSAGE_ID_ATTR, sel } from "./selectors.js";

/**
 * Exporting the code blocks of one Muse reply to files, for review and use outside the chat.
 *
 * This is the one deliberate path for Muse-written text to leave the viewer, so it is narrow and fails closed:
 *  - the reply is named by a bridge-assigned id (see replies.ts), never by anything Muse wrote;
 *  - only the page's own code blocks (<pre>) are taken, not fences parsed out of text, and no prose;
 *  - anything ambiguous (nested code blocks, the reply no longer on the page) or oversized is refused and
 *    nothing is written;
 *  - file names are assigned here (block-01.py, ...); a path Muse suggests is only recorded, after validation;
 *  - the tool result carries metadata only (names, languages, sizes, hashes). The code itself is shown to the
 *    user in the viewer.
 * This is a policy, not a mechanism: an agent with shell access can still read the exported files, review.md
 * or a sandbox log on purpose. What the bridge guarantees is that Muse's text never arrives unasked in a tool
 * result. The user's review of the diff before anything is committed is the real gate.
 */

export const MAX_BLOCKS = 50;
export const MAX_BLOCK_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface RawBlock {
  language: string;
  code: string;
}

export interface ExportedFile {
  file: string;
  language: string;
  lines: number;
  bytes: number;
  sha256: string;
  /** A relative path Muse suggested in the block's first line, if it passed validation. */
  suggested_path?: string;
  /** Muse suggested a path, but it was unsafe or malformed, so it was dropped. */
  suggested_path_rejected?: true;
}

export interface ExportPlan {
  files: ExportedFile[];
  contents: string[];
}

const EXTENSIONS: Record<string, string> = {
  python: "py", py: "py", typescript: "ts", ts: "ts", tsx: "tsx", javascript: "js", js: "js", jsx: "jsx",
  mjs: "mjs", cjs: "cjs", json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "txt", md: "md", markdown: "md", html: "html",
  css: "css", sql: "sql", go: "go", rust: "rs", rs: "rs", java: "java", kotlin: "kt", c: "c", h: "h",
  cpp: "cpp", "c++": "cpp", cs: "cs", csharp: "cs", rb: "rb", ruby: "rb", php: "php", swift: "swift",
  diff: "diff", patch: "diff", dockerfile: "dockerfile", makefile: "mk", xml: "xml", txt: "txt", text: "txt",
};

/** A language label from the page, reduced to a safe token ("" if it isn't one). */
export function cleanLanguage(raw: string): string {
  const s = raw.trim().toLowerCase();
  return /^[a-z0-9+#._-]{1,24}$/.test(s) ? s : "";
}

const PATH_COMMENT = /^\s*(?:#|\/\/|--|;|\/\*|<!--)\s*(?:file(?:name)?|path)\s*:\s*(\S+)/i;

/**
 * A relative path Muse suggested in a first-line comment ("# path: src/x.py"), if it is safe to show:
 * relative, no "..", no empty segments, a conservative character set. Never used to write anything.
 */
export function suggestedPath(code: string): { path?: string; rejected?: true } {
  const m = PATH_COMMENT.exec(code.split("\n", 1)[0] ?? "");
  if (!m) return {};
  const p = m[1].replace(/\*\/$|-->$/, "");
  const segments = p.split("/");
  const ok =
    p.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(p) &&
    !p.startsWith("/") &&
    !p.startsWith("-") &&
    segments.every((s) => s !== "" && s !== "." && s !== "..");
  return ok ? { path: p } : { rejected: true };
}

/** Manifests are small; anything bigger isn't one of ours. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Read a file only if it is a regular file no bigger than `maxBytes`. Opened with O_NOFOLLOW (a symlink is
 * refused) and O_NONBLOCK (a FIFO can't hang the open), then checked on the open descriptor, so nothing can be
 * swapped in between the check and the read.
 */
export function readRegularFile(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > maxBytes) throw new Error(`${path} is larger than an export allows`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const readManifestFile = (dir: string) => JSON.parse(readRegularFile(join(dir, "manifest.json"), MAX_MANIFEST_BYTES));

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Check limits and name every block. Throws (writing nothing) if anything is out of bounds. */
export function planExport(blocks: RawBlock[]): ExportPlan {
  if (blocks.length === 0) throw new BridgeError("NO_CODE", "That reply has no code blocks");
  if (blocks.length > MAX_BLOCKS) {
    throw new BridgeError("EXPORT_TOO_LARGE", `That reply has ${blocks.length} code blocks (limit ${MAX_BLOCKS})`);
  }
  let total = 0;
  const files: ExportedFile[] = [];
  const contents: string[] = [];
  blocks.forEach((b, i) => {
    const bytes = Buffer.byteLength(b.code, "utf8");
    if (bytes > MAX_BLOCK_BYTES) {
      throw new BridgeError("EXPORT_TOO_LARGE", `Code block ${i + 1} is ${bytes} bytes (limit ${MAX_BLOCK_BYTES})`);
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new BridgeError("EXPORT_TOO_LARGE", `The code blocks total more than ${MAX_TOTAL_BYTES} bytes`);
    }
    const language = cleanLanguage(b.language);
    const ext = EXTENSIONS[language] ?? "txt";
    const suggested = suggestedPath(b.code);
    files.push({
      file: `block-${String(i + 1).padStart(2, "0")}.${ext}`,
      language,
      lines: b.code === "" ? 0 : b.code.split("\n").length,
      bytes,
      sha256: sha256(b.code),
      ...(suggested.path ? { suggested_path: suggested.path } : {}),
      ...(suggested.rejected ? { suggested_path_rejected: true as const } : {}),
    });
    contents.push(b.code);
  });
  return { files, contents };
}

export interface ExportResult {
  dir: string;
  files: ExportedFile[];
  /** True when an identical export of the same reply already existed and was reused. */
  reused: boolean;
}

/** Exports older than this are deleted the next time something is exported (not exactly on the day). */
export const EXPORT_RETENTION_DAYS = 30;
const EXPORT_DIR_RE = /^\d{8}-\d{6}-r\d+-[0-9a-f]{6}$/;

/**
 * Delete exports older than EXPORT_RETENTION_DAYS. Only folders named like ours, that aren't symlinks and hold
 * a manifest with a valid exported_at, are ever considered; anything else in the folder is left alone.
 * Returns the names removed.
 */
export function pruneExports(root = config.exportsDir, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!EXPORT_DIR_RE.test(name) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
      const at = Date.parse(readManifestFile(dir).exported_at);
      if (Number.isNaN(at) || now - at < EXPORT_RETENTION_DAYS * 86_400_000) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // unreadable or half-written: leave it
    }
  }
  return removed;
}

/** Identity of a reply on the page: the thread plus its message ids. */
export function replyKey(threadUrl: string, messageIds: string[]): string {
  return sha256(`${threadUrl}\0${messageIds.join("\0")}`);
}

/**
 * Write a planned export under the exports dir: one owner-only folder per export, files named by the plan,
 * plus manifest.json. Exporting the same reply again with the same code reuses the earlier folder.
 */
export function writeExport(plan: ExportPlan, meta: { replyId: number; key: string }, root = config.exportsDir): ExportResult {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  pruneExports(root);
  const hashes = plan.files.map((f) => f.sha256).join(",");
  for (const name of readdirSync(root)) {
    try {
      if (!EXPORT_DIR_RE.test(name) || !lstatSync(join(root, name)).isDirectory()) continue;
      const m = readManifestFile(join(root, name));
      if (m.reply_key === meta.key && m.files.map((f: ExportedFile) => f.sha256).join(",") === hashes) {
        return { dir: join(root, name), files: m.files, reused: true };
      }
    } catch {
      // not an export folder, or unreadable: ignore
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const dir = join(root, `${stamp}-r${meta.replyId}-${randomBytes(3).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  plan.files.forEach((f, i) => writeFileSync(join(dir, f.file), plan.contents[i], { mode: PRIVATE_FILE_MODE }));
  const manifest = { reply_id: meta.replyId, reply_key: meta.key, exported_at: new Date().toISOString(), files: plan.files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: PRIVATE_FILE_MODE });
  return { dir, files: plan.files, reused: false };
}

/**
 * Runs in the page (passed to evaluateAll, so it must be self-contained). The code blocks of the given messages,
 * in page order, read the same way extract.ts fences them: the <code> inside each <pre> (or the <pre>), with
 * page UI removed and one trailing newline dropped. Code inside reasoning sections is skipped.
 */
export function pageCodeBlocks(
  els: Element[],
  o: { strip: string; reasoning: string },
): { blocks: { language: string; code: string }[]; nested: boolean } {
  const blocks: { language: string; code: string }[] = [];
  let nested = false;
  for (const el of els) {
    for (const pre of Array.from(el.querySelectorAll("pre"))) {
      if (pre.closest(o.reasoning)) continue;
      if (pre.parentElement?.closest("pre") || pre.querySelector("pre")) {
        nested = true;
        continue;
      }
      const clone = pre.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(o.strip).forEach((n) => n.remove());
      const code = clone.querySelector("code") ?? clone;
      const langClass = Array.from(code.classList).find((c) => c.startsWith("language-"));
      const language =
        pre.closest("[data-language]")?.getAttribute("data-language") ?? (langClass ? langClass.slice(9) : "");
      blocks.push({ language, code: (code.textContent ?? "").replace(/\n$/, "") });
    }
  }
  return { blocks, nested };
}

/** The code blocks of a reply still on the page, by its message ids. Fails closed. */
export async function readCodeBlocks(page: Page, messageIds: string[]): Promise<RawBlock[]> {
  if (!messageIds.length) throw new BridgeError("REPLY_NOT_ON_PAGE", "That reply has no messages to export");
  const loc = page.locator(messageIds.map((id) => `[${MESSAGE_ID_ATTR}=${cssString(id)}]`).join(", "));
  if ((await loc.count()) !== messageIds.length) {
    throw new BridgeError(
      "REPLY_NOT_ON_PAGE",
      "That reply isn't fully on the current page (another chat is open, or it scrolled out). Nothing exported.",
    );
  }
  const { blocks, nested } = await loc.evaluateAll(pageCodeBlocks, { strip: sel.chromeStrip, reasoning: sel.reasoning });
  if (nested) throw new BridgeError("EXPORT_AMBIGUOUS", "The reply has nested code blocks; nothing exported");
  return blocks;
}

/** An export folder's manifest (used by the review and sandbox scripts). */
export function readManifest(dir: string): { reply_id: number; files: ExportedFile[] } {
  try {
    return readManifestFile(dir);
  } catch (err) {
    throw new Error(`${dir} has no readable manifest.json; is it an export folder? (${err instanceof Error ? err.message : err})`, {
      cause: err,
    });
  }
}
