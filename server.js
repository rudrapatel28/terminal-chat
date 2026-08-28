'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const HISTORY_LIMIT = 200;
const MAX_MSG_LEN = 300;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,16}$/;
const BUCKET_MAX = 5;
const REFILL_MS = 1500;
const PING_INTERVAL_MS = 30000;

const history = [];
// handle (lowercased) -> ws connection, for uniqueness checks
const handles = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Path-traversal guard: resolve against PUBLIC_DIR and verify containment.
  const resolved = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, resolved);
});

const wss = new WebSocketServer({ server });

function now() {
  return Date.now();
}

function pushHistory(entry) {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
}

function broadcast(entry, { exceptWs } = {}) {
  pushHistory(entry);
  const payload = JSON.stringify(entry);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && client !== exceptWs) {
      client.send(payload);
    }
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function presenceList() {
  return Array.from(handles.keys()).map((lower) => handles.get(lower).handle);
}

function broadcastPresence() {
  const entry = { type: 'presence', users: presenceList(), ts: now() };
  const payload = JSON.stringify(entry);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function systemMessage(text) {
  return { type: 'system', text, ts: now() };
}

function stripControlChars(str) {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function refillTokens(state) {
  const elapsed = now() - state.lastRefill;
  if (elapsed <= 0) return;
  const refill = elapsed / REFILL_MS;
  state.tokens = Math.min(BUCKET_MAX, state.tokens + refill);
  state.lastRefill = now();
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.state = {
    handle: null,
    tokens: BUCKET_MAX,
    lastRefill: now(),
  };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (ws.state.handle) return; // already joined
      const handle = typeof msg.handle === 'string' ? msg.handle.trim() : '';
      if (!HANDLE_RE.test(handle)) {
        sendTo(ws, { type: 'error', text: 'Invalid handle: 1-16 chars, letters/numbers/_.- only.' });
        return;
      }
      const lower = handle.toLowerCase();
      if (handles.has(lower)) {
        sendTo(ws, { type: 'error', text: `Handle "${handle}" is already taken.` });
        return;
      }
      ws.state.handle = handle;
      handles.set(lower, { handle, ws });

      sendTo(ws, { type: 'joined', handle });
      sendTo(ws, { type: 'history', messages: history });

      broadcast(systemMessage(`${handle} connected.`), { exceptWs: ws });
      broadcastPresence();
      return;
    }

    if (!ws.state.handle) return; // must join before anything else

    if (msg.type === 'chat') {
      refillTokens(ws.state);
      if (ws.state.tokens < 1) {
        sendTo(ws, { type: 'error', text: 'Rate limited: slow down.' });
        return;
      }
      let text = typeof msg.text === 'string' ? msg.text : '';
      text = stripControlChars(text).slice(0, MAX_MSG_LEN).trim();
      if (!text) return;
      ws.state.tokens -= 1;

      broadcast({
        type: 'chat',
        handle: ws.state.handle,
        text,
        action: !!msg.action,
        ts: now(),
      });
      return;
    }

    if (msg.type === 'nick') {
      refillTokens(ws.state);
      if (ws.state.tokens < 1) {
        sendTo(ws, { type: 'error', text: 'Rate limited: slow down.' });
        return;
      }
      const newHandle = typeof msg.handle === 'string' ? msg.handle.trim() : '';
      if (!HANDLE_RE.test(newHandle)) {
        sendTo(ws, { type: 'error', text: 'Invalid handle: 1-16 chars, letters/numbers/_.- only.' });
        return;
      }
      const newLower = newHandle.toLowerCase();
      const oldHandle = ws.state.handle;
      const oldLower = oldHandle.toLowerCase();
      if (newLower !== oldLower && handles.has(newLower)) {
        sendTo(ws, { type: 'error', text: `Handle "${newHandle}" is already taken.` });
        return;
      }
      ws.state.tokens -= 1;
      handles.delete(oldLower);
      handles.set(newLower, { handle: newHandle, ws });
      ws.state.handle = newHandle;

      sendTo(ws, { type: 'joined', handle: newHandle });
      broadcast(systemMessage(`${oldHandle} is now known as ${newHandle}.`));
      broadcastPresence();
      return;
    }
  });

  ws.on('close', () => {
    const handle = ws.state && ws.state.handle;
    if (handle) {
      handles.delete(handle.toLowerCase());
      broadcast(systemMessage(`${handle} disconnected.`));
      broadcastPresence();
    }
  });

  ws.on('error', () => {
    // 'close' will follow; nothing extra to do here.
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(pingInterval));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`terminal-chat listening on 0.0.0.0:${PORT}`);
});
