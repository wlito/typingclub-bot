// Stealth browser launch: real Chromium, persistent profile, CDP input.
//
// Why this is hard to catch:
// - page.keyboard goes through Chrome DevTools Protocol, producing TRUSTED
//   key events (isTrusted = true), indistinguishable from a real keyboard.
//   We never dispatch synthetic events and never call the page's internal
//   JS APIs directly (that's what the known cheat scripts do — no input
//   events at all, much more suspicious under any event-stream scrutiny).
// - playwright-extra + stealth plugin scrubs the standard automation tells
//   (navigator.webdriver, permissions quirks, plugin fingerprints…).
// - Persistent profile: real cookies, real login, normal browsing history.
// - Headed mode: the page is actually visible/focused (visibility API safe).

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "./config.js";

chromium.use(StealthPlugin());

export async function launch() {
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: config.viewport,
    locale: config.locale,
    timezoneId: config.timezoneId,
    // Don't advertise automation via the default flags…
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled", "--disable-infobars"],
  });

  // …and belt-and-braces the webdriver flag on every page.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return context;
}
