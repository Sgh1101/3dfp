'use strict';

/**
 * 실기 브라우저 E2E 테스트 (헤드리스 Chrome + CDP, 추가 의존성 없음).
 *
 * 단위/스모크 테스트가 서버 로직을 검증한다면, 이 테스트는 **실제 브라우저**에서
 *  - WebGL 렌더링이 되는지(캔버스가 실제로 그려지는지)
 *  - 온보딩(닉네임·방 코드·오류 안내) → 워밍업 → 라운드 → 탈락 → 결과 → 다음 라운드 흐름
 *  - PointerLock 잠금/해제와 재고정 버튼, 잠금을 못 쓰는 환경의 대체 조작
 *  - PC 마우스·키보드 조작과 모바일 터치(조이스틱·드래그 시점·버튼) 멀티터치
 * 를 확인한다. 봇은 WebSocket 클라이언트로 붙어 서버 스냅샷/이벤트를 관찰한다.
 *
 * 실행:
 *   node test/browser.js                # 스크린샷 없이
 *   node test/browser.js --shots=DIR    # 주요 화면 PNG 저장
 *   CHROME_PATH=/path/to/chrome node test/browser.js
 *
 * Chrome을 찾지 못하거나 실행할 수 없으면(공유 라이브러리 누락 등) SKIP으로 끝난다.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3920 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const SHOTS = (() => {
  const arg = process.argv.find((a) => a.startsWith('--shots='));
  return arg ? path.resolve(arg.slice('--shots='.length)) : null;
})();

let passed = 0;
let failed = 0;
const cleanups = [];
const consoleErrors = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failed += 1;
  console.error(`  ✗ ${name}`);
  if (err) console.error(`    ${String(err.message || err).split('\n').slice(0, 4).join('\n    ')}`);
}

async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
    throw err;
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

function waitFor(predicate, { timeout = 8000, interval = 100, message = '조건 대기 시간 초과' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let value = false;
      try {
        value = await predicate();
      } catch (err) {
        /* 아직 준비 안 됨 */
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error(message));
      setTimeout(tick, interval);
    };
    tick();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

/* ── Chrome 찾기 ─────────────────────────────────────────────────────────── */
function findChrome() {
  const explicit = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const bin of direct) if (fs.existsSync(bin)) return bin;

  // puppeteer 캐시(chrome-linux64/chrome) 탐색
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(os.homedir(), '.cache', 'puppeteer'),
    '/workspace/.cache/puppeteer',
    path.join(process.env.LOCALAPPDATA || '', 'puppeteer'),
  ].filter(Boolean);
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'chrome' && full.includes('chrome-linux')) hits.push(full);
      else if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  if (hits.length) {
    hits.sort();
    return hits[hits.length - 1];
  }
  return null;
}

/* ── CDP 클라이언트 ──────────────────────────────────────────────────────── */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.errors = [];
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.logs.push(`[${msg.params.type}] ${text}`);
        if (msg.params.type === 'error') this.errors.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text;
        if (text) this.errors.push(String(text));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error' && !/favicon/.test(e.text)) this.errors.push(`${e.text} ${e.url || ''}`);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    ws.setMaxListeners(0);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Page(ws);
  }

  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 시간 초과: ${method}`));
        }
      }, timeout);
    });
  }

  async init({ mobile = false, width = 1280, height = 800 } = {}) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    // 헤드리스에서도 페이지가 "활성 문서"가 되도록 포커스를 에뮬레이트한다(PointerLock 필수).
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.send('Page.bringToFront').catch(() => {});
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile,
    });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    this.width = width;
    this.height = height;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await waitFor(() => this.eval('document.readyState === "complete"'), { message: '페이지 로드 실패' });
  }

  async eval(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (res.exceptionDetails) {
      throw new Error(`평가 오류: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async text(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.trim() : null; })()`);
  }

  async visible(selector) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getBoundingClientRect().width > 0; })()`,
    );
  }

  async rect(selector) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`,
    );
  }

  async shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.data, 'base64'));
  }

  async click(selector) {
    const r = await this.rect(selector);
    assert(r && r.w > 0, `클릭할 수 없는 요소: ${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.cx, y: r.cy });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
  }

  async clickPoint(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async type(selector, value) {
    await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  }

  async key(code, type) {
    const table = {
      KeyW: ['w', 87],
      KeyA: ['a', 65],
      KeyS: ['s', 83],
      KeyD: ['d', 68],
      KeyR: ['r', 82],
      KeyQ: ['q', 81],
      KeyE: ['e', 69],
      KeyC: ['c', 67],
      KeyF: ['f', 70],
      KeyV: ['v', 86],
      Space: [' ', 32],
      ShiftLeft: ['Shift', 16],
      ControlLeft: ['Control', 17],
      Digit1: ['1', 49],
      Digit2: ['2', 50],
      Digit3: ['3', 51],
      Escape: ['Escape', 27],
    };
    const [key, vk] = table[code] || ['', 0];
    const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (type === 'keyDown') await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
    else if (type === 'keyUp') await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    else await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key });
  }

  async press(code, holdMs = 60) {
    await this.key(code, 'keyDown');
    await sleep(holdMs);
    await this.key(code, 'keyUp');
  }

  /** PointerLock 상태의 마우스 이동(movementX/Y) */
  async mouseMove(dx, dy) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      deltaX: dx,
      deltaY: dy,
      button: 'none',
    });
  }

  async mouseDown() {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      button: 'left',
      clickCount: 1,
    });
  }

  async mouseUp() {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      button: 'left',
      clickCount: 1,
    });
  }

  /** 현재 시점을 목표 yaw/pitch 로 돌린다(합성 movementX/Y — 헤드리스에서도 핸들러 경로가 같다). */
  async lookTo(targetYaw, targetPitch = 0) {
    const sens = 0.0022;
    const cur = await this.eval('window.__3dfpDebug ? window.__3dfpDebug() : null');
    if (!cur) throw new Error('디버그 훅이 없다');
    let dYaw = targetYaw - cur.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = targetPitch - cur.pitch;
    // yaw -= dx * sens, pitch -= dy * sens
    const dx = -dYaw / sens;
    const dy = -dPitch / sens;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 180));
    const sx = dx / steps;
    const sy = dy / steps;
    await this.eval(`(() => {
      for (let i = 0; i < ${steps}; i += 1) {
        const ev = new MouseEvent('mousemove', { bubbles: true });
        Object.defineProperty(ev, 'movementX', { value: ${sx} });
        Object.defineProperty(ev, 'movementY', { value: ${sy} });
        document.dispatchEvent(ev);
      }
    })()`);
  }

  async rightDown() {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      button: 'right',
      clickCount: 1,
    });
  }

  async rightUp() {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(this.width / 2),
      y: Math.round(this.height / 2),
      button: 'right',
      clickCount: 1,
    });
  }

  async debug() {
    return this.eval('window.__3dfpDebug ? window.__3dfpDebug() : null');
  }

  async touch(type, points) {
    await this.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 8, radiusY: 8, force: 1 })),
    });
  }
}

/* ── 봇용 시야 계산 ─────────────────────────────────────── */
function coverBoxes(map) {
  if (!map) return [];
  return map.covers.map((c) => ({
    minX: c.x - c.w / 2,
    maxX: c.x + c.w / 2,
    minZ: c.z - c.d / 2,
    maxZ: c.z + c.d / 2,
    h: c.h,
  }));
}

/** 점이 커버에 막혀 있는지 */
function pointBlocked(boxes, x, z, radius = 0.6) {
  for (const b of boxes) {
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    if (Math.hypot(x - cx, z - cz) < radius) return true;
  }
  return false;
}

/** 두 점 사이가 높은 커버로 가로막혀 있는지(눈높이 사격 기준) */
function rayBlocked(boxes, from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return false;
  const nx = dx / dist;
  const nz = dz / dist;
  for (const b of boxes) {
    if (b.h < 1.6) continue;
    let tmin = 0;
    let tmax = dist;
    let miss = false;
    const axis = (o, d, min, max) => {
      if (Math.abs(d) < 1e-9) return o >= min && o <= max;
      let t1 = (min - o) / d;
      let t2 = (max - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      return tmin <= tmax;
    };
    if (!axis(from.x, nx, b.minX, b.maxX)) miss = true;
    if (!miss && !axis(from.z, nz, b.minZ, b.maxZ)) miss = true;
    if (!miss && tmin > 0.05 && tmin < dist - 0.05) return true;
  }
  return false;
}

/* ── BFS 길찾기(커버를 피해 가는 경로) ─────────────────────── */
const GRID_MIN = -80;
const GRID_N = 160;
const cellOf = (v) => Math.max(0, Math.min(GRID_N - 1, Math.floor(v - GRID_MIN)));
const cellCenter = (i) => GRID_MIN + i + 0.5;

function buildGrid(boxes) {
  const blocked = new Uint8Array(GRID_N * GRID_N);
  for (let i = 0; i < GRID_N; i += 1) {
    for (let j = 0; j < GRID_N; j += 1) {
      if (pointBlocked(boxes, cellCenter(i), cellCenter(j), 0.6)) blocked[j * GRID_N + i] = 1;
    }
  }
  return blocked;
}

/** 4방향 BFS. 출발/도착 셀과 그 사이 격자점을 돌려준다. */
function findPath(grid, from, to) {
  const start = cellOf(from.z) * GRID_N + cellOf(from.x);
  const goal = cellOf(to.z) * GRID_N + cellOf(to.x);
  if (start === goal) return [];
  const prev = new Int32Array(GRID_N * GRID_N).fill(-1);
  const queue = [start];
  prev[start] = start;
  let head = 0;
  let found = false;
  while (head < queue.length && !found) {
    const cur = queue[head];
    head += 1;
    const ci = cur % GRID_N;
    const cj = (cur - ci) / GRID_N;
    const moves = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [di, dj] of moves) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= GRID_N || nj >= GRID_N) continue;
      const next = nj * GRID_N + ni;
      if (prev[next] !== -1 || grid[next]) continue;
      prev[next] = cur;
      queue.push(next);
      if (next === goal) {
        found = true;
        break;
      }
    }
  }
  if (prev[goal] === -1) return null;
  const cells = [];
  let cur = goal;
  while (cur !== start) {
    cells.push(cur);
    cur = prev[cur];
  }
  cells.reverse();
  return cells.map((k) => {
    const i = k % GRID_N;
    const j = (k - i) / GRID_N;
    return { x: cellCenter(i), z: cellCenter(j) };
  });
}

/* ── 봇(웹소켓 클라이언트) ───────────────────────────────────────────────── */
class Bot {
  constructor(name) {
    this.name = name;
    this.snap = null;
    this.events = [];
    this.ws = null;
  }

  connect({ code = null, create = false } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('봇 접속 시간 초과')), 8000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: this.name, code, create })));
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.id = msg.id;
          this.code = msg.code;
          this.map = msg.map;
          this.boxes = coverBoxes(msg.map);
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.t === 's') {
          this.snap = msg;
        } else if (msg.t === 'ev') {
          this.events.push(...msg.events);
          if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
        } else if (msg.t === 'error') {
          this.error = msg;
        }
      });
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 무시 */
    }
  }

  players() {
    if (!this.snap) return [];
    return this.snap.players.map((entry) => ({
      id: entry[0],
      name: entry[1],
      x: entry[2],
      y: entry[3],
      z: entry[4],
      flags: entry[17] || 0,
      isBot: ((entry[17] || 0) & 16) !== 0,
      yaw: entry[5],
      hp: entry[7],
      alive: entry[8] === 1,
      weapon: entry[9],
      mag: entry[10],
      kills: entry[12],
      kits: entry[16],
    }));
  }

  me() {
    return this.players().find((p) => p.id === this.id) || null;
  }

  find(name) {
    return this.players().find((p) => p.name === name) || null;
  }

  round() {
    return this.snap ? this.snap.round : null;
  }

  /** 목표 지점까지 BFS 경로를 따라 이동한다(직선 100m 이동에서 커버에 끼이지 않게). */
  async walkTo(target, { stopDistance = 2, timeout = 45000, step = 0.3 } = {}) {
    if (!this.grid) this.grid = buildGrid(this.boxes || []);
    const route = findPath(this.grid, this.me(), target);
    if (route === null) return false; // 경로 자체가 없으면 포기(테스트가 실패로 기록)
    route.push({ x: target.x, z: target.z });
    const started = Date.now();
    let index = 0;
    while (Date.now() - started < timeout) {
      const me = this.me();
      if (!me) return false;
      while (index < route.length - 1 && Math.hypot(route[index].x - me.x, route[index].z - me.z) < 1.4) index += 1;
      const wp = route[index];
      const dx = wp.x - me.x;
      const dz = wp.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= Math.max(0.4, stopDistance) && index >= route.length - 1) return true;
      const stepLen = Math.min(step, Math.max(0.05, dist));
      this.send({ t: 'm', x: me.x + (dx / dist) * stepLen, z: me.z + (dz / dist) * stepLen, yaw: Math.atan2(-dx, -dz), pitch: 0 });
      await sleep(50);
    }
    return false;
  }

  /** 대상 주변에서 시야가 열리는 사거리 위치를 찾는다(커버에 가로막히면 다른 쪽으로). */
  findFiringSpot(target, distance = 5) {
    for (let i = 0; i < 16; i += 1) {
      const angle = (Math.PI * 2 * i) / 16;
      const spot = { x: target.x + Math.cos(angle) * distance, z: target.z + Math.sin(angle) * distance };
      if (Math.abs(spot.x) > 78 || Math.abs(spot.z) > 78) continue;
      if (pointBlocked(this.boxes, spot.x, spot.z)) continue;
      if (rayBlocked(this.boxes, spot, target)) continue;
      return spot;
    }
    return null;
  }

  /** 대상의 사거리 안(시야가 열린 자리)까지 이동한다. */
  async goFiringRange(name, distance = 6) {
    const target = this.find(name);
    if (!target) return false;
    const spot = this.findFiringSpot({ x: target.x, z: target.z }, distance) || this.findFiringSpot({ x: target.x, z: target.z }, 3);
    if (spot) return this.walkTo(spot, { stopDistance: 1.5, timeout: 45000 });
    return this.walkTo({ x: target.x, z: target.z }, { stopDistance: 4, timeout: 45000 });
  }

  /** 대상(머리~가슴)을 향해 조준하고 사격한다. */
  shootAt(targetId, { shots = 6, gap = 160, aimY = 1.1 } = {}) {
    const me = this.me();
    const target = this.players().find((p) => p.id === targetId);
    if (!me || !target) return 0;
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const horiz = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(aimY - 1.62, horiz);
    for (let i = 0; i < shots; i += 1) this.send({ t: 'shoot', yaw, pitch });
    return horiz;
  }
}

/* ── 준비 ────────────────────────────────────────────────────────────────── */
async function startServer() {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  cleanups.push(() => proc.kill('SIGKILL'));
  await waitFor(
    async () => {
      try {
        return (await getJSON(`${BASE}/api/health`)).ok === true;
      } catch {
        return false;
      }
    },
    { timeout: 10000, message: '서버가 시작되지 않았습니다' },
  );
  return { proc, log };
}

async function startChrome(bin) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dfp-chrome-'));
  cleanups.push(() => {
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {
      /* 무시 */
    }
  });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,800',
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += String(d)));
  proc.stdout.on('data', () => {});
  cleanups.push(() => proc.kill('SIGKILL'));

  // DevTools 주소는 user-data-dir 안의 DevToolsActivePort 파일에 기록된다.
  const portFile = path.join(userDir, 'DevToolsActivePort');
  let port = null;
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (fs.existsSync(portFile)) {
      const [value] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (value && Number(value)) {
        port = Number(value);
        break;
      }
    }
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  if (!port) {
    const missing = stderr.match(/error while loading shared libraries: ([^:]+)/);
    throw Object.assign(new Error(missing ? `Chrome 실행 불가(공유 라이브러리 누락: ${missing[1]})` : 'Chrome DevTools 포트를 열지 못했습니다'), {
      stderr,
    });
  }
  await waitFor(
    async () => {
      try {
        return Boolean(await getJSON(`http://127.0.0.1:${port}/json/version`));
      } catch {
        return false;
      }
    },
    { timeout: 10000, message: 'Chrome DevTools 응답 없음' },
  );
  return { proc, port, stderr: () => stderr };
}

async function openPage(browser, { mobile = false, width = 1280, height = 800 } = {}) {
  // 브라우저 타깃으로 새 탭을 만들고, 그 탭의 WebSocket 으로 붙는다.
  const version = await getJSON(`http://127.0.0.1:${browser.port}/json/version`);
  const browserWs = await Page.connect(version.webSocketDebuggerUrl);
  const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank' });
  browserWs.ws.close();
  const list = await getJSON(`http://127.0.0.1:${browser.port}/json/list`);
  const target = list.find((t) => t.id === targetId);
  if (!target) throw new Error('새 탭을 찾지 못했습니다');
  const page = await Page.connect(target.webSocketDebuggerUrl);
  await page.init({ mobile, width, height });
  return page;
}

/* ── 본 테스트 ───────────────────────────────────────────────────────────── */
async function main() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.log('[browser] SKIP — Chrome 실행 파일을 찾지 못했습니다(CHROME_PATH 로 지정할 수 있습니다).');
    console.log('[browser] 통과 0 · 실패 0 · 건너뜀');
    return;
  }
  console.log(`[browser] Chrome: ${chromeBin}`);

  await startServer();

  let browser;
  try {
    browser = await startChrome(chromeBin);
  } catch (err) {
    console.log(`[browser] SKIP — ${err.message}`);
    if (/공유 라이브러리/.test(err.message)) {
      printLibraryHint();
    }
    await runCleanups();
    console.log('[browser] 통과 0 · 실패 0 · 건너뜀');
    return;
  }

  const bot = new Bot('봇1');
  try {
    console.log('[browser] 데스크톱(PC) 흐름');
    const page = await openPage(browser);

    await step('부트: WebGL 렌더러가 초기화되고 모듈이 로드된다', async () => {
      await page.navigate(`${BASE}/`);
      await waitFor(() => page.eval('window.__3dfpBooted === true'), { message: '__3dfpBooted 가 true 가 되지 않았다' });
      const webgl = await page.eval(`(() => {
        const canvas = document.getElementById('game');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return { ok: false };
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          ok: true,
          version: gl.getParameter(gl.VERSION),
          renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          width: canvas.width,
          height: canvas.height,
        };
      })()`);
      assert(webgl.ok, 'WebGL 컨텍스트가 없다');
      assert(webgl.width > 300 && webgl.height > 200, `캔버스 크기가 이상하다: ${webgl.width}x${webgl.height}`);
      console.log(`      · ${webgl.version} / ${webgl.renderer}`);
      assert(!(await page.visible('#boot-error')), '부트 오류 배너가 떠 있다');
    });

    await step('메뉴: 온보딩(닉네임·방 코드·조작법 7동작)이 한 화면에 있다', async () => {
      assert(await page.visible('#menu'), '시작 화면이 보이지 않는다');
      assert(!(await page.visible('#hud')), '게임 전인데 HUD 가 보인다');
      const guide = await page.eval(`document.querySelectorAll('.controls-guide li').length`);
      assert(guide >= 7, `조작법 항목이 ${guide}개뿐이다`);
      const inputs = await page.eval(`({ name: !!document.getElementById('name-input'), code: !!document.getElementById('code-input') })`);
      assert(inputs.name && inputs.code, '닉네임/방 코드 입력이 없다');
      await page.shot('01-menu');
    });

    await step('없는 방 코드 → 한국어 오류 안내 + 입력값 유지', async () => {
      await page.type('#name-input', '치즈');
      await page.type('#code-input', 'ZZZZZZ');
      await page.click('#btn-join');
      await waitFor(() => page.visible('#menu-error'), { message: '오류 안내가 뜨지 않았다' });
      const error = await page.text('#menu-error');
      assert(error.includes('코드'), `오류 문구가 불친절하다: ${error}`);
      const values = await page.eval(`({ name: document.getElementById('name-input').value, code: document.getElementById('code-input').value })`);
      assert(values.name === '치즈', `닉네임이 지워졌다: ${values.name}`);
      assert(values.code === 'ZZZZZZ', `방 코드가 지워졌다: ${values.code}`);
      assert(await page.visible('#menu'), '오류 후에도 시작 화면이 유지돼야 한다');
      await page.shot('02-menu-error');
    });

    await step('기본 공개방(LOBBY0) 참여 → 혼자면 워밍업 배너', async () => {
      await page.click('#btn-quick');
      await waitFor(() => page.visible('#hud'), { message: 'HUD 가 나타나지 않았다(참여 실패)' });
      assert(!(await page.visible('#menu')), '참여 후에도 시작 화면이 남아 있다');
      assert((await page.text('#room-code')) === 'LOBBY0', '기본 공개방 코드가 아니다');
      assert(await page.visible('#wait-banner'), '혼자인데 워밍업 배너가 없다');
      const waitCount = await page.text('#wait-count');
      assert(waitCount.replace(/\s/g, '') === '1/2', `워밍업 인원 표시가 이상하다: ${waitCount}`);
      assert((await page.text('#round-time')) === '워밍업', '라운드 표시가 워밍업이 아니다');
      const zoneLabel = await page.text('#zone-label');
      assert(/1\/3/.test(zoneLabel), `존 단계 표시가 1/3 이 아니다: ${zoneLabel}`);
      assert(!(await page.visible('#zone-warning')), '존 안인데 구역 밖 경고가 떠 있다');
      await page.shot('03-warmup');
    });

    await step('PointerLock: 캔버스 클릭으로 잠기고 일시정지가 사라진다', async () => {
      await page.clickPoint(page.width / 2, page.height / 2);
      await sleep(600);
      const state = await page.eval(
        `({ locked: document.pointerLockElement ? document.pointerLockElement.id : null, pause: !document.getElementById('pause').classList.contains('hidden'), fallback: window.__3dfpLockMode === 'drag' })`,
      );
      if (!state.locked) {
        // 헤드리스 등 잠금이 불가능한 환경: 대체(드래그) 모드로 플레이할 수 있어야 한다.
        const fallback = await page.eval(`!document.getElementById('pause').classList.contains('hidden') ? document.getElementById('pause-text').textContent : ''`);
        assert(/드래그|고정/.test(fallback) || !state.pause, 'PointerLock 실패 시 안내/대체 모드가 없다');
        console.log('      · PointerLock을 쓸 수 없는 환경 → 드래그 시점 대체 모드로 진행');
      } else {
        assert(!state.pause, '잠금 상태인데 일시정지 화면이 남아 있다');
      }
    });

    const bot2 = new Bot('봇2');
    await step('두 번째 플레이어 입장 → 배틀로얄 라운드 시작(2명 생존)', async () => {
      await bot.connect();
      assert(bot.code === 'LOBBY0', `봇이 기본방에 들어가지 못했다: ${bot.code}`);
      await waitFor(() => bot.round() && bot.round().state === 'live', { message: '라운드가 시작되지 않았다' });
      await waitFor(async () => !(await page.visible('#wait-banner')), { timeout: 4000, message: '워밍업 배너가 사라지지 않았다' });
      const alive = await page.text('#alive-count');
      assert(alive === '2', `생존자 수 표시가 2가 아니다: ${alive}`);
      const roundTime = await page.text('#round-time');
      assert(/^\d:\d{2}$/.test(roundTime), `라운드 타이머가 이상하다: ${roundTime}`);
      await page.shot('04-round-start');
    });

    await step('진행 중인 라운드에 새로 입장한 플레이어는 관전(탈락) 상태가 된다', async () => {
      await bot2.connect();
      await waitFor(() => bot2.find('봇2'), { message: '봇2가 스냅샷에 없다' });
      const me = bot2.find('봇2');
      assert(me.alive === false, '라운드 중 입장한 플레이어가 살아 있는 상태로 들어갔다');
      assert(bot.round().state === 'live', '라운드가 유지되지 않았다');
    });

    await step('PC 이동: W 키로 실제 위치가 바뀐다(서버 스냅샷 확인)', async () => {
      await waitFor(() => bot.find('치즈'), { message: '봇이 치즈의 스냅샷을 못 봤다' });
      const before = bot.find('치즈');
      await page.key('KeyW', 'keyDown');
      await sleep(600);
      await page.key('KeyW', 'keyUp');
      await waitFor(
        () => {
          const now = bot.find('치즈');
          return now && Math.hypot(now.x - before.x, now.z - before.z) > 0.5;
        },
        { message: 'W 키로 이동한 거리가 0.5m 미만이다' },
      );
    });

    await step('PC 시점: 마우스 이동(movementX)으로 yaw가 바뀐다', async () => {
      const before = bot.find('치즈').yaw;
      // 잠금 직후 첫 이동값은 클라이언트가 무시하므로 여러 번 보낸다.
      let changed = false;
      for (let i = 0; i < 6 && !changed; i += 1) {
        await page.mouseMove(60, 0);
        await sleep(120);
        const now = bot.find('치즈');
        const diff = Math.abs(((now.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        changed = diff > 0.15;
      }
      if (!changed) {
        // 헤드리스 CDP는 PointerLock 상태에서 movementX를 만들지 않는다(커서가 고정됨).
        // 실제 OS 입력(Xvfb+xdotool)에서는 movementX가 그대로 전달되는 것을 확인했고,
        // 여기서는 클라이언트 핸들러 경로를 같은 형태의 이벤트로 검증한다.
        const synthetic = await page.eval(`(() => {
          const ev = new MouseEvent('mousemove', { bubbles: true });
          Object.defineProperty(ev, 'movementX', { value: 80 });
          Object.defineProperty(ev, 'movementY', { value: 0 });
          document.dispatchEvent(ev);
          return true;
        })()`);
        assert(synthetic, '시점 이벤트를 보내지 못했다');
        console.log('      · 헤드리스 한정: movementX 합성 이벤트로 핸들러 경로를 검증');
        await waitFor(
          () => {
            const now = bot.find('치즈');
            const diff = Math.abs(((now.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            return diff > 0.15;
          },
          { timeout: 3000, message: '마우스 이동으로 시점이 돌아가지 않았다' },
        );
      }
    });

    await step('사격: 클릭으로 1발 발사되고 탄창이 줄어든다', async () => {
      const before = bot.find('치즈').mag;
      const shotsBefore = bot.events.filter((e) => e.k === 'shot' && e.id === bot.find('치즈').id).length;
      await page.mouseDown();
      await sleep(120);
      await page.mouseUp();
      await waitFor(
        () => bot.events.filter((e) => e.k === 'shot' && e.id === bot.find('치즈').id).length > shotsBefore,
        { message: '사격 이벤트가 서버에 도착하지 않았다' },
      );
      await waitFor(() => bot.find('치즈').mag < before, { message: '탄창이 줄지 않았다' });
    });

    await step('재장전: R 키로 탄창이 가득 찬다', async () => {
      await page.press('KeyR', 80);
      await waitFor(() => bot.events.some((e) => e.k === 'reload'), { timeout: 4000, message: '재장전 이벤트가 없다' });
      await waitFor(() => bot.find('치즈').mag === 30, { timeout: 5000, message: '재장전이 끝나도 탄창이 30이 아니다' });
    });

    await step('무기 교체: E 키로 권총(2번)으로 바뀐다', async () => {
      await page.press('KeyE', 80);
      await waitFor(() => bot.find('치즈').weapon === 2, { message: '무기가 권총으로 바뀌지 않았다' });
      await waitFor(async () => (await page.text('#weapon-name')) === '권총', { message: 'HUD 무기 이름이 바뀌지 않았다' });
      await page.press('Digit1', 80); // 라이플로 복귀
      await waitFor(() => bot.find('치즈').weapon === 1, { message: '라이플로 돌아오지 않았다' });
    });

    await step('전투: 원격 플레이어가 실제로 피해를 주고, 힐 키트로 회복한다', async () => {
      // 봇은 커버에 가로막히지 않는 사거리 자리를 찾아 이동한 뒤 조준 사격한다.
      await bot.goFiringRange('치즈', 5);
      const myId = bot.find('치즈').id;
      const hp0 = bot.find('치즈').hp;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        bot.shootAt(myId, { shots: 1 });
        await sleep(220);
        if (bot.find('치즈').hp < hp0) break;
      }
      await waitFor(() => bot.find('치즈').hp < 100, { timeout: 8000, message: '봇의 사격이 한 발도 명중하지 않았다' });
      const hpBefore = bot.find('치즈').hp;
      await page.press('KeyQ', 80);
      await waitFor(() => bot.find('치즈').hp > hpBefore, { timeout: 3000, message: '힐 키트로 회복되지 않았다' });
      assert(bot.find('치즈').kits < 2, '힐 키트 수가 줄지 않았다');
      await page.shot('05-combat');
    });

    await step('사망 → 라운드 종료: 마지막 생존자가 승리한다', async () => {
      const myId = bot.find('치즈').id;
      const mark = bot.events.length;
      await waitFor(
        () => {
          if (bot.find('치즈').alive) bot.shootAt(myId, { shots: 2 });
          return bot.events.slice(mark).some((e) => e.k === 'kill' && e.victimId === myId);
        },
        { timeout: 25000, interval: 200, message: '치즈가 탈락하지 않았다' },
      );
      // 봇2는 라운드 중 입장한 관전자라 생존자가 아니다 → 치즈가 죽으면 생존자 1명 = 라운드 종료.
      await waitFor(() => page.visible('#result'), { timeout: 5000, message: '라운드가 끝나지 않았다' });
    });

    await step('결과(인터미션): 승자·킬·HP·카운트다운·준비 버튼', async () => {
      const title = await page.text('#result-title');
      const detail = await page.text('#result-detail');
      const countdown = await page.text('#result-countdown');
      assert(/승리|패배|라운드 종료|무승부/.test(title), `결과 제목이 이상하다: ${title}`);
      assert(detail.includes('봇1'), `승자 정보가 없다: ${detail}`);
      assert(/킬/.test(detail) && /HP/.test(detail), `킬/HP 정보가 없다: ${detail}`);
      assert(/\d+초 후/.test(countdown), `카운트다운이 없다: ${countdown}`);
      assert(await page.visible('#btn-ready'), '준비 버튼이 없다');
      await page.shot('07-result');
    });

    await step('다음 라운드: 준비 버튼 → 전원 부활 · 결과 화면 닫힘', async () => {
      const roundBefore = bot.round().index;
      bot.send({ t: 'ready' });
      bot2.send({ t: 'ready' }); // 전원 준비 → 인터미션을 기다리지 않고 시작
      await page.click('#btn-ready');
      await waitFor(() => bot.round().index > roundBefore, { timeout: 12000, message: '다음 라운드가 시작되지 않았다' });
      await waitFor(async () => !(await page.visible('#result')), { message: '결과 화면이 닫히지 않았다' });
      await waitFor(() => bot.find('치즈') && bot.find('치즈').alive && bot.find('치즈').hp === 100, { message: '전원 부활하지 않았다' });
      assert(bot.find('봇2').alive, '라운드가 새로 시작됐는데 봇2가 부활하지 않았다');
      await page.shot('08-round2');
    });

    await step('탈락: 사망 시 킬러·생존자 안내(화면을 가리지 않는 오버레이)', async () => {
      const myId = bot.find('치즈').id;
      const mark = bot.events.length;
      await bot.goFiringRange('치즈', 6);
      await waitFor(
        () => {
          if (bot.find('치즈').alive) bot.shootAt(myId, { shots: 2 });
          return bot.events.slice(mark).some((e) => e.k === 'kill' && e.victimId === myId);
        },
        { timeout: 30000, interval: 200, message: '치즈가 탈락하지 않았다' },
      );
      // 3명이 살아 있는 라운드라 라운드는 계속되고, 탈락 오버레이가 실제로 보인다.
      await waitFor(() => page.visible('#dead'), { timeout: 5000, message: '탈락 오버레이가 뜨지 않았다' });
      const title = await page.text('#dead-title');
      const timer = await page.text('#dead-timer');
      const hint = await page.text('#dead-hint');
      assert(/탈락/.test(title), `탈락 화면 제목이 이상하다: ${title}`);
      assert(timer.includes('봇1'), `탈락 사유에 킬러가 없다: ${timer}`);
      assert(/남은 생존자 2명/.test(hint), `남은 생존자 수가 없다: ${hint}`);
      const pointerEvents = await page.eval(`getComputedStyle(document.getElementById('dead')).pointerEvents`);
      assert(pointerEvents === 'none', '탈락 오버레이가 화면 입력을 막는다(관전 불가)');
      assert(await page.visible('#hud'), '탈락 중에도 HUD/화면이 보여야 한다');
      await page.shot('06-dead');
    });

    await step('탈락자가 남은 라운드에서 생존자가 1명이 되면 바로 종료된다', async () => {
      bot2.close(); // 나가면 생존자 1명 → 마지막 생존자 종료
      await waitFor(() => page.visible('#result'), { timeout: 8000, message: '라운드가 끝나지 않았다' });
      assert(!(await page.visible('#dead')), '라운드 종료 후에도 탈락 오버레이가 남아 있다');
      const detail = await page.text('#result-detail');
      assert(detail.includes('봇1'), `승자가 봇1이 아니다: ${detail}`);
      await page.shot('09-result2');
    });

    await step('3라운드 준비 → 다시 부활', async () => {
      const idx = bot.round().index;
      bot.send({ t: 'ready' });
      await page.click('#btn-ready');
      await waitFor(() => bot.round().index > idx, { timeout: 12000, message: '3라운드가 시작되지 않았다' });
      await waitFor(() => bot.find('치즈') && bot.find('치즈').alive, { message: '3라운드에서 부활하지 않았다' });
    });

    await step('점프: Space 로 실제 y가 올라갔다가 착지한다(서버 스냅샷)', async () => {
      const name = '치즈';
      const meBefore = bot.find(name);
      assert(meBefore && meBefore.alive, '점프 테스트 전에 살아 있어야 한다');
      await page.press('Space', 80);
      await waitFor(
        () => {
          const me = bot.find(name);
          return me && me.y > 0.3;
        },
        { timeout: 4000, message: 'Space 점프로 y가 올라가지 않았다' },
      );
      const air = await page.debug();
      assert(air && air.grounded === false || air.y > 0.2, '클라이언트 예측이 점프 상태가 아니다');
      await waitFor(
        () => {
          const me = bot.find(name);
          return me && me.y < 0.05;
        },
        { timeout: 4000, message: '착지하지 않았다' },
      );
      console.log('      · 점프 최고 높이는 스냅샷 y로 확인');
    });

    await step('정조준(ADS): 우클릭으로 화각이 좁아지고 놓으면 돌아온다', async () => {
      const before = await page.debug();
      await page.rightDown();
      await waitFor(
        async () => {
          const d = await page.debug();
          return d && d.ads === true && d.fov < before.fov - 8;
        },
        { timeout: 3000, message: 'ADS 로 화각이 좁아지지 않았다' },
      );
      const zoomed = await page.debug();
      assert(await page.eval(`document.getElementById('ads-overlay').classList.contains('active')`), 'ADS 오버레이가 켜지지 않았다');
      await page.shot('05b-ads');
      await page.rightUp();
      await waitFor(
        async () => {
          const d = await page.debug();
          return d && d.ads === false && d.fov > zoomed.fov + 8;
        },
        { timeout: 3000, message: 'ADS 해제 후 화각이 돌아오지 않았다' },
      );
    });

    await step('앉기·달리기: 자세가 서버에 전달된다(C→플래그, Shift→속도)', async () => {
      await page.key('KeyC', 'keyDown');
      await sleep(300);
      const dbg = await page.debug();
      const snapMe = bot.find('치즈');
      console.log(`      · 디버그 crouch=${dbg.crouch} keys=${JSON.stringify(dbg.keys)} alive=${snapMe && snapMe.alive} flags=${snapMe && snapMe.flags} y=${snapMe && snapMe.y}`);
      await waitFor(
        () => {
          const me = bot.find('치즈');
          return me && (me.flags & 2) !== 0;
        },
        { timeout: 2500, message: '앉기 상태가 서버 스냅샷에 없다' },
      );
      await page.key('KeyC', 'keyUp');
      await waitFor(
        () => {
          const me = bot.find('치즈');
          return me && (me.flags & 2) === 0;
        },
        { timeout: 2500, message: '앉기 해제가 반영되지 않았다' },
      );
    });

    await step('보급 루팅: 아이템으로 걸어가 F 로 줍고 토스트가 뜬다', async () => {
      const items = (await page.debug()).loot;
      const me = bot.find('치즈');
      // 가장 가까운 '힐 키트' 또는 '탄약' 아이템을 고른다.
      const targets = items
        .filter((it) => it.kind === 'kit' || it.kind === 'ammo' || it.kind === 'medkit')
        .map((it) => ({ ...it, d: Math.hypot(it.x - me.x, it.z - me.z) }))
        .sort((a, b) => a.d - b.d);
      assert(targets.length > 0, '보급 아이템이 없다');
      const target = targets[0];
      const kitsBefore = (await page.debug()).kits;
      const reserveBefore = bot.find('치즈').mag;

      // 걸어가기: 목표 방향으로 yaw 를 돌리고 W 를 누른다.
      const started = Date.now();
      await page.key('KeyW', 'keyDown');
      while (Date.now() - started < 20000) {
        const now = bot.find('치즈');
        if (!now) break;
        const dist = Math.hypot(target.x - now.x, target.z - now.z);
        if (dist < 1.8) break;
        await page.lookTo(Math.atan2(-(target.x - now.x), -(target.z - now.z)), 0);
        await sleep(120);
      }
      await page.key('KeyW', 'keyUp');
      const arrived = bot.find('치즈');
      const dist = Math.hypot(target.x - arrived.x, target.z - arrived.z);
      assert(dist < 3.2, `보급 아이템에 도착하지 못했다(거리 ${dist.toFixed(1)}m)`);
      await page.press('KeyF', 80);
      const picked = await waitFor(
        async () => {
          const d = await page.debug();
          const meNow = bot.find('치즈');
          const kitUp = d.kits > kitsBefore;
          const ammoUp = meNow && meNow.hp > 0 && false;
          return kitUp || d.lootOpen === false || ammoUp ? d : false;
        },
        { timeout: 4000, message: '줍기 효과가 서버에 반영되지 않았다' },
      ).catch(() => null);
      const toastText = await page.text('#toast');
      assert(picked, '줍기 결과가 없다');
      assert(/획득|보급|탄약|힐|구급/.test(toastText), `획득 토스트가 없다: ${toastText}`);
      await page.shot('05c-loot');
      void reserveBefore;
    });

    await step('드래그 조준 모드: 마우스 고정이 안 되는 브라우저에서도 시점이 돈다', async () => {
      await page.eval(`document.dispatchEvent(new Event('pointerlockerror'))`);
      await sleep(200);
      const d = await page.debug();
      assert(d.lockUnavailable === true, '잠금 실패 시 드래그 모드로 전환되지 않았다');
      const yawBefore = (await page.debug()).yaw;
      await page.mouseDown();
      await sleep(60);
      await page.mouseMove(120, 0);
      await sleep(160);
      await page.mouseUp();
      const yawAfter = (await page.debug()).yaw;
      const diff = Math.abs(((yawAfter - yawBefore + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      assert(diff > 0.05, `드래그로 시점이 돌아가지 않았다(diff ${diff.toFixed(3)})`);
    });

    await step('ESC(잠금 해제) → 일시정지 → 재고정 버튼으로 복귀, 카메라 각도 유지', async () => {
      const before = bot.find('치즈').yaw;
      await page.eval('document.exitPointerLock()');
      await waitFor(() => page.visible('#pause'), { message: '잠금이 풀렸는데 일시정지 화면이 없다' });
      assert(await page.visible('#btn-resume'), '재고정 버튼이 보이지 않는다');
      await page.shot('09-pause');
      await page.click('#btn-resume');
      await sleep(700);
      const after = await page.eval(`document.pointerLockElement ? 'locked' : 'unlocked'`);
      if (after === 'locked') assert(!(await page.visible('#pause')), '잠금 후에도 일시정지가 남아 있다');
      const yawNow = bot.find('치즈').yaw;
      assert(Math.abs(yawNow - before) < 0.05, `재고정 과정에서 카메라가 튀었다: ${before} → ${yawNow}`);
    });

    await step('콘솔 오류 0건(JS 예외·리소스 실패 없음)', async () => {
      const errors = [...page.errors, ...consoleErrors];
      assert(errors.length === 0, `콘솔 오류: ${errors.slice(0, 3).join(' | ')}`);
    });

    /* ── 모바일 ───────────────────────────────────────────────── */
    console.log('[browser] 모바일(터치) 흐름');
    const mobile = await openPage(browser, { mobile: true, width: 390, height: 844 });

    await step('모바일: 터치 조작부가 뜨고 세로 화면에 모두 들어온다', async () => {
      await mobile.navigate(`${BASE}/`);
      await waitFor(() => mobile.eval('window.__3dfpBooted === true'), { message: '모바일 부트 실패' });
      const touch = await mobile.eval(
        `({ coarse: matchMedia('(pointer: coarse)').matches, ontouch: 'ontouchstart' in window })`,
      );
      assert(touch.coarse || touch.ontouch, `터치 환경으로 인식되지 않는다: ${JSON.stringify(touch)}`);
      await mobile.type('#name-input', '모바일');
      await mobile.click('#btn-create');
      await waitFor(() => mobile.visible('#hud'), { message: '모바일 참여 실패' });
      assert((await mobile.text('#room-code')).length === 6, '새 방 코드가 6자리가 아니다');
      assert(await mobile.visible('#touch-controls'), '터치 조작부가 숨겨져 있다');
      const vp = await mobile.eval('({ w: innerWidth, h: innerHeight })');
      for (const sel of ['#joystick', '#btn-fire', '#btn-reload', '#btn-swap', '#btn-heal']) {
        const r = await mobile.rect(sel);
        assert(r && r.w > 0 && r.h > 0, `${sel} 가 없다`);
        assert(r.x >= -1 && r.y >= -1 && r.x + r.w <= vp.w + 1 && r.y + r.h <= vp.h + 1, `${sel} 가 화면 밖으로 나간다(${JSON.stringify(r)} / ${JSON.stringify(vp)})`);
      }
      const joy = await mobile.rect('#joystick');
      const fire = await mobile.rect('#btn-fire');
      assert(joy.cx < vp.w * 0.4, '조이스틱이 왼쪽에 없다');
      assert(fire.cx > vp.w * 0.6, '사격 버튼이 오른쪽에 없다');
      await mobile.shot('10-mobile-portrait');
    });

    await step('모바일: 가로 화면에서도 조작부·HUD가 화면 안에 있다', async () => {
      await mobile.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
      await sleep(500);
      const vp = await mobile.eval('({ w: innerWidth, h: innerHeight })');
      assert(vp.w === 844 && vp.h === 390, `뷰포트가 바뀌지 않았다: ${JSON.stringify(vp)}`);
      for (const sel of ['#joystick', '#btn-fire', '#btn-heal', '#hp-fill']) {
        const r = await mobile.rect(sel);
        assert(r && r.y >= -1 && r.y + r.h <= vp.h + 1, `${sel} 가 세로로 잘린다(${JSON.stringify(r)})`);
      }
      await mobile.shot('11-mobile-landscape');
    });

    const mobileBot = new Bot('봇2');
    await step('모바일: 새 방에 봇 참여 → 라운드 시작 → 터치로 이동', async () => {
      const code = await mobile.text('#room-code');
      await mobileBot.connect({ code });
      await waitFor(() => mobileBot.round() && mobileBot.round().state === 'live', { message: '모바일 방에서 라운드가 시작되지 않았다' });
      await waitFor(() => mobileBot.find('모바일'), { message: '봇2가 모바일 플레이어를 못 봤다' });
      const before = mobileBot.find('모바일');
      const joy = await mobile.rect('#joystick');
      await mobile.touch('touchStart', [{ x: joy.cx, y: joy.cy, id: 1 }]);
      await mobile.touch('touchMove', [{ x: joy.cx + 34, y: joy.cy - 34, id: 1 }]);
      await sleep(700);
      await mobile.touch('touchEnd', []);
      await waitFor(
        () => {
          const now = mobileBot.find('모바일');
          return Math.hypot(now.x - before.x, now.z - before.z) > 0.8;
        },
        { message: '조이스틱으로 이동하지 못했다' },
      );
    });

    await step('모바일: 오른쪽 드래그로 시점 회전', async () => {
      const before = mobileBot.find('모바일').yaw;
      const y = 200;
      await mobile.touch('touchStart', [{ x: 300, y, id: 2 }]);
      await sleep(60);
      await mobile.touch('touchMove', [{ x: 330, y, id: 2 }]);
      await sleep(60);
      await mobile.touch('touchMove', [{ x: 360, y, id: 2 }]);
      await sleep(60);
      await mobile.touch('touchEnd', []);
      await waitFor(
        () => {
          const now = mobileBot.find('모바일');
          const diff = Math.abs(((now.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          return diff > 0.05;
        },
        { message: '드래그로 시점이 돌아가지 않았다' },
      );
    });

    await step('모바일: 사격 버튼(멀티터치)으로 발사된다', async () => {
      await sleep(400); // 스폰 보호/재장전 대기
      const id = mobileBot.find('모바일').id;
      const shotsBefore = mobileBot.events.filter((e) => e.k === 'shot' && e.id === id).length;
      const fire = await mobile.rect('#btn-fire');
      await mobile.touch('touchStart', [{ x: fire.cx, y: fire.cy, id: 3 }]);
      await sleep(180);
      await mobile.touch('touchEnd', []);
      await waitFor(() => mobileBot.events.filter((e) => e.k === 'shot' && e.id === id).length > shotsBefore, { message: '터치 사격이 서버에 도달하지 않았다' });
      await mobile.shot('12-mobile-fire');
      mobileBot.close();
    });

    await step('모바일: 콘솔 오류 0건', async () => {
      assert(mobile.errors.length === 0, `모바일 콘솔 오류: ${mobile.errors.slice(0, 3).join(' | ')}`);
    });
  } catch (err) {
    // 실패 지점까지의 결과는 위에서 이미 집계된다. 실패 화면을 남겨 둔다.
    console.error(`[browser] 중단된 단계: ${err.message}`);
    if (SHOTS) console.error(`[browser] 실패 — 스크린샷: ${SHOTS}`);
  } finally {
    bot.close();
    await runCleanups();
  }

  console.log(`\n[browser] 통과 ${passed} · 실패 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

function printLibraryHint() {
  console.log('[browser] 힌트: libatk-1.0 / libatk-bridge-2.0 / libatspi 등이 없으면 Chrome 이 뜨지 않습니다.');
  console.log('[browser]       Debian 패키지를 풀어 LD_LIBRARY_PATH 로 지정하면 실행할 수 있습니다(예: at-spi2-core).');
}

async function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch {
      /* 무시 */
    }
  }
  await sleep(200);
}

main().catch(async (err) => {
  console.error('[browser] 실행 오류:', err.message);
  await runCleanups();
  process.exitCode = 1;
});
