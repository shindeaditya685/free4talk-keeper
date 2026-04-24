/**
 * debug.js - Run this locally to see what the bot actually sees
 * and capture all network requests to understand auth flow
 *
 * Run: node -r dotenv/config debug.js
 */

const { chromium } = require("playwright");
require("dotenv").config();

const ROOM_URL = process.env.ROOM_URL;
const LS_USER_TOKEN = process.env.LS_USER_TOKEN;
const LS_USER_NAME = process.env.LS_USER_NAME;
const LS_USER_LFP = process.env.LS_USER_LFP;
const LS_USER_REDIRECT = process.env.LS_USER_REDIRECT;
const LS_KEYPAIR = process.env.LS_KEYPAIR;
const LS_USER = process.env.LS_USER;

(async () => {
  const browser = await chromium.launch({
    headless: false, // visible so you can see what happens
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const context = await browser.newContext({ permissions: ["microphone"] });

  // Log all API calls
  context.on("request", (req) => {
    if (
      req.url().includes("api") ||
      req.url().includes("auth") ||
      req.url().includes("identity")
    ) {
      console.log("[REQ]", req.method(), req.url());
    }
  });
  context.on("response", async (res) => {
    if (
      res.url().includes("api") ||
      res.url().includes("auth") ||
      res.url().includes("identity")
    ) {
      console.log("[RES]", res.status(), res.url());
    }
  });

  // Inject identity.free4talk.com
  const identityPage = await context.newPage();
  await identityPage.goto("https://identity.free4talk.com", {
    waitUntil: "domcontentloaded",
  });
  await identityPage.evaluate(
    ({ user, keypair }) => {
      if (user) localStorage.setItem("user", user);
      if (keypair) localStorage.setItem("key-pair", keypair);
      console.log(
        "identity localStorage now:",
        JSON.stringify(
          Object.fromEntries(
            Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
          ),
        ),
      );
    },
    { user: LS_USER, keypair: LS_KEYPAIR },
  );
  await identityPage.close();

  // Inject www.free4talk.com
  const wwwPage = await context.newPage();
  await wwwPage.goto("https://www.free4talk.com", {
    waitUntil: "domcontentloaded",
  });

  const beforeStorage = await wwwPage.evaluate(() => {
    return Object.fromEntries(
      Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
    );
  });
  console.log(
    "\n[DEBUG] www localStorage BEFORE inject:",
    JSON.stringify(beforeStorage, null, 2),
  );

  await wwwPage.evaluate(
    ({ token, name, lfp, redirect }) => {
      if (token) localStorage.setItem("user:token", token);
      if (name) localStorage.setItem("user_name", name);
      if (lfp) localStorage.setItem("user:lfp", lfp);
      if (redirect) localStorage.setItem("user:redirect", redirect);
    },
    {
      token: LS_USER_TOKEN,
      name: LS_USER_NAME,
      lfp: LS_USER_LFP,
      redirect: LS_USER_REDIRECT,
    },
  );

  const afterStorage = await wwwPage.evaluate(() => {
    return Object.fromEntries(
      Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
    );
  });
  console.log(
    "\n[DEBUG] www localStorage AFTER inject:",
    JSON.stringify(afterStorage, null, 2),
  );
  await wwwPage.close();

  // Go to room
  const page = await context.newPage();
  console.log("\n[DEBUG] Navigating to room...");
  await page.goto(ROOM_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);

  // Take screenshot
  await page.screenshot({ path: "screenshot.png", fullPage: true });
  console.log(
    "\n[DEBUG] Screenshot saved as screenshot.png — open it to see what the bot sees",
  );

  // Check what localStorage looks like on the room page
  const roomStorage = await page.evaluate(() => {
    return Object.fromEntries(
      Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
    );
  });
  console.log(
    "\n[DEBUG] Room page localStorage:",
    JSON.stringify(roomStorage, null, 2),
  );

  console.log("\n[DEBUG] Current URL:", page.url());
  console.log("\nBrowser staying open for 60 seconds so you can inspect...");
  await page.waitForTimeout(60000);
  await browser.close();
})();
