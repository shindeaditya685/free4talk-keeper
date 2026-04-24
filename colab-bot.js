/**
 * colab-bot.js - Optimized for Google Colab (no Express server)
 * Auth fix: uses storageState + addInitScript (tokens exist BEFORE page loads)
 */

const { chromium } = require("playwright");
require("dotenv").config();

// ── Config ──
const ROOM_URL = process.env.ROOM_URL || null;
const LS_USER_TOKEN = process.env.LS_USER_TOKEN || null;
const LS_USER_NAME = process.env.LS_USER_NAME || null;
const LS_USER_LFP = process.env.LS_USER_LFP || null;
const LS_USER_REDIRECT = process.env.LS_USER_REDIRECT || null;
const LS_KEYPAIR = process.env.LS_KEYPAIR || null;
const LS_USER = process.env.LS_USER || null;

const HEALTH_CHECK_INTERVAL = 3 * 60 * 1000;
const SAFE_RELOAD_INTERVAL = 18 * 60 * 1000;
const RESTART_DELAY = 15000;
const MAX_RESTART_ATTEMPTS = 100;

const startTime = Date.now();
let restartCount = 0;
let isShuttingDown = false;
let currentBrowser = null;

// ── Helpers ──
function elapsed() {
  const ms = Date.now() - startTime;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

function checkTokenExpiry() {
  try {
    const tokenObj = JSON.parse(LS_USER_TOKEN);
    const payload = JSON.parse(Buffer.from(tokenObj.data.split(".")[1], "base64url").toString());
    const expiresAt = new Date(payload.exp * 1000);
    const hoursLeft = (expiresAt - new Date()) / 3600000;
    if (hoursLeft < 0) { console.error(`[Keeper] TOKEN EXPIRED!`); return "expired"; }
    if (hoursLeft < 2) { console.warn(`[Keeper] Token expires in ${hoursLeft.toFixed(1)}h`); return "warning"; }
    console.log(`[Keeper] Token OK - expires in ${hoursLeft.toFixed(1)}h`);
    return "ok";
  } catch { return "unknown"; }
}

// ── Build storageState with auth tokens (tokens exist BEFORE any page loads) ──
function buildStorageState() {
  return {
    cookies: [
      {
        name: "user_token",
        value: LS_USER_TOKEN || "",
        domain: ".free4talk.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      },
      {
        name: "user_name",
        value: LS_USER_NAME || "",
        domain: ".free4talk.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      }
    ],
    origins: [
      {
        origin: "https://www.free4talk.com",
        localStorage: [
          { name: "user:token", value: LS_USER_TOKEN || "" },
          { name: "user_name", value: LS_USER_NAME || "" },
          { name: "user:lfp", value: LS_USER_LFP || "" },
          { name: "user:redirect", value: LS_USER_REDIRECT || "" }
        ]
      },
      {
        origin: "https://identity.free4talk.com",
        localStorage: [
          { name: "user", value: LS_USER || "" },
          { name: "key-pair", value: LS_KEYPAIR || "" }
        ]
      }
    ]
  };
}

// ── Click to join room ──
async function clickJoinButton(page) {
  try {
    const startText = await page.locator("text=Click on anywhere to start").first();
    if (await startText.isVisible({ timeout: 5000 })) {
      await startText.click();
      console.log("[Keeper] Clicked 'Click on anywhere to start'");
      await page.waitForTimeout(5000);
      return true;
    }
  } catch {}

  try {
    await page.mouse.click(400, 300);
    console.log("[Keeper] Clicked on page (anywhere)");
    await page.waitForTimeout(5000);
    return true;
  } catch {}

  const selectors = [
    'button:has-text("Join")', 'button:has-text("Enter")',
    'button:has-text("Start")', 'a:has-text("Join")',
    'input[type="submit"]', 'button[type="submit"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 2000 });
      if (btn) { await btn.click(); console.log(`[Keeper] Clicked: ${sel}`); await page.waitForTimeout(5000); return true; }
    } catch {}
  }
  return false;
}

async function isStillInRoom(page) {
  try {
    const url = page.url();
    if (url.includes("login") || url.includes("signin")) return false;
    const title = await page.title();
    const bodyExists = await page.evaluate(() => !!document.body && document.body.children.length > 0);
    if (!bodyExists || !title) return false;
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || "");
    const lowerText = pageText.toLowerCase();
    for (const kw of ["left the room", "disconnected", "reconnect", "connection lost"]) {
      if (lowerText.includes(kw)) { console.log(`[Keeper] Found: "${kw}"`); return false; }
    }
    return true;
  } catch (err) { console.error(`[Keeper] Health check error: ${err.message}`); return false; }
}

async function safeCleanup() {
  try { if (currentBrowser) await currentBrowser.close().catch(() => {}); } catch {}
  currentBrowser = null;
}

// ── Main ──
async function joinRoom() {
  if (isShuttingDown) return;
  if (restartCount >= MAX_RESTART_ATTEMPTS) {
    console.error(`[Keeper] Max restarts reached. Giving up.`);
    return;
  }

  restartCount++;
  console.log(`\n[Keeper] ================================`);
  console.log(`[Keeper] Start #${restartCount} | Uptime: ${elapsed()}`);
  checkTokenExpiry();
  console.log(`[Keeper] ================================\n`);

  try {
    console.log("[Keeper] Launching browser...");
    currentBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--disable-gpu", "--disable-extensions", "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor", "--disable-blink-features=AutomationControlled",
      ],
    });

    // Create context with pre-loaded auth tokens (localStorage + cookies)
    const storageState = buildStorageState();
    const context = await currentBrowser.newContext({
      permissions: ["microphone"],
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      storageState: storageState,
    });

    // Re-inject auth on EVERY page load (runs before SPA code)
    await context.addInitScript(({ token, name, lfp, redirect, user, keypair }) => {
      try {
        if (token) localStorage.setItem("user:token", token);
        if (name) localStorage.setItem("user_name", name);
        if (lfp) localStorage.setItem("user:lfp", lfp);
        if (redirect) localStorage.setItem("user:redirect", redirect);
      } catch (e) {}
      try {
        if (user) localStorage.setItem("user", user);
        if (keypair) localStorage.setItem("key-pair", keypair);
      } catch (e) {}
    }, {
      token: LS_USER_TOKEN,
      name: LS_USER_NAME,
      lfp: LS_USER_LFP,
      redirect: LS_USER_REDIRECT,
      user: LS_USER,
      keypair: LS_KEYPAIR,
    });

    // Anti-detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    console.log("[Keeper] Creating room page...");
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error(`[Keeper] Page error: ${err.message}`));

    console.log(`[Keeper] Navigating to: ${ROOM_URL}`);
    await page.goto(ROOM_URL, { waitUntil: "networkidle", timeout: 60000 });
    console.log(`[Keeper] Page loaded: ${page.url()}`);

    console.log("[Keeper] Waiting for SPA to render...");
    await page.waitForTimeout(8000);

    // Diagnostic: check auth state
    const authCheck = await page.evaluate(() => {
      const token = localStorage.getItem("user:token");
      const name = localStorage.getItem("user_name");
      return {
        hasToken: !!token,
        tokenPrefix: token ? token.substring(0, 30) + "..." : "NONE",
        userName: name
      };
    }).catch(() => ({ hasToken: false }));
    console.log(`[Keeper] Auth: token=${authCheck.hasToken} (${authCheck.tokenPrefix}) name=${authCheck.userName}`);

    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || "");
    console.log(`[Keeper] Page text: "${pageText.replace(/\n/g, ' ').substring(0, 200)}"`);

    if (pageText.toLowerCase().includes("sign in")) {
      console.error("[Keeper] AUTH FAILURE - shows sign-in prompt");
    }

    console.log("[Keeper] Attempting to join...");
    await clickJoinButton(page);

    await page.waitForTimeout(10000);

    const url = page.url();
    if (url.includes("login") || url.includes("signin")) {
      console.error("[Keeper] Redirected to login - token expired!");
      await safeCleanup();
      return;
    }

    const finalText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || "");
    console.log(`[Keeper] After join: "${finalText.replace(/\n/g, ' ').substring(0, 200)}"`);

    console.log(`[Keeper] In room: ${url}`);
    restartCount = 0;

    startHealthChecks(page);

  } catch (err) {
    console.error(`[Keeper] Fatal: ${err.message}`);
    await safeCleanup();
    setTimeout(() => joinRoom(), RESTART_DELAY);
  }
}

function startHealthChecks(page) {
  const healthInterval = setInterval(async () => {
    if (isShuttingDown) { clearInterval(healthInterval); if (page._safeInterval) clearInterval(page._safeInterval); return; }
    try {
      const healthy = await isStillInRoom(page);
      if (healthy) {
        console.log(`[Keeper] Health OK | Uptime: ${elapsed()}`);
      } else {
        console.warn(`[Keeper] Unhealthy - reloading...`);
        clearInterval(healthInterval); if (page._safeInterval) clearInterval(page._safeInterval);
        try {
          await page.reload({ waitUntil: "networkidle", timeout: 60000 });
          await page.waitForTimeout(8000);
          await clickJoinButton(page);
          console.log(`[Keeper] Recovered`);
          startHealthChecks(page);
        } catch (err) {
          console.error(`[Keeper] Reload failed: ${err.message}`);
          await safeCleanup();
          setTimeout(() => joinRoom(), RESTART_DELAY);
        }
      }
    } catch (err) {
      clearInterval(healthInterval); if (page._safeInterval) clearInterval(page._safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, HEALTH_CHECK_INTERVAL);

  const safeInterval = setInterval(async () => {
    if (isShuttingDown) { clearInterval(safeInterval); return; }
    try {
      console.log(`[Keeper] Safety reload | Uptime: ${elapsed()}`);
      await page.reload({ waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(8000);
      await clickJoinButton(page);
    } catch (err) {
      clearInterval(healthInterval); clearInterval(safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, SAFE_RELOAD_INTERVAL);

  page._healthInterval = healthInterval;
  page._safeInterval = safeInterval;
}

// ── Graceful shutdown ──
process.on("SIGINT", async () => { isShuttingDown = true; console.log(`\n[Keeper] Shutting down. Uptime: ${elapsed()}`); await safeCleanup(); process.exit(0); });
process.on("SIGTERM", async () => { isShuttingDown = true; await safeCleanup(); process.exit(0); });
process.on("uncaughtException", async (err) => { console.error(`[Keeper] ${err.message}`); await safeCleanup(); if (!isShuttingDown) setTimeout(() => joinRoom(), RESTART_DELAY); });
process.on("unhandledRejection", async (reason) => { console.error(`[Keeper] ${reason}`); await safeCleanup(); if (!isShuttingDown) setTimeout(() => joinRoom(), RESTART_DELAY); });

// ── Start ──
joinRoom();
