// `npm run smoke`: one round trip through the real site, without MCP. Stop the MCP server first.
import { closeBrowser } from "./browser.js";
import { errorResult, newChat, readyPage } from "./muse.js";
import { sendAndWait } from "./reply.js";

try {
  const page = await readyPage();
  await newChat(page);
  const { text, warning } = await sendAndWait(page, "Reply with exactly: PONG", { timeoutMs: 120_000, includeReasoning: false });
  console.error(JSON.stringify({ text, warning }));
  process.exitCode = text.trim() === "PONG" ? 0 : 1;
} catch (err) {
  console.error(JSON.stringify(await errorResult(err), null, 2));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
