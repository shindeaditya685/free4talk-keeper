/**
 * get-cookies.js
 * Run ONCE on YOUR computer to extract your free4talk session.
 *
 * HOW TO RUN:
 *   npm install
 *   node get-cookies.js
 */

const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  console.log(
    "\n🚀 Opening Chrome — log in to free4talk in the window that appears...\n",
  );

  const browser = await chromium.launchPersistentContext("", {
    headless: false,
    channel: "chrome",
    args: ["--start-maximized"],
  });

  const page = await browser.newPage();
  await page.goto("https://www.free4talk.com");

  console.log("👉 Log in with Google in the browser window.");
  console.log(
    "   Once you can see the room list, come back here and press ENTER.\n",
  );

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", resolve);
  });

  console.log("\n⏳ Extracting session data from all free4talk domains...");

  // Grab all cookies (covers all subdomains)
  const cookies = await browser.cookies([
    "https://www.free4talk.com",
    "https://identity.free4talk.com",
  ]);

  // Grab localStorage from www.free4talk.com
  const wwwStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  });

  // Open identity subdomain and grab its localStorage (key-pair, user)
  const identityPage = await browser.newPage();
  await identityPage
    .goto("https://identity.free4talk.com", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    })
    .catch(() => {});
  await identityPage.waitForTimeout(2000);

  const identityStorage = await identityPage
    .evaluate(() => {
      const data = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        data[key] = window.localStorage.getItem(key);
      }
      return data;
    })
    .catch(() => ({}));

  await identityPage.close();

  const output = {
    cookies,
    wwwLocalStorage: wwwStorage,
    identityLocalStorage: identityStorage,
  };

  fs.writeFileSync("session.json", JSON.stringify(output, null, 2));

  console.log(`\n✅ Captured:`);
  console.log(`   ${cookies.length} cookies`);
  console.log(
    `   www localStorage keys: ${Object.keys(wwwStorage).join(", ") || "(none)"}`,
  );
  console.log(
    `   identity localStorage keys: ${Object.keys(identityStorage).join(", ") || "(none)"}`,
  );

  if (!identityStorage["user"] && !identityStorage["key-pair"]) {
    console.warn(
      "\n⚠️  Warning: identity.free4talk.com localStorage is empty.",
    );
    console.warn(
      "   Make sure you are fully logged in before pressing Enter.\n",
    );
  } else {
    console.log(
      `\n   ✅ Found auth keys: ${Object.keys(identityStorage).join(", ")}`,
    );
  }

  const oneLine = JSON.stringify(output);
  console.log(
    "\n📋 Copy the line below and paste it as SESSION_JSON in Render:\n",
  );
  console.log("─".repeat(60));
  console.log(oneLine);
  console.log("─".repeat(60));
  console.log("\n⚠️  Keep session.json private — never upload it to GitHub!\n");

  await browser.close();
  process.exit(0);
})();
