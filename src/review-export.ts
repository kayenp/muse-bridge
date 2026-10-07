#!/usr/bin/env node
/**
 * npm run review-export -- <export_dir> [--model NAME]
 *
 * Isolated review of code exported with muse_export_code. Prints counts only; the report (quotes and
 * observations, which are untrusted text) goes to review.md and review.json in the export folder, for the user.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readManifest } from "./codeExport.js";
import { PRIVATE_FILE_MODE } from "./config.js";
import { buildInput, countBy, loadExport, parseFindings, renderReport, REVIEW_SYSTEM } from "./exportReview.js";
import { runIsolatedClaude } from "./isolated.js";

const args = process.argv.slice(2);
const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? args.splice(modelAt, 2)[1] : undefined;
if (args.length !== 1) {
  console.error("usage: npm run review-export -- <export_dir> [--model NAME]");
  process.exit(2);
}
const dir = resolve(args[0]);

try {
  const files = loadExport(dir, readManifest(dir).files);
  const result = await runIsolatedClaude({
    system: REVIEW_SYSTEM,
    input: buildInput(files),
    model,
    effort: "medium",
    timeoutMs: 600_000,
  });
  const findings = parseFindings(result, files);
  writeFileSync(join(dir, "review.json"), JSON.stringify(findings, null, 2) + "\n", { mode: PRIVATE_FILE_MODE });
  writeFileSync(join(dir, "review.md"), renderReport(dir, findings), { mode: PRIVATE_FILE_MODE });
  const c = countBy(findings);
  process.stdout.write(
    `review: ${findings.length} finding(s): ${c.high} high, ${c.medium} medium, ${c.low} low; ` +
      `${c.unverified} with unverifiable quotes. Report for the user: ${join(dir, "review.md")}\n`,
  );
} catch (err) {
  // Our own messages only: nothing from the code or the model's output is echoed.
  console.error(`review failed: ${err instanceof SyntaxError ? "the reviewer's output wasn't valid JSON" : err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
