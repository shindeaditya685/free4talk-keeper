# Free4Talk Room Keeper

Keeps your Free4Talk silent study room alive using a headless browser bot.

---

## Quick Start - Google Colab (Recommended, 12hr runtime)

1. Go to [Google Colab](https://colab.research.google.com)
2. Upload `free4talk-keeper-colab.ipynb`
3. Edit **Step 2** with your tokens
4. Run all cells
5. To prevent disconnect: press **F12** → **Console** → paste:
   ```javascript
   function ClickConnect(){console.log('Working');document.querySelector('colab-connect-button').click()}
   setInterval(ClickConnect,60000)
   ```

---

## Deploy on Render.com (24/7, needs UptimeRobot)

### Files to upload to GitHub
- `index.js`
- `package.json`
- `render.yaml`

### Environment Variables (set in Render Dashboard)
| Key | Value |
|-----|-------|
| `ROOM_URL` | Your room URL |
| `LS_USER_TOKEN` | Your token |
| `LS_USER_NAME` | Your username |
| `LS_USER_LFP` | Your lfp value |
| `LS_USER_REDIRECT` | Your redirect value |
| `LS_KEYPAIR` | Your keypair |
| `LS_USER` | Your user JSON |

### Settings
- **Build Command**: `npm install`
- **Start Command**: `node node_modules/playwright/cli.js install chromium && node index.js`

### Keep Render awake
Use [UptimeRobot](https://uptimerobot.com) to ping every 5 minutes.

---

## Run Locally

```bash
npm install
node index.js
```

---

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main bot with Express health server (Render/Server) |
| `colab-bot.js` | Bot without Express (Google Colab) |
| `free4talk-keeper-colab.ipynb` | Google Colab notebook |
| `debug.js` | Debug tool with visible browser |
| `get-cookies.js` | Extract session tokens from browser |
| `.env` | Your tokens (NEVER upload to GitHub) |
| `package.json` | Node.js dependencies |
| `render.yaml` | Render.com deployment config |

---

## Token Refresh

Tokens expire ~7 days. To refresh:
1. Open free4talk.com in your browser (logged in)
2. Open DevTools → Application → Local Storage
3. Copy new values for `user:token` and `user:lfp` from `www.free4talk.com`
4. Update `.env` or Render environment variables
