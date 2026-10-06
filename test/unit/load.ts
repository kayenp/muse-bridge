import type { Page } from "playwright";

/**
 * Load HTML into a page via a data: URL. page.setContent hangs on the ungoogled-chromium 148 build
 * (Playwright 1.63 targets Chromium 153); goto works, and is what the bridge itself uses.
 */
export async function load(page: Page, html: string): Promise<void> {
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html), { waitUntil: "load" });
}
