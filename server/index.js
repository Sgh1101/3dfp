'use strict';

/**
 * 3dfp 서버 진입점.
 *
 * - 같은 포트에서 정적 파일(public/)과 WebSocket을 함께 서비스한다.
 *   `npm install && npm start` → http://localhost:3000
 * - 20Hz 틱 루프가 모든 방의 상태를 갱신하고 스냅샷을 방송한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { RoomManager, ERROR, MAX_PLAYERS_PER_ROOM, DEFAULT_ROOM_CODE } = require('./rooms');
const { mapPayload } = require('./map');
const { TICK_MS, sanitizeName, publicConfig } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JOIN_TIMEOUT_MS = 15000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const rooms = new RoomManager();
const MAP_PAYLOAD = JSON.stringify(mapPayload());
const CONFIG_PAYLOAD = JSON.stringify(publicConfig());

// ── 정적 파일 서비스 ────────────────────────────────────────────────────────
function sendJSON(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  // 디렉터리 탈출 방지
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function serveStatic(req, res) {
  const filePath = resolvePublicPath(req.url || '/');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS' });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  if (url.startsWith('/api/map')) {
    sendJSON(res, 200, MAP_PAYLOAD);
    return;
  }
  if (url.startsWith('/api/health')) {
    let players = 0;
    let activeRooms = 0;
    for (const room of rooms.rooms.values()) {
      if (room.playerCount > 0) {
        activeRooms += 1;
        players += room.playerCount;
      }
    }
    sendJSON(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: rooms.rooms.size,
      activeRooms,
      players,
      defaultRoom: DEFAULT_ROOM_CODE,
      maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    });
    return;
  }
  if (url.startsWith('/api/config')) {
    sendJSON(res, 200, CONFIG_PAYLOAD);
    return;
  }
  serveStatic(req, res);
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, clientTracking: true });

/** @type {Map<string, {id: string, ws: any, room: any, name: string, joined: boolean}>} */
const clients = new Map();

function send(ws, message) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  } catch (err) {
    // 전송 실패는 소켓 종료로 이어진다.
  }
}

function broadcast(room, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.room === room) send(client.ws, data);
  }
}

function leaveRoom(client, reason) {
  if (!client.room) return;
  const room = client.room;
  room.game.removePlayer(client.id);
  client.room = null;
  if (reason) send(client.ws, { t: 'left', reason });
}

wss.on('connection', (ws) => {
  const id = crypto.randomBytes(4).toString('hex');
  const client = { id, ws, room: null, name: '플레이어', joined: false, joinAttempts: 0 };
  clients.set(id, client);

  let closed = false;
  const joinTimer = setTimeout(() => {
    if (!client.joined && !closed) {
      send(ws, { t: 'error', code: 'JOIN_TIMEOUT', message: '참여 시간 초과' });
      ws.close(4000, 'join timeout');
    }
  }, JOIN_TIMEOUT_MS);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', code: 'BAD_JSON', message: '잘못된 패킷' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      client.joinAttempts += 1;
      if (client.joinAttempts > 12) {
        send(ws, { t: 'error', code: 'RATE_LIMIT', message: '참여 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      if (client.room) {
        send(ws, { t: 'error', ...ERROR.ALREADY_IN_ROOM });
        return;
      }
      const name = sanitizeName(msg.name);
      const result = rooms.join(msg, client.id, name);
      if (result.error) {
        send(ws, { t: 'error', code: result.error.code, message: result.error.message });
        return;
      }
      client.room = result.room;
      client.name = name;
      client.joined = true;
      clearTimeout(joinTimer);
      send(ws, {
        t: 'welcome',
        id: client.id,
        code: result.room.code,
        isDefault: result.room.isDefault,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        map: JSON.parse(MAP_PAYLOAD),
        config: JSON.parse(CONFIG_PAYLOAD),
      });
      return;
    }

    if (!client.room) {
      send(ws, { t: 'error', code: 'NOT_JOINED', message: '먼저 방에 참여해야 합니다.' });
      return;
    }

    const game = client.room.game;
    switch (msg.t) {
      case 'm':
        game.handleMove(client.id, msg);
        break;
      case 'shoot':
        game.handleShoot(client.id, msg);
        break;
      case 'reload':
        game.handleReload(client.id);
        break;
      case 'swap':
        game.handleSwap(client.id, msg);
        break;
      case 'heal':
        game.handleHeal(client.id);
        break;
      case 'ready':
        game.handleReady(client.id);
        break;
      case 'ping':
        send(ws, { t: 'pong', c: msg.c ?? 0, now: Date.now() });
        break;
      case 'leave':
        leaveRoom(client, 'left');
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    closed = true;
    clearTimeout(joinTimer);
    leaveRoom(client, null);
    clients.delete(id);
  });

  ws.on('error', () => {
    // close 이벤트에서 정리된다.
  });
});

// 끊긴 소켓 정리(핑/퐁)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // 무시
    }
  }
}, 30000);
heartbeat.unref?.();

// ── 게임 루프 ───────────────────────────────────────────────────────────────
const tickLoop = setInterval(() => {
  const now = Date.now();
  const activeRooms = rooms.tick(now);
  for (const room of activeRooms) {
    const events = room.game.drainEvents();
    if (events.length) broadcast(room, { t: 'ev', events });

    for (const { id, message } of room.game.drainDirect()) {
      const target = clients.get(id);
      if (!target) continue;
      send(target.ws, message);
      if (message.t === 'kick') {
        target.ws.close(4001, 'kick');
      }
    }

    broadcast(room, room.game.snapshot());
  }
}, TICK_MS);
tickLoop.unref?.();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  // eslint-disable-next-line no-console
  console.log(`[3dfp] 서버 실행 중 → http://${shown}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[3dfp] 기본 방 코드: ${DEFAULT_ROOM_CODE} · 방 정원: ${MAX_PLAYERS_PER_ROOM}명 · 틱: ${TICK_MS}ms`);
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[3dfp] ${signal} 수신, 서버를 종료합니다.`);
  clearInterval(tickLoop);
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutdown');
    } catch {
      // 무시
    }
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
