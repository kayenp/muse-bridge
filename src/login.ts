// `npm run login`: open a visible window on the bridge's own profile and wait for the user to log in.
// Stop the MCP server first (or use the muse_login tool instead); one profile can't be open twice.
import { closeBrowser, getPage } from "./browser.js";
import { config } from "./config.js";
import { BridgeError } from "./errors.js";
import { checkSession } from "./session.js";

const say = (msg: string) => console.error(msg);

try {
  const page = await getPage("headed");
  await page.goto(config.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  if ((await checkSession(page)) === "ok") {
    say("Already logged in.");
  } else {
    say("Log in to muse.ai in the browser window (waiting up to 5 minutes)...");
    const deadline = Date.now() + 5 * 60_000;
    let ok = false;
    while (!ok && Date.now() < deadline && !page.isClosed()) {
      ok = (await checkSession(page, 0)) === "ok";
      if (!ok) await page.waitForTimeout(1000);
    }
    say(ok ? "Logged in. Session saved to " + config.profileDir : "Gave up: not logged in.");
    process.exitCode = ok ? 0 : 1;
  }
} catch (err) {
  say(err instanceof BridgeError ? `${err.code}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
