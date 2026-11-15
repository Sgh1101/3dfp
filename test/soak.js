'use strict';

/**
 * 봇 소크 테스트 — 배틀로얄 라운드 흐름을 실제 서버·실제 클라이언트(WebSocket)로 길게 돌려 검증한다.
 *
 * 흐름
 *  - 0단계: 봇1만 입장 → 워밍업(waiting) 확인
 *  - 1단계: 봇2~4 입장 → 1라운드 시작. 진행 중 입장한 봇은 탈락(관전) 상태로 대기
 *  - 2단계: 1라운드 종료 → (전원 준비로) 즉시 2라운드 시작 = 전원 부활
 *  - 3단계: 2라운드에서 봇들이 실제로 사격·탈락 → 마지막 생존자 승리 → 3라운드 재시작
 *
 * 봇은 100m 안의 가장 가까운 적을 추격해 교전하고, 장애물에 막히면 같은 쪽으로 돌아갑니다
 * (나무 없이 서로 엉키던 문제를 잡아 라운드가 1분 안에 결정됩니다).
 * 근거리에서는 절반은 자리를 잡고, 절반은 횡이동해 동시 사망(무승부)을 피합니다.
 *
 * 검증: 노리스폰, 마지막 생존자 승리, 부활/탄약/구역 초기화, 킥·오류 없음, 서버 생존.
 * 실행: node test/soak.js   (SOAK_BOTS·SOAK_TIMEOUT_MS·SOAK_DEBUG 로 조정)
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SOAK_PORT) || 4100 + Math.floor(Math.random() * 60);
const BOT_COUNT = Number(process.env.SOAK_BOTS) || 4;
const STAGE_TIMEOUT_MS = Number(process.env.SOAK_TIMEOUT_MS) || 90000;
const TICK_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ── 시야 계산(봇이 벽 너머로 쏘지 않도록) ───────────────────
function rayBox2D(ox, oz, dx, dz, box, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  const axis = (o, d, min, max) => {
    if (Math.abs(d) < 1e-9) return o >= min && o <= max;
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    return tmin <= tmax;
  };
  if (!axis(ox, dx, box.minX, box.maxX)) return null;
  if (!axis(oz, dz, box.minZ, box.maxZ)) return null;
  return tmin;
}

function hasLineOfSight(covers, from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return true;
  const nx = dx / dist;
  const nz = dz / dist;
  for (const cover of covers) {
    // 높이 1.6m 미만(낮은 방벽)은 눈높이 사격을 막지 못한다.
    if (cover.h < 1.6) continue;
    const box = {
      minX: cover.x - cover.w / 2,
      maxX: cover.x + cover.w / 2,
      minZ: cover.z - cover.d / 2,
      maxZ: cover.z + cover.d / 2,
    };
    const t = rayBox2D(from.x, from.z, nx, nz, box, dist);
    if (t !== null && t > 0.05 && t < dist - 0.05) return false;
  }
  return true;
}

// ── 봇 ──────────────────────────────────────────────────────
/** 다음 위치가 커버와 부딪히면 그 커버를 돌려준다(봇 길찾기용). */
function blockingCover(covers, x, z, radius = 0.7) {
  for (const cover of covers) {
    const minX = cover.x - cover.w / 2;
    const maxX = cover.x + cover.w / 2;
    const minZ = cover.z - cover.d / 2;
    const maxZ = cover.z + cover.d / 2;
    const cx = Math.max(minX, Math.min(x, maxX));
    const cz = Math.max(minZ, Math.min(z, maxZ));
    if (Math.hypot(x - cx, z - cz) < radius) return cover;
  }
  return null;
}

class Bot {
  constructor(index) {
    this.index = index;
    this.name = `봇${index + 1}`;
    this.ws = null;
    this.id = null;
    this.map = null;
    this.snap = null;
    this.aliveHistory = new Map();
    this.killEvents = [];
    this.roundEvents = [];
    this.errors = [];
    this.closed = false;
    this.pos = { x: 0, z: 0 };
    this.lastPos = { x: 99, z: 99 };
    this.lastProgressAt = 0;
    this.detourUntil = 0;
    this.detourSign = 1;
    this.lastShotAt = 0;
    this.lastReloadAt = 0;
    this.lastMoveSentAt = 0;
    this.lastReadyAt = 0;
    this.shots = 0;
    this.moves = 0;
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handle(msg);
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
    this.ws.send(JSON.stringify({ t: 'join', name: this.name }));
  }

  handle(msg) {
    if (msg.t === 'welcome') {
      this.id = msg.id;
      this.map = msg.map;
      this.config = msg.config;
      return;
    }
    if (msg.t === 's') {
      this.snap = msg;
      const now = Date.now();
      const roundKey = `${msg.round.index}:${msg.round.state}`;
      for (const entry of msg.players) {
        const alive = entry[8] === 1;
        let hist = this.aliveHistory.get(entry[0]);
        if (!hist) {
          hist = [];
          this.aliveHistory.set(entry[0], hist);
        }
        const last = hist[hist.length - 1];
        if (!last || last.alive !== alive || last.roundKey !== roundKey) {
          hist.push({ t: now, alive, hp: entry[7], round: msg.round.state, roundIndex: msg.round.index, roundKey });
        }
      }
      return;
    }
    if (msg.t === 'ev') {
      for (const ev of msg.events || []) {
        if (ev.k === 'kill') {
          this.killEvents.push({ ...ev, at: Date.now(), round: this.snap ? this.snap.round.index : 0 });
        }
        if (ev.k === 'round') this.roundEvents.push({ ...ev, at: Date.now() });
      }
      return;
    }
    if (msg.t === 'error' || msg.t === 'kick') this.errors.push(msg);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  me() {
    if (!this.snap || !this.id) return null;
    return this.snap.players.find((p) => p[0] === this.id) || null;
  }

  nearestEnemy() {
    const me = this.me();
    if (!me) return null;
    let best = null;
    let bestDist = Infinity;
    for (const entry of this.snap.players) {
      if (entry[0] === this.id || entry[8] !== 1) continue;
      const d = Math.hypot(entry[2] - me[2], entry[4] - me[4]);
      if (d < bestDist) {
        bestDist = d;
        best = { id: entry[0], x: entry[2], z: entry[4], dist: d };
      }
    }
    return best;
  }

  step() {
    const me = this.me();
    if (!me || me[8] !== 1) return;
    const now = Date.now();
    this.pos = { x: me[2], z: me[4] };

    // 인터미션 중에는 '준비'를 눌러 다음 라운드를 앞당긴다(전원 준비 → 즉시 시작).
    if (this.snap.round.state === 'ended') {
      if (now - this.lastReadyAt > 600) {
        this.lastReadyAt = now;
        this.send({ t: 'ready' });
      }
      return;
    }
    if (this.snap.round.state !== 'live') return;

    const enemy = this.nearestEnemy();
    if (!enemy) return;

    if (process.env.SOAK_DEBUG && now - (this.lastDebugAt || 0) > 2000) {
      this.lastDebugAt = now;
      // eslint-disable-next-line no-console
      console.log(`[soak:debug] ${this.name} pos=(${this.pos.x.toFixed(1)},${this.pos.z.toFixed(1)}) enemy=${enemy.dist.toFixed(1)}m mag=${me[10]} state=${this.snap.round.state}`);
    }

    // 진행 정체 감지 → 잠깐 옆으로 비켜서 장애물을 돈다.
    if (Math.hypot(this.pos.x - this.lastPos.x, this.pos.z - this.lastPos.z) > 0.12) {
      this.lastProgressAt = now;
      this.lastPos = { x: this.pos.x, z: this.pos.z };
    } else if (now - this.lastProgressAt > 1200 && this.detourUntil < now) {
      this.detourUntil = now + 900;
      this.detourSign = Math.random() < 0.5 ? -1 : 1;
      this.lastProgressAt = now;
    }

    const yaw = Math.atan2(-enemy.x + this.pos.x, -enemy.z + this.pos.z);

    // 교전 규칙(결정적): 100m 안에 적이 있으면 곧장 추격한다.
    // 더 멀면(라운드 직후) 아레나 중앙 교전 지점으로 모인다.
    const rallyAngle = (Math.PI * 2 * this.index) / 4 + Math.PI / 4;
    const rally = { x: Math.cos(rallyAngle) * 9, z: Math.sin(rallyAngle) * 9 };
    const target = enemy.dist < 100 ? { x: enemy.x, z: enemy.z } : rally;

    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz) || 1;

    // 17m 안에서는 반반씩 다른 전술을 쓴다(한쪽은 자리 잡고 정조준, 한쪽은 횡이동).
    // 두 봇이 동시에 죽는 무승부(wipe)를 피하려는 의도적인 비대칭이다.
    const closeRange = enemy.dist < 17;
    const holdPosition = closeRange && this.index % 2 === 0;
    const strafe = closeRange && this.index % 2 === 1;

    if (now - this.lastMoveSentAt >= TICK_MS && !holdPosition) {
      this.lastMoveSentAt = now;
      let ux = dx / dist;
      let uz = dz / dist;
      if (strafe) {
        const tmp = ux;
        ux = -uz * this.detourSign;
        uz = tmp * this.detourSign;
      } else if (this.detourUntil > now) {
        const tmp = ux;
        ux = -uz * this.detourSign;
        uz = tmp * this.detourSign;
      }
      const speed = strafe ? 3.4 : enemy.dist < 3 ? -2.5 : 6.2; // 너무 붙으면 살짝 물러난다
      const stepLen = (speed * TICK_MS) / 1000;
      // 장애물에 막히면 같은 방향(왼/오른쪽)으로 계속 돌아간다.
      // 방향을 매번 새로 골라 버리면 모서리에서 앞뒤로 진동하며 진행하지 못한다.
      let nx = this.pos.x + ux * stepLen;
      let nz = this.pos.z + uz * stepLen;
      if (blockingCover(this.map.covers, nx, nz)) {
        if (!this.wallSide) this.wallSide = Math.random() < 0.5 ? 1 : -1;
        const turns = [
          (this.wallSide * Math.PI) / 4,
          (this.wallSide * Math.PI) / 2,
          (this.wallSide * 3 * Math.PI) / 4,
          (-this.wallSide * Math.PI) / 4,
          (-this.wallSide * Math.PI) / 2,
          (-this.wallSide * 3 * Math.PI) / 4,
        ];
        let found = false;
        for (const turn of turns) {
          const cos = Math.cos(turn);
          const sin = Math.sin(turn);
          const rx = ux * cos - uz * sin;
          const rz = ux * sin + uz * cos;
          const tx = this.pos.x + rx * stepLen;
          const tz = this.pos.z + rz * stepLen;
          if (!blockingCover(this.map.covers, tx, tz)) {
            nx = tx;
            nz = tz;
            found = true;
            break;
          }
        }
        this.wallUntil = now + 900; // 이 방향을 잠시 유지
        if (!found) {
          nx = this.pos.x;
          nz = this.pos.z;
        }
      } else if (now > (this.wallUntil || 0)) {
        this.wallSide = 0; // 막힘이 풀렸으면 다시 직선으로
      }
      this.moves += 1;
      this.send({ t: 'm', x: nx, z: nz, yaw, pitch: 0 });
    }

    const mag = me[10];
    if (mag <= 0) {
      if (now - this.lastReloadAt > 800) {
        this.lastReloadAt = now;
        this.send({ t: 'reload' });
      }
      return;
    }
    if (enemy.dist > 70 || now - this.lastShotAt < 220) return;
    if (!hasLineOfSight(this.map.covers, this.pos, enemy)) return;
    this.lastShotAt = now;
    this.vyaw = yaw;
    this.shots += 1;
    this.send({ t: 'shoot', yaw, pitch: 0 });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 무시
    }
  }
}

// ── 실행 ────────────────────────────────────────────────────
async function waitForHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 대기
    }
    await sleep(150);
  }
  return false;
}

async function main() {
  console.log(`[soak] 서버 기동 (포트 ${PORT}) · 봇 ${BOT_COUNT}`);
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString().trim()));
  server.stderr.on('data', (d) => serverLog.push(d.toString().trim()));

  const bots = [];
  let timer = null;
  let currentStage = '시작';
  const endsByRound = new Map();

  try {
    assert.ok(await waitForHttp(`http://127.0.0.1:${PORT}/api/health`), '서버가 뜨지 않았다');

    // 0단계: 봇1 혼자 입장 → 워밍업
    const first = new Bot(0);
    bots.push(first);
    await first.connect();
    let t0 = Date.now();
    while (!first.snap && Date.now() - t0 < 5000) await sleep(50);
    check('혼자 입장한 봇은 워밍업(waiting) 상태다', () => {
      assert.ok(first.snap, '스냅샷이 없다');
      assert.strictEqual(first.snap.round.state, 'waiting');
      assert.strictEqual(first.snap.round.need, 2);
      assert.strictEqual(first.snap.round.alive, 1);
    });

    const midJoinStates = [];
    for (let i = 1; i < BOT_COUNT; i += 1) {
      const bot = new Bot(i);
      bots.push(bot);
      await bot.connect();
      await sleep(120);
      const me = bot.me();
      if (me) midJoinStates.push({ name: bot.name, botIndex: i, alive: me[8] === 1, index: bot.snap.round.index });
    }

    // 봇 루프 시작
    timer = setInterval(() => {
      for (const bot of bots) bot.step();
    }, TICK_MS);

    const starts = () => bots[0].roundEvents.filter((e) => e.phase === 'start');
    const ends = () => bots[0].roundEvents.filter((e) => e.phase === 'end');
    const kills = (roundIndex) =>
      bots[0].killEvents.filter((k) => roundIndex === undefined || k.round === roundIndex);

    const waitUntil = async (predicate, label, timeout = STAGE_TIMEOUT_MS) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (predicate()) return true;
        if (bots.some((b) => b.closed)) return false;
        await sleep(100);
      }
      console.error(`[soak] ${label} 대기 시간 초과`);
      return false;
    };

    check('두 번째 봇 입장으로 1라운드가 시작됐다', () => {
      assert.ok(starts().length >= 1, 'round start 이벤트가 없다');
      assert.strictEqual(starts()[0].index, 1);
    });

    check('진행 중 라운드에 입장한 봇은 탈락(관전) 상태로 기다린다', () => {
      // botIndex 1(두 번째 봇)이 라운드를 시작시키므로, 그 뒤에 들어온 봇만 관전자여야 한다.
      const late = midJoinStates.filter((s) => s.index === 1 && s.botIndex >= 2);
      assert.ok(late.length >= 1, '진행 중 입장한 봇이 없다');
      for (const s of late) assert.strictEqual(s.alive, false, `${s.name}가 진행 중 라운드에 alive 로 입장했다`);
    });

    // 1라운드 종료 → 전원 준비 → 2라운드 즉시 시작
    currentStage = '1라운드 종료 대기';
    const round1Ended = await waitUntil(() => ends().some((e) => e.index === 1), '1라운드 종료');
    check('1라운드가 마지막 생존자로 끝났다', () => {
      assert.ok(round1Ended, '1라운드가 끝나지 않았다');
      const ev = ends().find((e) => e.index === 1);
      assert.ok(ev.winnerId, '승자가 없다');
    });
    const round2StartEvents = starts().filter((e) => e.index === 2);
    const round2StartAt = round2StartEvents.length ? round2StartEvents[0].at : 0;

    currentStage = '2라운드 시작 대기';
    const round2Live = await waitUntil(
      () => bots[0].snap && bots[0].snap.round.index >= 2 && bots[0].snap.round.state === 'live',
      '2라운드 시작',
    );
    check('인터미션 뒤 2라운드가 시작되며 전원이 부활한다', () => {
      assert.ok(round2Live, '2라운드가 시작되지 않았다');
      const snap = bots[0].snap;
      assert.strictEqual(snap.round.index, 2);
      assert.strictEqual(snap.alive, snap.players.length, `부활 인원 ${snap.alive}/${snap.players.length}`);
      for (const p of snap.players) {
        assert.strictEqual(p[7], 100, `${p[1]} HP ${p[7]}`);
        assert.strictEqual(p[9], 1, `${p[1]} 무기가 라이플로 초기화되지 않았다`);
        assert.strictEqual(p[10], 30, `${p[1]} 탄창 ${p[10]}`);
        assert.strictEqual(p[11], 150, `${p[1]} 예비탄 ${p[11]}`);
      }
      assert.strictEqual(snap.zone.radius, 80, `구역 반지름 ${snap.zone.radius}`);
      assert.strictEqual(snap.zone.stage, 0);
      // 전원 준비로 인터미션(8초)을 기다리지 않고 시작됐는지 — 시작 이벤트가 종료 후 8초 안이어야 한다.
      const ev1 = ends().find((e) => e.index === 1);
      if (round2StartAt && ev1) {
        const gap = round2StartAt - ev1.at;
        assert.ok(gap < 4500, `전원 준비 즉시 재시작이 아니다(간격 ${gap}ms)`);
      }
    });

    // 2라운드: 실제 교전 → 마지막 생존자 → 3라운드
    currentStage = '2라운드 교전';
    const round2Ended = await waitUntil(() => ends().some((e) => e.index === 2), '2라운드 종료');
    const round2EndSnapshot = round2Ended ? JSON.parse(JSON.stringify(bots[0].snap)) : null;

    currentStage = '3라운드 시작 대기';
    const round3Live = await waitUntil(
      () => bots[0].snap && bots[0].snap.round.index >= 3 && bots[0].snap.round.state === 'live',
      '3라운드 시작',
    );

    // ── 검증 ──
    check('2라운드에서 봇들이 실제로 서로를 탈락시켰다', () => {
      const k = kills(2);
      assert.ok(k.length >= 1, `2라운드 킬 ${k.length}건 — 교전이 일어나지 않았다`);
    });

    check('라운드 중 탈락자는 리스폰하지 않는다', () => {
      let checked = 0;
      for (const [id, hist] of bots[0].aliveHistory) {
        for (let i = 1; i < hist.length; i += 1) {
          const cur = hist[i];
          if (cur.alive) continue;
          const deathRound = cur.roundIndex;
          checked += 1;
          for (let j = i + 1; j < hist.length; j += 1) {
            if (hist[j].roundIndex !== deathRound) break;
            assert.strictEqual(hist[j].alive, false, `${deathRound}라운드 중 ${id}가 부활했다`);
          }
        }
      }
      assert.ok(checked >= 1, '탈락 이력이 없다');
    });

    check('2라운드 종료 시점: 생존자 1명 = 승자, 탈락자는 스냅샷에 남아 있다', () => {
      assert.ok(round2Ended, '2라운드가 끝나지 않았다');
      assert.ok(round2EndSnapshot, '종료 시점 스냅샷이 없다');
      const snap = round2EndSnapshot;
      const ev = ends().find((e) => e.index === 2);
      assert.strictEqual(snap.round.state, 'ended');
      assert.strictEqual(snap.round.index, 2);
      assert.strictEqual(snap.players.length, bots.length, `스냅샷 인원 ${snap.players.length}`);
      assert.strictEqual(snap.alive, 1, `종료 시 생존자 ${snap.alive}명`);
      const survivor = snap.players.filter((p) => p[8] === 1)[0];
      assert.strictEqual(ev.winnerId, survivor[0], '승자가 마지막 생존자와 다르다');
      assert.strictEqual(snap.round.winnerId, survivor[0]);
      const dead = snap.players.filter((p) => p[8] === 0);
      assert.ok(dead.length >= 1);
      for (const p of dead) assert.strictEqual(p[7], 0, `탈락자 ${p[1]} HP ${p[7]}`);
    });

    check('3라운드가 다시 전원 부활 상태로 시작된다', () => {
      assert.ok(round3Live, '3라운드가 시작되지 않았다');
      const snap = bots[0].snap;
      assert.strictEqual(snap.round.index, 3);
      assert.strictEqual(snap.alive, snap.players.length);
      assert.strictEqual(snap.zone.radius, 80);
    });

    check('소크 동안 킥/SLOW_CLIENT 같은 오류로 끊긴 봇이 없다', () => {
      for (const bot of bots) {
        const bad = bot.errors.filter((e) => e.t === 'kick' || e.code === 'SLOW_CLIENT');
        assert.strictEqual(bad.length, 0, `${bot.name}: ${JSON.stringify(bad[0] || {})}`);
      }
    });

    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    check('서버가 살아 있고 상태가 정상이다', () => {
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.players, bots.length, `players=${health.players}`);
      assert.strictEqual(health.connections, bots.length, `connections=${health.connections}`);
    });

    const totalKills = kills().length;
    const detail = kills()
      .map((k) => `R${k.round}:${k.victim}(${k.weapon || '-'})`)
      .join(', ');
    const moves = bots.reduce((sum, b) => sum + b.moves, 0);
    const shots = bots.reduce((sum, b) => sum + b.shots, 0);
    console.log(
      `\n[soak] 이동 패킷 ${moves} · 사격 ${shots} · 킬 ${totalKills}건${detail ? ` [${detail}]` : ''} · 라운드 시작 ${starts().length}회`,
    );
  } catch (err) {
    console.error(`\n[soak] 중단(${currentStage}): ${err.message}`);
    failed += 1;
  } finally {
    if (timer) clearInterval(timer);
    for (const bot of bots) bot.close();
    await sleep(100);
    server.kill('SIGTERM');
    await sleep(300);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  const errorLines = serverLog.filter((line) => /Error|error|uncaught|Unhandled/.test(line));
  check('서버 로그에 오류가 없다', () => {
    assert.strictEqual(errorLines.length, 0, errorLines.slice(0, 3).join(' | '));
  });

  console.log(`\n[soak] 통과 ${passed} · 실패 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[soak] 예상치 못한 오류', err);
  process.exit(1);
});
