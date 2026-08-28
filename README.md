# relay — terminal chat room

A self-hosted, single-room web chat with a dark terminal aesthetic. No accounts,
no database — just a handle and a shared room. Chat history (last 200 messages)
lives in memory only and is lost on server restart.

## Stack

- Node.js 18+
- One dependency: [`ws`](https://www.npmjs.com/package/ws)
- Plain HTTP server for static files + a WebSocket server on the same port
- No frameworks (no React, no Express)

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Open it in a second tab/browser to chat with
yourself.

The port comes from `process.env.PORT`, falling back to `3000`.

### Access code (optional)

Set the `ACCESS_CODE` environment variable to require a shared code before
anyone can join:

```bash
ACCESS_CODE=letmein npm start
```

If `ACCESS_CODE` is unset (the default), the code field is ignored and anyone
can join with just a handle. The code is never written into the source code,
so it stays out of the public GitHub repo — set it as an environment variable
wherever you deploy.

## Client commands

- `/me <action>` — describe an action (e.g. `/me waves`)
- `/nick <handle>` — change your handle
- `/who` — list who's online
- `/clear` — clear your local screen (does not affect other clients)
- `/help` — show the command list

## Desktop / folders

After joining, the main screen is a desktop of folders with the chat as a
medium-sized box on the right:

- **PHOTOS** — opens a gallery overlay with a placeholder image grid and lore
  text. To show real photos, drop files named `img1.jpg` through `img6.jpg`
  into `public/images/` — the grid loads whatever's present and falls back to
  a "NO IMAGE" placeholder tile for any file that's missing, no code changes
  needed. Replace the placeholder lore paragraph directly in
  `public/index.html` (search for `LORE FILE // ENTRY 001`).
- **SECRET** folders — decorative and locked. Clicking one just shakes the
  icon and shows "ACCESS DENIED"; there's no real content or password gate
  behind them.

## Deploying to Render (free tier)

1. Push this repo to GitHub (public or private).
2. On [render.com](https://render.com), sign up / log in.
3. Click **New +** → **Web Service**.
4. Connect your GitHub account and select this repo.
5. Configure:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
6. Click **Create Web Service**.

Render assigns a URL like `https://<your-service-name>.onrender.com`. The app
auto-detects `https://` and switches to a `wss://` WebSocket connection, so no
extra config is needed.

To require an access code in production, add an environment variable in the
Render dashboard under your service → **Environment**: key `ACCESS_CODE`,
value whatever shared code you want. Redeploy for it to take effect.

**To redeploy after changes:** commit and push to the branch Render is watching
(usually `main`) — Render auto-deploys on push. Or click **Manual Deploy** →
**Deploy latest commit** in the Render dashboard.

### Free tier note

Render's free instances spin down after ~15 minutes of no traffic. The first
visitor after idle will wait roughly 30-60 seconds for the service to wake up
and the WebSocket to connect. Once it's warm, everyone else connects instantly.
The server's ping/pong keepalive (every 30s) only keeps the process from idling
*while people are connected* — it does not prevent the free-tier sleep when the
room is empty.

**Keeping it warm:** point an external uptime pinger (e.g.
[cron-job.org](https://cron-job.org), [UptimeRobot](https://uptimerobot.com))
at your root URL (`https://<your-service-name>.onrender.com/`) on a schedule
under 15 minutes (10 minutes leaves a safe margin). A plain `GET /` is enough —
it doesn't need to open a WebSocket. Note this uses up your Render free-tier
monthly instance-hours faster since the service never sleeps; fine for a
single always-on service, but leaves less headroom if you run other free
services on the same account.

## Notes

- Chat history is capped at the last 200 messages and lives only in the
  server's memory — it resets on every restart/redeploy.
- Handles are 1-16 characters, `A-Za-z0-9_.-` only, and must be unique among
  currently connected clients.
- Messages are capped at 300 characters and rate-limited per connection
  (5-message burst, refilling 1 per 1.5s).
