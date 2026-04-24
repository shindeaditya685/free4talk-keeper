const path = require("path");
require("dotenv").config();

// MUST be set BEFORE requiring playwright
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, "browsers");

const { chromium } = require("playwright");
const express = require("express");

// ── Config ──
const ROOM_URL = process.env.ROOM_URL || null;
const PORT = process.env.PORT || 3000;
const LS_USER_TOKEN = process.env.LS_USER_TOKEN || null;
const LS_USER_NAME = process.env.LS_USER_NAME || null;
const LS_USER_LFP = process.env.LS_USER_LFP || null;
const LS_USER_REDIRECT = process.env.LS_USER_REDIRECT || null;
const LS_KEYPAIR = process.env.LS_KEYPAIR || null;
const LS_USER = process.env.LS_USER || null;

const HEALTH_CHECK_INTERVAL = 3 * 60 * 1000;
const SAFE_RELOAD_INTERVAL = 18 * 60 * 1000;
const RESTART_DELAY = 15000;
const MAX_RESTART_ATTEMPTS = 50;

const startTime = Date.now();
let restartCount = 0;
let isShuttingDown = false;
let currentPage = null;
let currentBrowser = null;
let currentContext = null;

// ── Express (starts IMMEDIATELY — must bind port fast for Render) ──
const app = express();
app.get("/", (req, res) => {
  res.send(
    `<h2>Free4Talk Keeper</h2><p>Room: ${ROOM_URL}</p><p>Uptime: ${elapsed()}</p><p>Restarts: ${restartCount}</p>`,
  );
});
app.listen(PORT, () => console.log(`[Server] Port ${PORT} ready`));

// ── Helpers ──
function elapsed() {
  const ms = Date.now() - startTime;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function checkTokenExpiry() {
  try {
    const tokenObj = JSON.parse(LS_USER_TOKEN);
    const payload = JSON.parse(
      Buffer.from(tokenObj.data.split(".")[1], "base64url").toString(),
    );
    const hoursLeft = (new Date(payload.exp * 1000) - new Date()) / 3600000;
    if (hoursLeft < 0) {
      console.error("[Keeper] TOKEN EXPIRED!");
      return "expired";
    }
    if (hoursLeft < 2) {
      console.warn(`[Keeper] Token expires in ${hoursLeft.toFixed(1)}h`);
      return "warning";
    }
    console.log(`[Keeper] Token OK - ${hoursLeft.toFixed(1)}h remaining`);
    return "ok";
  } catch {
    return "unknown";
  }
}

// ── Inject www.free4talk.com tokens via page.evaluate (direct, reliable) ──
async function injectTokens(page) {
  const result = await page.evaluate(
    ({ token, name, lfp, redirect }) => {
      try {
        localStorage.setItem("user:token", token);
        localStorage.setItem("user_name", name);
        localStorage.setItem("user:lfp", lfp);
        localStorage.setItem("user:redirect", redirect);
        const verify = localStorage.getItem("user:token");
        return { ok: !!verify, len: verify ? verify.length : 0 };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    },
    {
      token: LS_USER_TOKEN,
      name: LS_USER_NAME,
      lfp: LS_USER_LFP,
      redirect: LS_USER_REDIRECT,
    },
  );
  console.log(`[Keeper] Token inject: ok=${result.ok} len=${result.len}`);
  return result.ok;
}

// ── Inject identity.free4talk.com tokens (different origin, needs separate page) ──
async function injectIdentityTokens(context) {
  try {
    const p = await context.newPage();
    await p.goto("https://identity.free4talk.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await p.evaluate(
      ({ user, keypair }) => {
        localStorage.setItem("user", user);
        localStorage.setItem("key-pair", keypair);
      },
      { user: LS_USER, keypair: LS_KEYPAIR },
    );
    await p.close();
    console.log("[Keeper] Identity tokens injected");
    return true;
  } catch (e) {
    console.error(`[Keeper] Identity inject failed: ${e.message}`);
    return false;
  }
}

// ── Click to join room ──
async function clickToJoin(page) {
  try {
    const el = page.locator("text=Click on anywhere to start").first();
    if (await el.isVisible({ timeout: 5000 })) {
      await el.click();
      console.log("[Keeper] Clicked 'Click on anywhere to start'");
      await page.waitForTimeout(5000);
      return true;
    }
  } catch {}
  try {
    await page.mouse.click(400, 300);
    console.log("[Keeper] Clicked page center (fallback)");
    await page.waitForTimeout(5000);
    return true;
  } catch {}
  return false;
}

// ── Health check ──
async function isStillInRoom(page) {
  try {
    if (page.url().includes("login") || page.url().includes("signin"))
      return false;
    const title = await page.title();
    const ok = await page.evaluate(
      () => !!document.body && document.body.children.length > 0,
    );
    if (!ok || !title) return false;
    const text = (
      await page.evaluate(
        () => document.body?.innerText?.substring(0, 2000) || "",
      )
    ).toLowerCase();
    for (const kw of [
      "left the room",
      "disconnected",
      "reconnect",
      "connection lost",
    ]) {
      if (text.includes(kw)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function safeCleanup() {
  try {
    if (currentBrowser) await currentBrowser.close().catch(() => {});
  } catch {}
  currentBrowser = null;
  currentPage = null;
  currentContext = null;
}

// ── Main ──
async function joinRoom() {
  if (isShuttingDown) return;
  if (restartCount >= MAX_RESTART_ATTEMPTS) {
    console.error("[Keeper] Max restarts reached.");
    return;
  }

  restartCount++;
  console.log(`\n[Keeper] === Start #${restartCount} | ${elapsed()} ===`);
  checkTokenExpiry();

  try {
    console.log("[Keeper] Launching browser...");
    currentBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await currentBrowser.newContext({
      permissions: ["microphone"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      bypassCSP: true,
    });
    currentContext = context;

    // Anti-detection only (no auth here — auth injected via evaluate below)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    const page = await context.newPage();
    currentPage = page;
    page.on("pageerror", (err) =>
      console.error(`[Keeper] Page error: ${err.message}`),
    );

    // ── Step 1: Navigate to room URL (domcontentloaded = fast, before SPA fully runs) ──
    console.log(`[Keeper] Step 1: Navigate to ${ROOM_URL}`);
    await page.goto(ROOM_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log(`[Keeper] Page committed: ${page.url()}`);

    // ── Step 2: Inject auth tokens DIRECTLY into localStorage ──
    console.log("[Keeper] Step 2: Injecting www tokens...");
    await injectTokens(page);

    // ── Step 3: Inject identity tokens (separate origin) ──
    console.log("[Keeper] Step 3: Injecting identity tokens...");
    await injectIdentityTokens(context);

    // ── Step 4: Reload page so SPA reads tokens from localStorage ──
    console.log("[Keeper] Step 4: Reloading (SPA will read tokens now)...");
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    console.log(`[Keeper] Reloaded: ${page.url()}`);

    // ── Step 5: Wait for SPA to render ──
    console.log("[Keeper] Step 5: Waiting for SPA to render...");
    await page.waitForTimeout(8000);

    // ── Step 6: Verify tokens survived the reload ──
    const authCheck = await page
      .evaluate(() => {
        const token = localStorage.getItem("user:token");
        const name = localStorage.getItem("user_name");
        const lfp = localStorage.getItem("user:lfp");
        return {
          hasToken: !!token,
          tokenLen: token ? token.length : 0,
          userName: name,
          hasLfp: !!lfp,
        };
      })
      .catch(() => ({ hasToken: false, tokenLen: 0, err: "evaluate-failed" }));
    console.log(
      `[Keeper] Auth check: token=${authCheck.hasToken} len=${authCheck.tokenLen} name=${authCheck.userName} lfp=${authCheck.hasLfp}`,
    );

    // Dump page text
    const pageText = await page.evaluate(
      () => document.body?.innerText?.substring(0, 800) || "",
    );
    console.log(
      `[Keeper] Page text: "${pageText.replace(/\n/g, " ").substring(0, 200)}"`,
    );

    if (
      pageText.toLowerCase().includes("sign in") ||
      pageText.toLowerCase().includes("please sign")
    ) {
      console.error("[Keeper] AUTH FAILURE - page shows sign-in prompt");
    }

    // If tokens were cleared by SPA, try injecting again
    if (!authCheck.hasToken) {
      console.warn("[Keeper] Tokens lost after reload! Re-injecting...");
      await injectTokens(page);
      await page.waitForTimeout(3000);
    }

    // ── Step 7: Click to join ──
    console.log("[Keeper] Step 7: Clicking to join...");
    await clickToJoin(page);

    // Wait for room connection
    await page.waitForTimeout(10000);

    const finalText = await page.evaluate(
      () => document.body?.innerText?.substring(0, 800) || "",
    );
    console.log(
      `[Keeper] After join: "${finalText.replace(/\n/g, " ").substring(0, 200)}"`,
    );

    if (page.url().includes("login") || page.url().includes("signin")) {
      console.error("[Keeper] Redirected to login!");
      await safeCleanup();
      return;
    }
    console.log(`[Keeper] In room: ${page.url()}`);
    restartCount = 0;

    // Health check loop
    startHealthChecks(page);
  } catch (err) {
    console.error(`[Keeper] Fatal: ${err.message}`);
    await safeCleanup();
    setTimeout(() => joinRoom(), RESTART_DELAY);
  }
}

function startHealthChecks(page) {
  const healthInterval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(healthInterval);
      if (page._safeInterval) clearInterval(page._safeInterval);
      return;
    }
    try {
      if (await isStillInRoom(page)) {
        console.log(`[Keeper] Health OK | ${elapsed()}`);
      } else {
        console.warn(
          "[Keeper] Unhealthy - re-injecting tokens and reloading...",
        );
        clearInterval(healthInterval);
        if (page._safeInterval) clearInterval(page._safeInterval);
        try {
          await injectTokens(page);
          await page.reload({ waitUntil: "networkidle", timeout: 60000 });
          await page.waitForTimeout(8000);
          await clickToJoin(page);
          await page.waitForTimeout(10000);
          console.log("[Keeper] Recovered");
          startHealthChecks(page);
        } catch (err) {
          console.error(`[Keeper] Recovery failed: ${err.message}`);
          await safeCleanup();
          setTimeout(() => joinRoom(), RESTART_DELAY);
        }
      }
    } catch (err) {
      clearInterval(healthInterval);
      if (page._safeInterval) clearInterval(page._safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, HEALTH_CHECK_INTERVAL);

  const safeInterval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(safeInterval);
      return;
    }
    try {
      console.log(`[Keeper] Safety reload | ${elapsed()}`);
      await injectTokens(page);
      await page.reload({ waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(8000);
      await clickToJoin(page);
    } catch (err) {
      clearInterval(healthInterval);
      clearInterval(safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, SAFE_RELOAD_INTERVAL);

  page._healthInterval = healthInterval;
  page._safeInterval = safeInterval;
}

// ── Graceful shutdown ──
process.on("SIGINT", async () => {
  isShuttingDown = true;
  console.log(`Shutting down. ${elapsed()}`);
  await safeCleanup();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  isShuttingDown = true;
  await safeCleanup();
  process.exit(0);
});
process.on("uncaughtException", async (err) => {
  console.error(`Crash: ${err.message}`);
  await safeCleanup();
  if (!isShuttingDown) setTimeout(() => joinRoom(), RESTART_DELAY);
});
process.on("unhandledRejection", async (r) => {
  console.error(`Crash: ${r}`);
  await safeCleanup();
  if (!isShuttingDown) setTimeout(() => joinRoom(), RESTART_DELAY);
});

// ── Start bot ──
joinRoom();
