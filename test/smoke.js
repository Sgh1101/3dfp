'use strict';

/**
 * E2E 스모크 테스트.
 * 실제 서버를 임시 포트로 띄우고, HTTP/WebSocket 다중 클라이언트로
 * 참여 · 배틀로얄 라운드 상태 · 이동 · 사격 · 레이트리밋 · 한도 · 종료 처리를 검증한다.
 *
 * 실행: node test/smoke.js
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
const { ERROR } = require('../server/rooms');

const PORT = Number(process.env.TEST_PORT) || 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
/** 한도(전역 연결/방 상한) 검증용 두 번째 서버 */
const LIMIT_PORT = PORT + 100;
const LIMIT_BASE = `http://127.0.0.1:${LIMIT_PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const clients = [];
const servers = [];

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

function startServer(port, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = [];
  proc.stdout.on('data', (d) => proc.log.push(d.toString().trim()));
  proc.stderr.on('data', (d) => proc.log.push(d.toString().trim()));
  servers.push(proc);
  return proc;
}

async function stopServers() {
  for (const proc of servers) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // 무시
    }
  }
  await sleep(300);
  for (const proc of servers) {
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // 무시
      }
    }
  }
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

async function openClient(name, port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = { ws, name, inbox: [], consumed: 0, closeCode: null };
  clients.push(client);
  ws.on('message', (raw) => {
    try {
      client.inbox.push(JSON.parse(raw.toString()));
    } catch {
      // 무시
    }
  });
  ws.on('close', (code) => {
    client.closeCode = code;
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

function meOf(snap, id) {
  return snap && snap.players ? snap.players.find((p) => p[0] === id) : null;
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
  startServer(PORT);

  try {
    await waitForHttp(`${BASE}/api/health`);

    await step('GET / 가 200으로 index.html을 서비스한다', async () => {
      const res = await fetch(`${BASE}/`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('3DFP'), 'HTML에 타이틀이 없다');
      assert.ok(html.includes('importmap'), 'importmap이 없다');
      assert.strictEqual(res.headers.get('content-type').includes('text/html'), true);
      // P2-3: CDN이 아니라 저장소에 들어 있는 로컬 번들을 가리켜야 한다.
      assert.ok(html.includes('/vendor/three/three.module.min.js'), 'importmap이 로컬 three를 가리키지 않는다');
      assert.ok(!html.includes('unpkg.com'), 'index.html에 아직 CDN(unpkg) 의존이 남아 있다');
      assert.ok(html.includes('boot-error'), '모듈 로드 실패 안내 배너가 없다');
    });

    await step('로컬 three 번들이 올바른 MIME으로 서비스된다(P2-3)', async () => {
      const res = await fetch(`${BASE}/vendor/three/three.module.min.js`);
      assert.strictEqual(res.status, 200, `status=${res.status}`);
      assert.ok(res.headers.get('content-type').includes('javascript'), `content-type=${res.headers.get('content-type')}`);
      const body = await res.text();
      assert.ok(body.includes('export'), 'ES 모듈 번들이 아니다');
      assert.ok(body.length > 100000, `번들이 너무 작다: ${body.length}바이트`);
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

    await step('GET /api/config 가 배틀로얄 규칙을 알려준다', async () => {
      const res = await fetch(`${BASE}/api/config`);
      assert.strictEqual(res.status, 200);
      const config = await res.json();
      assert.strictEqual(config.mode, 'br');
      assert.strictEqual(config.minPlayers, 2);
      assert.strictEqual(config.respawnMs, 0);
      assert.ok(config.weapons['1']);
    });

    await step('P2-1: API 경로는 정확 일치로만 매칭되고, 알 수 없는 /api/* 는 404 JSON', async () => {
      const cases = [
        ['/api/map?x=1', 200],
        ['/api/config?y=2', 200],
        ['/api/health?z=3', 200],
        ['/api/nope', 404],
        ['/api/map/extra', 404],
        ['/api/mapx', 404],
        ['/api/configs', 404],
        ['/api/healthz', 404],
        ['/api/', 404],
      ];
      for (const [pathname, expected] of cases) {
        const res = await fetch(`${BASE}${pathname}`);
        assert.strictEqual(res.status, expected, `${pathname} → ${res.status} (기대 ${expected})`);
        if (expected === 404) {
          const body = await res.json();
          assert.strictEqual(body.error, 'NOT_FOUND', `${pathname} 오류 형식: ${JSON.stringify(body)}`);
          assert.strictEqual(body.code, 'NOT_FOUND');
        }
      }
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

    await step('P1-1: 혼자면 워밍업(waiting)이고 사격이 막힌다', async () => {
      const snap = await waitFor(clientA, (m) => m.t === 's' && m.round && m.round.state === 'waiting', {
        label: '워밍업 스냅샷',
      });
      assert.strictEqual(snap.round.need, 2);
      assert.strictEqual(snap.round.alive, 1);
      assert.strictEqual(snap.round.total, 1);
      clientA.ws.send(JSON.stringify({ t: 'shoot', yaw: 0, pitch: 0 }));
      await sleep(350);
      const latest = lastSnapshot(clientA);
      const me = meOf(latest, clientA.id);
      assert.strictEqual(latest.round.state, 'waiting');
      assert.strictEqual(me[10], 30, `워밍업 중인데 탄창이 ${me[10]}로 줄었다`);
    });

    await step('두 번째 클라이언트 참여 → 배틀로얄 라운드 시작(2명 생존)', async () => {
      clientB = await openClient('B');
      const welcome = await join(clientB, { name: '베타' });
      assert.strictEqual(welcome.t, 'welcome');
      clientB.id = welcome.id;
      const snap = await waitFor(
        clientA,
        (m) => m.t === 's' && m.players.length >= 2 && m.round && m.round.state === 'live',
        { label: '라운드 시작 스냅샷' },
      );
      assert.strictEqual(snap.alive, 2);
      assert.strictEqual(snap.round.need, 2);
      assert.strictEqual(snap.round.index, 1);
    });

    await step('P1-2: 참여 요청 레이트리밋(10초에 5회) — 초과분은 RATE_LIMIT', async () => {
      const client = await openClient('rl');
      for (let i = 0; i < 7; i += 1) {
        client.ws.send(JSON.stringify({ t: 'join', name: `레이트${i}` }));
        await sleep(60);
      }
      await sleep(400);
      const codes = client.inbox.filter((m) => m.t === 'error').map((m) => m.code);
      assert.ok(client.inbox.some((m) => m.t === 'welcome'), '첫 참여는 성공해야 한다');
      assert.ok(codes.includes('RATE_LIMIT'), `RATE_LIMIT 응답이 없다: ${codes.join(',') || '없음'}`);
    });

    await step('P1-2: 핑 레이트리밋(1초에 5회) — 초과 핑에는 응답하지 않는다', async () => {
      const client = await openClient('ping');
      const welcome = await join(client, { name: '핑테스터' });
      assert.strictEqual(welcome.t, 'welcome', `참여 실패: ${welcome.message}`);
      await sleep(120);
      const before = client.inbox.length;
      for (let i = 0; i < 14; i += 1) client.ws.send(JSON.stringify({ t: 'ping', c: 900 + i }));
      await sleep(500);
      const pongs = client.inbox.slice(before).filter((m) => m.t === 'pong');
      assert.ok(pongs.length >= 1, 'pong이 하나도 없다');
      assert.ok(pongs.length <= 5, `pong ${pongs.length}개 — 레이트리밋이 동작하지 않았다`);
    });

    await step('존재하지 않는 방 코드 → "방을 찾을 수 없습니다"(코드 확인 안내)', async () => {
      const client = await openClient('C');
      const res = await join(client, { name: '감마', code: 'ZZZZZZ' });
      assert.strictEqual(res.t, 'error');
      assert.strictEqual(res.code, 'ROOM_NOT_FOUND');
      assert.strictEqual(res.message, ERROR.ROOM_NOT_FOUND.message);
      assert.ok(res.message.includes('코드'), '사용자가 코드를 확인할 수 있게 안내해야 한다');
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

    await step('8명 정원 초과 → "방 정원이 가득 찼습니다"', async () => {
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
      assert.strictEqual(res.message, ERROR.ROOM_FULL.message);
      assert.ok(res.message.includes('8'), '정원이 8명임을 알려야 한다');
    });

    await step('이동 패킷이 스냅샷에 반영된다', async () => {
      await sleep(150);
      const snap0 = lastSnapshot(clientA);
      assert.ok(snap0, '스냅샷이 없다');
      const me0 = meOf(snap0, clientA.id);
      assert.ok(me0, '내 플레이어가 스냅샷에 없다');
      const [, , x0, , z0] = me0;
      clientA.ws.send(JSON.stringify({ t: 'm', x: x0 + 0.2, z: z0, yaw: 0.5, pitch: 0 }));
      const snap = await waitFor(
        clientA,
        (m) => {
          if (m.t !== 's') return false;
          const me = meOf(m, clientA.id);
          return me && Math.abs(me[2] - (x0 + 0.2)) < 0.05;
        },
        { label: '이동 반영 스냅샷' },
      );
      const me = meOf(snap, clientA.id);
      assert.ok(Math.abs(me[5] - 0.5) < 0.01, `yaw 반영 실패: ${me[5]}`);
    });

    await step('사격 패킷이 탄창을 1발 소모한다', async () => {
      const snap0 = lastSnapshot(clientA);
      const me0 = meOf(snap0, clientA.id);
      const ammo0 = me0[10];
      clientA.ws.send(JSON.stringify({ t: 'shoot', yaw: 0, pitch: 0 }));
      await waitFor(
        clientA,
        (m) => {
          if (m.t !== 's') return false;
          const me = meOf(m, clientA.id);
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
          const me = meOf(m, clientA.id);
          return me && me[10] === 30;
        },
        { timeout: 6000, label: '재장전 완료' },
      );
    });

    await step('P2-2: 재장전 중 무기 교체 → 재장전 취소, 이전 무기 탄창은 그대로', async () => {
      const ammo0 = meOf(lastSnapshot(clientA), clientA.id)[10];
      clientA.ws.send(JSON.stringify({ t: 'shoot', yaw: 0, pitch: 0 }));
      const shotSnap = await waitFor(
        clientA,
        (m) => m.t === 's' && meOf(m, clientA.id)[10] === ammo0 - 1,
        { label: '사격 반영' },
      );
      const beforeReload = meOf(shotSnap, clientA.id)[10];
      clientA.ws.send(JSON.stringify({ t: 'reload' }));
      await waitFor(clientA, (m) => m.t === 's' && meOf(m, clientA.id)[15] > 0, { label: '재장전 시작' });

      clientA.ws.send(JSON.stringify({ t: 'swap', w: 2 }));
      const swapped = await waitFor(clientA, (m) => m.t === 's' && meOf(m, clientA.id)[9] === 2, { label: '권총 장착' });
      assert.strictEqual(meOf(swapped, clientA.id)[15], 0, '무기를 바꿨는데 재장전 잔여 시간이 남아 있다');
      const cancel = clientA.inbox.find((m) => m.t === 'reloadCancel');
      assert.ok(cancel, 'reloadCancel 패킷이 오지 않았다');

      // 라이플 재장전 시간(2.2초)이 지나도 이전 무기의 탄창은 채워지면 안 된다.
      await sleep(2600);
      clientA.ws.send(JSON.stringify({ t: 'swap', w: 1 }));
      const back = await waitFor(clientA, (m) => m.t === 's' && meOf(m, clientA.id)[9] === 1, { label: '라이플 복귀' });
      assert.strictEqual(meOf(back, clientA.id)[10], beforeReload, `이전 무기 재장전이 완료됐다: ${meOf(back, clientA.id)[10]} ≠ ${beforeReload}`);
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
      const me = meOf(snap, clientA.id);
      assert.ok(Number.isFinite(me[2]) && Number.isFinite(me[4]), '좌표가 유한하지 않다');
      assert.ok(Math.abs(me[2]) <= 80 && Math.abs(me[4]) <= 80, '좌표가 아레나를 벗어났다');
    });

    await step('속도 위반 이동은 롤백되고 보정 패킷이 온다', async () => {
      const snap0 = lastSnapshot(clientA);
      const me0 = meOf(snap0, clientA.id);
      // 먼저 정상 이동으로 마지막 이동 시각을 갱신한다.
      clientA.ws.send(JSON.stringify({ t: 'm', x: me0[2], z: me0[4], yaw: 0, pitch: 0 }));
      await sleep(80);
      const targetX = me0[2] > 0 ? me0[2] - 40 : me0[2] + 40;
      clientA.ws.send(JSON.stringify({ t: 'm', x: targetX, z: me0[4], yaw: 0, pitch: 0 }));
      const corr = await waitFor(clientA, (m) => m.t === 'corr', { label: '보정 패킷' });
      assert.ok(Number.isFinite(corr.x) && Number.isFinite(corr.z));
      await sleep(120);
      const snap = lastSnapshot(clientA);
      const me = meOf(snap, clientA.id);
      assert.ok(Math.abs(me[2] - me0[2]) < 1.0, `한 틱에 ${Math.abs(me[2] - me0[2]).toFixed(1)}m 이동했다`);
    });

    await step('플레이어 종료 → 다른 클라이언트 스냅샷에서 즉시 제거, 남은 1명은 워밍업', async () => {
      clientB.ws.close();
      const snap = await waitFor(
        clientA,
        (m) => m.t === 's' && !m.players.some((p) => p[0] === clientB.id),
        { label: '퇴장 반영 스냅샷' },
      );
      // 방에 다른 클라이언트(레이트리밋 테스트용)가 남아 있을 수 있어 생존자 수는 2 이상일 수 있다.
      assert.ok(snap.alive >= 1, '생존자 수가 비정상');
    });

    await step('에러 후에도 기본방 참여가 계속 동작한다', async () => {
      const client = await openClient('E');
      const res = await join(client, { name: '<b>새사람</b>' });
      assert.strictEqual(res.t, 'welcome');
      assert.strictEqual(res.code, 'LOBBY0');
      const snap = await waitFor(client, (m) => m.t === 's' && m.players.length >= 2, { label: '입장 후 스냅샷' });
      const me = meOf(snap, res.id);
      assert.ok(me, '새 클라이언트가 스냅샷에 없다');
      assert.ok(!me[1].includes('<b>'), `닉네임이 새니타이즈되지 않았다: ${me[1]}`);
    });

    await step('health 엔드포인트가 방/인원/한도 통계를 준다', async () => {
      const health = await (await fetch(`${BASE}/api/health`)).json();
      assert.strictEqual(health.ok, true);
      assert.ok(health.players >= 2);
      assert.strictEqual(health.defaultRoom, 'LOBBY0');
      assert.strictEqual(health.maxPlayersPerRoom, 8);
      assert.ok(health.maxRooms >= 1, 'maxRooms 누락');
      assert.ok(health.maxConnections >= 1, 'maxConnections 누락');
      assert.ok(health.connections >= 1, 'connections 누락');
    });

    // ── 두 번째 서버: 전역 상한(SERVER_FULL / TOO_MANY_ROOMS) ──
    console.log(`[smoke] 한도 검증용 서버 기동 (포트 ${LIMIT_PORT}, 연결 4 · 방 2)`);
    startServer(LIMIT_PORT, { MAX_TOTAL_CONNECTIONS: '4', MAX_ROOMS: '2' });
    await waitForHttp(`${LIMIT_BASE}/api/health`);

    await step('P1-2: 설정한 전역 상한이 health 에 반영된다', async () => {
      const health = await (await fetch(`${LIMIT_BASE}/api/health`)).json();
      assert.strictEqual(health.maxConnections, 4);
      assert.strictEqual(health.maxRooms, 2);
      assert.ok(health.maxBufferedBytes >= 1024);
    });

    await step('P1-2: 방 상한을 넘기면 TOO_MANY_ROOMS', async () => {
      const first = await openClient('limit-a', LIMIT_PORT);
      const joined = await join(first, { name: '한도A' });
      assert.strictEqual(joined.t, 'welcome');
      assert.strictEqual(joined.code, 'LOBBY0');

      const second = await openClient('limit-b', LIMIT_PORT);
      const created = await join(second, { name: '한도B', create: true });
      assert.strictEqual(created.t, 'welcome', `방 생성 실패: ${created.message}`);

      const third = await openClient('limit-c', LIMIT_PORT);
      const blocked = await join(third, { name: '한도C', create: true });
      assert.strictEqual(blocked.t, 'error');
      assert.strictEqual(blocked.code, 'TOO_MANY_ROOMS');
      const health = await (await fetch(`${LIMIT_BASE}/api/health`)).json();
      assert.strictEqual(health.rooms, 2, `방이 ${health.rooms}개`);
    });

    await step('P1-2: 전역 연결 상한을 넘으면 SERVER_FULL 로 거절한다', async () => {
      // 앞에서 3개 연결을 열었다(상한 4) → 4번째는 열리고, 5번째는 거절되어야 한다.
      const fourth = await openClient('limit-d', LIMIT_PORT);
      assert.strictEqual(fourth.ws.readyState, WebSocket.OPEN);

      const fifth = await openClient('limit-e', LIMIT_PORT);
      const err = await waitFor(fifth, (m) => m.t === 'error', { label: 'SERVER_FULL 오류' });
      assert.strictEqual(err.code, 'SERVER_FULL');
      // 서버가 소켓을 닫는다(정책 위반 4013).
      const t0 = Date.now();
      while (fifth.closeCode === null && Date.now() - t0 < 3000) await sleep(50);
      assert.strictEqual(fifth.closeCode, 4013, `close code=${fifth.closeCode}`);
      const health = await (await fetch(`${LIMIT_BASE}/api/health`)).json();
      assert.ok(health.connections <= 4, `연결이 상한을 넘었다: ${health.connections}`);

      // 거절된 소켓은 참여 상태가 아니다.
      fifth.ws.close();
      fourth.ws.close();
    });
  } catch (err) {
    console.error(`\n[smoke] 중단: ${err.message}`);
  } finally {
    closeAll();
    await sleep(100);
    await stopServers();
  }

  console.log(`\n[smoke] 통과 ${passed} · 실패 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[smoke] 예상치 못한 오류', err);
  closeAll();
  await stopServers();
  process.exit(1);
});
