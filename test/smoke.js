'use strict';

/**
 * E2E 스모크 테스트.
 * 실제 서버를 임시 포트로 띄우고, HTTP/WebSocket 2~9 클라이언트로
 * 참여 · 이동 · 사격 · 잘못된 코드 · 정원 초과 · 종료 처리를 검증한다.
 *
 * 실행: node test/smoke.js
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT) || 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const clients = [];
let serverProcess = null;

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failed += 1;
  console.error(`  ✗ ${name}`);
  if (err) console.error(`    ${err.message}`);
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

// ── 유틸 ────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // 아직 준비 안 됨
    }
    await sleep(150);
  }
  throw new Error(`서버가 뜨지 않았습니다: ${url}`);
}

async function openClient(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const client = { ws, name, inbox: [], consumed: 0 };
  clients.push(client);
  ws.on('message', (raw) => {
    try {
      client.inbox.push(JSON.parse(raw.toString()));
    } catch {
      // 무시
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return client;
}

function waitFor(client, predicate, { timeout = 5000, label = '메시지' } = {}) {
  const since = client.consumed;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (let i = since; i < client.inbox.length; i += 1) {
        if (predicate(client.inbox[i])) {
          clearInterval(timer);
          client.consumed = i + 1;
          resolve(client.inbox[i]);
          return;
        }
      }
      if (Date.now() - t0 > timeout) {
        clearInterval(timer);
        reject(new Error(`${client.name}: ${label} 대기 시간 초과`));
      }
    }, 10);
  });
}

function lastSnapshot(client) {
  for (let i = client.inbox.length - 1; i >= 0; i -= 1) {
    if (client.inbox[i].t === 's') return client.inbox[i];
  }
  return null;
}

async function join(client, payload) {
  client.ws.send(JSON.stringify({ t: 'join', ...payload }));
  return waitFor(client, (m) => m.t === 'welcome' || m.t === 'error', { label: 'welcome/error' });
}

function closeAll() {
  for (const client of clients) {
    try {
      client.ws.close();
    } catch {
      // 무시
    }
  }
}

// ── 테스트 ──────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] 서버 기동 (포트 ${PORT})`);
  serverProcess = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  serverProcess.stdout.on('data', (d) => serverLog.push(d.toString().trim()));
  serverProcess.stderr.on('data', (d) => serverLog.push(d.toString().trim()));

  try {
    await waitForHttp(`${BASE}/api/health`);

    await step('GET / 가 200으로 index.html을 서비스한다', async () => {
      const res = await fetch(`${BASE}/`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('3DFP'), 'HTML에 타이틀이 없다');
      assert.ok(html.includes('importmap'), 'importmap이 없다');
      assert.strictEqual(res.headers.get('content-type').includes('text/html'), true);
    });

    await step('정적 자원(js/css)이 올바른 MIME으로 제공된다', async () => {
      const css = await fetch(`${BASE}/css/style.css`);
      assert.strictEqual(css.status, 200);
      assert.ok(css.headers.get('content-type').includes('text/css'));
      const js = await fetch(`${BASE}/js/main.js`);
      assert.strictEqual(js.status, 200);
      assert.ok(js.headers.get('content-type').includes('javascript'));
    });

    await step('GET /api/map 이 160m 아레나와 커버를 반환한다', async () => {
      const res = await fetch(`${BASE}/api/map`);
      const map = await res.json();
      assert.strictEqual(map.arena.size, 160);
      assert.ok(Array.isArray(map.covers) && map.covers.length >= 20, `커버 ${map.covers?.length}개`);
      assert.ok(map.covers.every((c) => Number.isFinite(c.x) && Number.isFinite(c.w)));
    });

    await step('경로 탈출 요청이 차단된다', async () => {
      const res = await fetch(`${BASE}/../package.json`);
      assert.ok(res.status === 404 || res.status === 400, `status=${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('"dependencies"'), 'package.json이 노출되었다');
    });

    let clientA;
    let clientB;

    await step('기본 공개방 참여 → welcome 수신', async () => {
      clientA = await openClient('A');
      const welcome = await join(clientA, { name: '알파' });
      assert.strictEqual(welcome.t, 'welcome');
      assert.strictEqual(welcome.code, 'LOBBY0');
      assert.strictEqual(welcome.isDefault, true);
      assert.ok(welcome.id && welcome.id.length >= 6);
      assert.ok(welcome.config && welcome.config.weapons['1']);
      assert.ok(welcome.map && Array.isArray(welcome.map.covers));
      clientA.id = welcome.id;
    });

    await step('두 번째 클라이언트 참여 → 스냅샷에 2명', async () => {
      clientB = await openClient('B');
      const welcome = await join(clientB, { name: '베타' });
      assert.strictEqual(welcome.t, 'welcome');
      clientB.id = welcome.id;
      const snap = await waitFor(clientA, (m) => m.t === 's' && m.players.length >= 2, { label: '2인 스냅샷' });
      assert.strictEqual(snap.alive, 2);
    });

    await step('존재하지 않는 방 코드 → "방을 찾을 수 없음"', async () => {
      const client = await openClient('C');
      const res = await join(client, { name: '감마', code: 'ZZZZZZ' });
      assert.strictEqual(res.t, 'error');
      assert.strictEqual(res.code, 'ROOM_NOT_FOUND');
      assert.strictEqual(res.message, '방을 찾을 수 없음');
    });

    await step('방 만들기 → 6자리 새 코드', async () => {
      const client = await openClient('D');
      const res = await join(client, { name: '델타', create: true });
      assert.strictEqual(res.t, 'welcome');
      assert.strictEqual(res.isDefault, false);
      assert.strictEqual(res.code.length, 6);
      assert.notStrictEqual(res.code, 'LOBBY0');
      client.roomCode = res.code;
    });

    await step('8명 정원 초과 → "정원 초과"', async () => {
      const host = clients.find((c) => c.roomCode);
      const code = host.roomCode;
      // host 포함 8명까지 채운다.
      for (let i = 0; i < 7; i += 1) {
        const filler = await openClient(`fill${i}`);
        const res = await join(filler, { name: `채움${i}`, code });
        assert.strictEqual(res.t, 'welcome', `채움${i} 참여 실패: ${res.message}`);
      }
      const extra = await openClient('extra');
      const res = await join(extra, { name: '초과', code });
      assert.strictEqual(res.t, 'error');
      assert.strictEqual(res.code, 'ROOM_FULL');
      assert.strictEqual(res.message, '정원 초과');
    });

    await step('이동 패킷이 스냅샷에 반영된다', async () => {
      await sleep(150);
      const snap0 = lastSnapshot(clientA);
      assert.ok(snap0, '스냅샷이 없다');
      const me0 = snap0.players.find((p) => p[0] === clientA.id);
      assert.ok(me0, '내 플레이어가 스냅샷에 없다');
      const [, , x0, , z0] = me0;
      clientA.ws.send(JSON.stringify({ t: 'm', x: x0 + 0.2, z: z0, yaw: 0.5, pitch: 0 }));
      const snap = await waitFor(
        clientA,
        (m) => {
          if (m.t !== 's') return false;
          const me = m.players.find((p) => p[0] === clientA.id);
          return me && Math.abs(me[2] - (x0 + 0.2)) < 0.05;
        },
        { label: '이동 반영 스냅샷' },
      );
      const me = snap.players.find((p) => p[0] === clientA.id);
      assert.ok(Math.abs(me[5] - 0.5) < 0.01, `yaw 반영 실패: ${me[5]}`);
    });

    await step('사격 패킷이 탄창을 1발 소모한다', async () => {
      const snap0 = lastSnapshot(clientA);
      const me0 = snap0.players.find((p) => p[0] === clientA.id);
      const ammo0 = me0[10];
      clientA.ws.send(JSON.stringify({ t: 'shoot', yaw: 0, pitch: 0 }));
      await waitFor(
        clientA,
        (m) => {
          if (m.t !== 's') return false;
          const me = m.players.find((p) => p[0] === clientA.id);
          return me && me[10] === ammo0 - 1;
        },
        { label: '탄창 감소 스냅샷' },
      );
      const shot = clientA.inbox.find((m) => m.t === 'ev' && m.events.some((e) => e.k === 'shot' && e.id === clientA.id));
      assert.ok(shot, 'shot 이벤트가 방송되지 않았다');
    });

    await step('재장전 → 탄창이 가득 찬다', async () => {
      clientA.ws.send(JSON.stringify({ t: 'reload' }));
      await waitFor(
        clientA,
        (m) => {
          if (m.t !== 's') return false;
          const me = m.players.find((p) => p[0] === clientA.id);
          return me && me[10] === 30;
        },
        { timeout: 6000, label: '재장전 완료' },
      );
    });

    await step('NaN/범위 밖 좌표를 보내도 서버가 죽지 않고 좌표가 유한하다', async () => {
      clientA.ws.send(JSON.stringify({ t: 'm', x: NaN, z: Infinity, yaw: NaN, pitch: NaN }));
      clientA.ws.send(JSON.stringify({ t: 'm', x: 9999, z: -9999 }));
      clientA.ws.send(JSON.stringify(['not', 'an', 'object']));
      clientA.ws.send('이건 JSON이 아님');
      await sleep(300);
      const health = await (await fetch(`${BASE}/api/health`)).json();
      assert.strictEqual(health.ok, true);
      const snap = lastSnapshot(clientA);
      const me = snap.players.find((p) => p[0] === clientA.id);
      assert.ok(Number.isFinite(me[2]) && Number.isFinite(me[4]), '좌표가 유한하지 않다');
      assert.ok(Math.abs(me[2]) <= 80 && Math.abs(me[4]) <= 80, '좌표가 아레나를 벗어났다');
    });

    await step('속도 위반 이동은 롤백되고 보정 패킷이 온다', async () => {
      const snap0 = lastSnapshot(clientA);
      const me0 = snap0.players.find((p) => p[0] === clientA.id);
      // 먼저 정상 이동으로 마지막 이동 시각을 갱신한다.
      clientA.ws.send(JSON.stringify({ t: 'm', x: me0[2], z: me0[4], yaw: 0, pitch: 0 }));
      await sleep(80);
      const targetX = me0[2] > 0 ? me0[2] - 40 : me0[2] + 40;
      clientA.ws.send(JSON.stringify({ t: 'm', x: targetX, z: me0[4], yaw: 0, pitch: 0 }));
      const corr = await waitFor(clientA, (m) => m.t === 'corr', { label: '보정 패킷' });
      assert.ok(Number.isFinite(corr.x) && Number.isFinite(corr.z));
      await sleep(120);
      const snap = lastSnapshot(clientA);
      const me = snap.players.find((p) => p[0] === clientA.id);
      assert.ok(Math.abs(me[2] - me0[2]) < 1.0, `한 틱에 ${Math.abs(me[2] - me0[2]).toFixed(1)}m 이동했다`);
    });

    await step('플레이어 종료 → 다른 클라이언트 스냅샷에서 즉시 제거', async () => {
      clientB.ws.close();
      const snap = await waitFor(
        clientA,
        (m) => m.t === 's' && !m.players.some((p) => p[0] === clientB.id),
        { label: '퇴장 반영 스냅샷' },
      );
      assert.strictEqual(snap.alive, 1);
    });

    await step('에러 후에도 기본방 참여가 계속 동작한다', async () => {
      const client = await openClient('E');
      const res = await join(client, { name: '<b>새사람</b>' });
      assert.strictEqual(res.t, 'welcome');
      assert.strictEqual(res.code, 'LOBBY0');
      const snap = await waitFor(client, (m) => m.t === 's' && m.players.length >= 2, { label: '입장 후 스냅샷' });
      const me = snap.players.find((p) => p[0] === res.id);
      assert.ok(me, '새 클라이언트가 스냅샷에 없다');
      assert.ok(!me[1].includes('<b>'), `닉네임이 새니타이즈되지 않았다: ${me[1]}`);
    });

    await step('health 엔드포인트가 방/인원 통계를 준다', async () => {
      const health = await (await fetch(`${BASE}/api/health`)).json();
      assert.strictEqual(health.ok, true);
      assert.ok(health.players >= 2);
      assert.strictEqual(health.defaultRoom, 'LOBBY0');
      assert.strictEqual(health.maxPlayersPerRoom, 8);
    });
  } catch (err) {
    console.error(`\n[smoke] 중단: ${err.message}`);
  } finally {
    closeAll();
    await sleep(100);
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(300);
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
  }

  console.log(`\n[smoke] 통과 ${passed} · 실패 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[smoke] 예상치 못한 오류', err);
  closeAll();
  if (serverProcess) serverProcess.kill('SIGKILL');
  process.exit(1);
});
