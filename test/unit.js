'use strict';

/**
 * 서버 게임 로직 단위 테스트 (네트워크 없이 Game/RoomManager/limits 만 검사).
 * 실행: node test/unit.js
 */

const assert = require('assert');
const {
  Game,
  sanitizeName,
  rayAABB,
  resolveCollisions,
  publicConfig,
  MIN_PLAYERS_TO_START,
  INTERMISSION_MS,
} = require('../server/game');
const { RoomManager, ERROR, MAX_PLAYERS_PER_ROOM } = require('../server/rooms');
const { RateLimiter, BackpressureGuard, MAX_BUFFERED_BYTES } = require('../server/limits');
const { COVERS, SPAWNS, ARENA } = require('../server/map');

let passed = 0;
let failed = 0;

function test(name, fn) {
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

function newGame() {
  return new Game('TEST01', false);
}

function addPlayers(game, specs) {
  return specs.map(([id, name]) => game.addPlayer(id, name));
}

/** 스폰 보호 해제 + 위치/시점 강제 */
function place(player, x, z, yaw = 0, pitch = 0) {
  player.x = x;
  player.z = z;
  player.yaw = yaw;
  player.pitch = pitch;
  player.spawnProtectUntil = 0;
}

/** 라운드 시작 조건(2명)을 건너뛰고 특정 메커니즘만 검사할 때 쓰는 헬퍼. */
function forceLive(game, now = Date.now()) {
  game.round.state = 'live';
  game.round.startedAt = now;
  game.round.endsAt = now + 180000;
  game.round.startedWith = game.players.size;
  game.round.reason = null;
  game.resetZone(now);
}

console.log('[unit] 닉네임 새니타이즈');
test('HTML 태그를 제거한다', () => {
  const name = sanitizeName('<img src=x onerror=alert(1)>해커');
  assert.ok(!name.includes('<'), '태그가 남아 있으면 안 된다');
  assert.ok(name.includes('해커'));
});

test('특수문자를 이스케이프한다', () => {
  const name = sanitizeName('a&b<c>"d"');
  assert.strictEqual(name.includes('<'), false);
  assert.ok(name.includes('&amp;'));
});

test('빈 문자열/공백은 기본 이름이 된다', () => {
  assert.strictEqual(sanitizeName('   '), '플레이어');
  assert.strictEqual(sanitizeName(undefined), '플레이어');
});

test('최대 16자로 자른다', () => {
  const name = sanitizeName('가'.repeat(40));
  assert.strictEqual(Array.from(name).length, 16);
});

console.log('[unit] 맵');
test('스폰 지점이 커버 안에 있지 않다', () => {
  for (const spawn of SPAWNS) {
    for (const cover of COVERS) {
      const inside = spawn.x > cover.minX && spawn.x < cover.maxX && spawn.z > cover.minZ && spawn.z < cover.maxZ;
      assert.ok(!inside, `스폰 (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})가 커버 ${cover.id} 안에 있다`);
    }
  }
});

test('아레나 크기는 160m', () => {
  assert.strictEqual(ARENA.size, 160);
});

test('스폰 지점이 커버에서 충분히 떨어져 있다(벽 코앞 스폰 방지)', () => {
  for (const spawn of SPAWNS) {
    let nearest = Infinity;
    for (const cover of COVERS) {
      const cx = Math.max(cover.minX, Math.min(spawn.x, cover.maxX));
      const cz = Math.max(cover.minZ, Math.min(spawn.z, cover.maxZ));
      nearest = Math.min(nearest, Math.hypot(spawn.x - cx, spawn.z - cz));
    }
    assert.ok(nearest >= 6, `스폰 (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})가 커버에서 ${nearest.toFixed(2)}m 밖에 없다`);
  }
});

test('스폰끼리 25m 이상 떨어져 있고 아레나 중심을 바라본다', () => {
  for (let i = 0; i < SPAWNS.length; i += 1) {
    for (let j = i + 1; j < SPAWNS.length; j += 1) {
      const d = Math.hypot(SPAWNS[i].x - SPAWNS[j].x, SPAWNS[i].z - SPAWNS[j].z);
      assert.ok(d >= 25, `스폰 ${i}·${j} 거리가 ${d.toFixed(1)}m 뿐이다`);
    }
    const spawn = SPAWNS[i];
    const len = Math.hypot(spawn.x, spawn.z);
    const fx = -Math.sin(spawn.yaw);
    const fz = -Math.cos(spawn.yaw);
    const dot = (fx * -spawn.x + fz * -spawn.z) / len;
    assert.ok(dot > 0.99, `스폰 ${i}가 중심을 바라보지 않는다(dot ${dot.toFixed(3)})`);
  }
});

test('rayAABB가 박스를 맞춘다', () => {
  const t = rayAABB(0, 1, -10, 0, 0, 1, -1, 0, -1, 1, 2, 1, 100);
  assert.ok(t !== null && Math.abs(t - 9) < 1e-6, `기대 9, 실제 ${t}`);
});

test('rayAABB가 빗나간 광선은 null', () => {
  const t = rayAABB(0, 1, -10, 0, 0, 1, 5, 0, -1, 6, 2, 1, 100);
  assert.strictEqual(t, null);
});

test('커버 충돌이 플레이어를 밀어낸다', () => {
  const resolved = resolveCollisions(0, 0, 0.45); // 중앙 블록 내부
  const inside = COVERS.some((c) => resolved.x > c.minX && resolved.x < c.maxX && resolved.z > c.minZ && resolved.z < c.maxZ);
  assert.ok(!inside, '충돌 해소 후에도 커버 내부에 남아 있다');
});

console.log('[unit] 이동 검증');
test('NaN 좌표는 무시된다', () => {
  const game = newGame();
  const [p] = addPlayers(game, [['a', '알파']]);
  const before = { x: p.x, z: p.z };
  game.handleMove('a', { x: NaN, z: 10, yaw: 0, pitch: 0 });
  assert.strictEqual(p.x, before.x);
  assert.strictEqual(p.z, before.z);
});

test('아레나 밖 좌표는 거부된다', () => {
  const game = newGame();
  const [p] = addPlayers(game, [['a', '알파']]);
  const before = { x: p.x, z: p.z };
  game.handleMove('a', { x: 500, z: 0 });
  assert.strictEqual(p.x, before.x);
  assert.strictEqual(p.z, before.z);
});

test('정상 이동은 반영된다', () => {
  const game = newGame();
  const [p] = addPlayers(game, [['a', '알파']]);
  place(p, 0, -40, 0, 0);
  p.lastMoveAt = Date.now() - 50;
  game.handleMove('a', { x: 0, z: -40.3, yaw: 0, pitch: 0 });
  assert.ok(Math.abs(p.z - -40.3) < 0.02, `z=${p.z}`);
});

test('스피드핵 이동은 롤백된다', () => {
  const game = newGame();
  const [p] = addPlayers(game, [['a', '알파']]);
  place(p, 0, -40, 0, 0);
  p.lastMoveAt = Date.now() - 50;
  game.handleMove('a', { x: 0, z: -70, yaw: 0, pitch: 0 });
  assert.ok(p.z > -42, `한 틱에 30m를 이동했다: z=${p.z}`);
  assert.ok(p.violations > 0, '위반 카운트가 없으면 안 된다');
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'corr'), '보정 패킷이 없다');
});

console.log('[unit] 사격/피해');
test('정면 사격이 명중하고 피해를 준다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0); // +Z 방향
  place(b, 60, 10, 0, 0);
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(b.hp, 100 - 24);
  assert.strictEqual(a.mag[1], 29);
});

test('커버 뒤 플레이어는 맞지 않는다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 0, 20, 0, 0); // -Z 방향, 중앙 블록이 사이에 있음
  place(b, 0, -20, 0, 0);
  game.handleShoot('a', { yaw: 0, pitch: 0 });
  assert.strictEqual(b.hp, 100, '벽 뒤인데 피해를 입었다');
});

test('스폰 보호 중에는 피해가 없다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0);
  b.x = 60;
  b.z = 10;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(b.hp, 100);
});

test('사망 시 킬 이벤트와 킬 수가 기록된다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 20;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(b.alive, false);
  assert.strictEqual(a.kills, 1);
  const events = game.drainEvents();
  assert.ok(events.some((e) => e.k === 'kill' && e.killerId === 'a'));
});

test('탄창이 비면 사격되지 않는다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  a.mag[1] = 0;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'dry'));
});

test('연사 무기 사격 속도가 제한된다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  for (let i = 0; i < 12; i += 1) {
    game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  }
  assert.strictEqual(a.mag[1], 29, '연사 간격이 지켜지지 않았다');
});

test('샷건은 여러 발이 나가고 근접에서 큰 피해를 준다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 6, 0, 0);
  a.weapon = 3;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.ok(b.hp < 100, '샷건이 명중하지 않았다');
  assert.strictEqual(a.mag[3], 5);
});

console.log('[unit] 재장전/아이템');
test('재장전이 탄창을 채운다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  a.mag[1] = 0;
  a.reserve[1] = 150;
  game.handleReload('a');
  assert.ok(a.reloadEnd > Date.now());
  game.tick(Date.now() + 3000);
  assert.strictEqual(a.mag[1], 30);
  assert.strictEqual(a.reserve[1], 120);
});

test('힐 키트가 체력을 회복하고 개수가 줄어든다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  a.hp = 40;
  game.handleHeal('a');
  assert.strictEqual(a.hp, 75);
  assert.strictEqual(a.kits, 1);
});

test('무기 교체가 동작한다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  game.handleSwap('a', { w: 3 });
  assert.strictEqual(a.weapon, 3);
  game.handleSwap('a', {});
  assert.strictEqual(a.weapon, 1);
});

console.log('[unit] P2-2 무기 교체 시 재장전 취소');
test('재장전 중 무기를 바꾸면 재장전이 취소된다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  a.mag[1] = 0;
  a.reserve[1] = 150;
  game.handleReload('a');
  assert.ok(a.reloadEnd > 0, '재장전이 시작되지 않았다');
  game.drainDirect();
  game.handleSwap('a', { w: 3 });
  assert.strictEqual(a.weapon, 3);
  assert.strictEqual(a.reloadEnd, 0, '무기를 바꿨는데 재장전 타이머가 남아 있다');
  assert.strictEqual(a.reloadWeapon, 0);
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'reloadCancel'), 'reloadCancel 통보가 없다');

  // 이전 무기(라이플)의 재장전이 나중에 완료되어 탄창을 채우면 안 된다.
  game.tick(Date.now() + 5000);
  assert.strictEqual(a.mag[1], 0, '이전 무기의 재장전이 완료되어 버렸다');
  assert.strictEqual(a.reserve[1], 150);
  const reloaded = game.drainDirect().some((d) => d.message.t === 'reloaded');
  assert.strictEqual(reloaded, false, '이전 무기의 reloaded 패킷이 전송됐다');
});

test('무기 교체 후 스냅샷의 재장전 잔여 시간이 0이다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  a.mag[1] = 0;
  game.handleReload('a');
  game.handleSwap('a', { w: 2 });
  const snap = game.snapshot();
  const me = snap.players.find((p) => p[0] === 'a');
  assert.strictEqual(me[15], 0, `reloadMs=${me[15]}`);
});

console.log('[unit] P1-1 배틀로얄(노리스폰) 규칙');
test('혼자 있으면 라운드가 시작되지 않고 워밍업 상태다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파']]);
  assert.strictEqual(game.round.state, 'waiting');
  game.tick(Date.now() + 1000);
  assert.strictEqual(game.round.state, 'waiting', '1명인데 라운드가 시작/종료됐다');
  const snap = game.snapshot();
  assert.strictEqual(snap.round.state, 'waiting');
  assert.strictEqual(snap.alive, 1);
});

test('두 번째 플레이어가 들어오면 즉시 라운드가 시작된다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파']]);
  assert.strictEqual(game.round.state, 'waiting');
  addPlayers(game, [['b', '베타']]);
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(game.round.startedWith, 2);
  assert.strictEqual(game.round.index, 1);
});

test('라운드 중 사망자는 리스폰하지 않고 계속 dead 로 남는다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 10;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(b.alive, false);
  // 4초(기존 리스폰 시간)보다 훨씬 지나도 되살아나면 안 된다.
  game.tick(Date.now() + 6000);
  assert.strictEqual(b.alive, false, '라운드 중에 리스폰됐다');
  assert.strictEqual(b.hp, 0);
  const snap = game.snapshot();
  assert.strictEqual(snap.players.find((p) => p[0] === 'b')[8], 0);
});

test('마지막 생존자가 되면 라운드가 끝나고 그 플레이어가 승리한다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 10;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  const now = Date.now();
  game.tick(now);
  assert.strictEqual(game.round.state, 'ended');
  assert.strictEqual(game.round.reason, 'last-survivor');
  assert.ok(game.round.winner, '승자가 없다');
  assert.strictEqual(game.round.winner.id, 'a');
  const events = game.drainEvents();
  const endEv = events.find((e) => e.k === 'round' && e.phase === 'end');
  assert.ok(endEv, '라운드 종료 이벤트가 없다');
  assert.strictEqual(endEv.winnerId, 'a');
  assert.strictEqual(endEv.draw, false);
});

test('존 피해로 죽어도 라운드 중에는 리스폰하지 않는다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 78, 0);
  place(b, 40, 40);
  // 축소가 끝난 시점(반지름 12m)으로 진행 — 존 밖에 있는 a만 피해를 입는다.
  const now = Date.now() + 160000;
  a.hp = 6;
  game.tick(now);
  assert.strictEqual(a.alive, false, '존 피해로 사망하지 않았다');
  game.tick(now + 6000);
  assert.strictEqual(a.alive, false, '존 피해 사망 후 리스폰됐다');
});

test('시간 종료 시 생존자 중 HP가 가장 높은 플레이어가 승리한다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  a.hp = 40;
  b.hp = 80;
  game.tick(game.round.endsAt + 1);
  assert.strictEqual(game.round.state, 'ended');
  assert.strictEqual(game.round.reason, 'timeout');
  assert.strictEqual(game.round.winner.id, 'b', 'HP 우세자가 승리하지 않았다');
});

test('전멸(0명 생존)이면 무승부로 라운드가 끝난다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 78, 0);
  place(b, 78, 2);
  a.hp = 1;
  b.hp = 1;
  game.tick(Date.now() + 160000);
  assert.strictEqual(a.alive, false);
  assert.strictEqual(b.alive, false);
  assert.strictEqual(game.round.state, 'ended');
  assert.strictEqual(game.round.winner, null);
});

test('인터미션 뒤 새 라운드는 전원 부활·HP/탄약/구역 초기화', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 10;
  b.mag[1] = 3;
  b.reserve[1] = 7;
  b.kits = 0;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  game.tick(Date.now());
  assert.strictEqual(game.round.state, 'ended');
  const endEventAt = game.round.nextRoundAt;

  // 인터미션 중에는 아직 부활하지 않는다.
  game.tick(endEventAt - 100);
  assert.strictEqual(b.alive, false, '인터미션이 끝나기 전에 부활했다');

  game.tick(endEventAt + 1);
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(game.round.index, 2);
  assert.strictEqual(game.round.winner, null);
  for (const p of [a, b]) {
    assert.strictEqual(p.alive, true, `${p.id}가 부활하지 않았다`);
    assert.strictEqual(p.hp, 100);
    assert.strictEqual(p.kits, 2);
    assert.strictEqual(p.mag[1], 30);
    assert.strictEqual(p.reserve[1], 150);
    assert.strictEqual(p.reloadEnd, 0);
  }
  assert.strictEqual(game.zone.radius, 80, '구역이 초기화되지 않았다');
  assert.strictEqual(game.zone.stage, 0);
});

test('라운드 중 인원이 1명이 되면(상대 퇴장) 워밍업으로 돌아간다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파'], ['b', '베타']]);
  assert.strictEqual(game.round.state, 'live');
  game.removePlayer('b');
  assert.strictEqual(game.round.state, 'waiting');
  const a = game.players.get('a');
  assert.strictEqual(a.alive, true);
  assert.strictEqual(a.hp, 100);
});

test('라운드 중 입장한 플레이어는 다음 라운드까지 관전자다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파'], ['b', '베타']]);
  assert.strictEqual(game.round.state, 'live');
  const c = game.addPlayer('c', '감마');
  assert.strictEqual(c.alive, false, '진행 중 라운드에 alive 로 들어왔다');
  assert.strictEqual(c.spectator, true);
  const snap = game.snapshot();
  assert.strictEqual(snap.players.find((p) => p[0] === 'c')[8], 0);

  // 라운드가 끝나고 새 라운드가 시작되면 합류한다.
  place(game.players.get('a'), 60, 0, Math.PI, 0);
  place(game.players.get('b'), 60, 10, 0, 0);
  game.players.get('b').hp = 5;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  game.tick(Date.now());
  game.tick(game.round.nextRoundAt + 1);
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(c.alive, true);
  assert.strictEqual(c.spectator, false);
});

test('전원 준비되면 인터미션을 기다리지 않고 다음 라운드가 시작된다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 5;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  game.tick(Date.now());
  assert.strictEqual(game.round.state, 'ended');
  game.handleReady('a');
  assert.strictEqual(game.round.state, 'ended', '아직 전원 준비가 아니다');
  game.handleReady('b');
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(a.alive, true);
  assert.strictEqual(b.alive, true);
});

console.log('[unit] 존/라운드');
test('존이 단계별로 줄어든다', () => {
  const game = newGame();
  const start = Date.now();
  game.updateZone(start + 5000);
  const r0 = game.zone.radius;
  game.updateZone(start + 40000);
  const r1 = game.zone.radius;
  game.updateZone(start + 100000);
  const r2 = game.zone.radius;
  assert.ok(r0 > r1 && r1 > r2, `반지름이 줄지 않았다: ${r0} ${r1} ${r2}`);
  assert.ok(game.zone.stage >= 2);
});

test('존 밖에서는 피해를 입는다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  forceLive(game);
  place(a, 78, 0);
  // 모든 축소 단계가 끝난 시점(반지름 12m)으로 진행시킨 뒤 한 틱 돌린다.
  game.tick(Date.now() + 160000);
  assert.ok(a.hp < 100, '존 밖인데 피해가 없다');
});

console.log('[unit] 스냅샷 계약');
test('스냅샷 형식이 계약과 맞는다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파']]);
  const snap = game.snapshot();
  assert.strictEqual(snap.t, 's');
  assert.ok(Array.isArray(snap.players));
  const [id, name, x, y, z, yaw, pitch, hp, alive, weapon, ammo] = snap.players[0];
  assert.strictEqual(id, 'a');
  assert.strictEqual(name, '알파');
  for (const v of [x, y, z, yaw, pitch, hp, weapon, ammo]) assert.ok(Number.isFinite(v));
  assert.strictEqual(alive, 1);
  assert.ok(snap.zone && typeof snap.zone.radius === 'number' && typeof snap.zone.shrinking === 'boolean');
  assert.strictEqual(typeof snap.zone.stage, 'number');
  assert.ok(snap.zone.centerX === 0 && snap.zone.centerZ === 0);
  assert.strictEqual(snap.round.mode, 'br');
  assert.strictEqual(snap.round.state, 'waiting');
  assert.strictEqual(snap.round.need, MIN_PLAYERS_TO_START);
  assert.strictEqual(snap.round.alive, 1);
  assert.strictEqual(snap.round.total, 1);
});

test('사망한 플레이어는 즉시 alive=0으로 스냅샷에 반영된다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 5;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  const snap = game.snapshot();
  const entry = snap.players.find((p) => p[0] === 'b');
  assert.strictEqual(entry[8], 0);
  assert.strictEqual(snap.alive, 1);
});

test('클라이언트 설정이 배틀로얄 규칙을 담는다', () => {
  const config = publicConfig();
  assert.strictEqual(config.mode, 'br');
  assert.strictEqual(config.minPlayers, 2);
  assert.strictEqual(config.respawnMs, 0);
  assert.strictEqual(config.intermissionMs, INTERMISSION_MS);
  assert.ok(!('killTarget' in config), '제거된 killTarget이 남아 있다');
});

console.log('[unit] P1-2 연결/방 한도·레이트리밋·백프레셔');
test('RateLimiter가 기간당 횟수를 제한한다', () => {
  const limiter = new RateLimiter(5, 10000);
  const t0 = 1000;
  for (let i = 0; i < 5; i += 1) assert.strictEqual(limiter.allow(t0 + i), true, `${i}번째가 막혔다`);
  assert.strictEqual(limiter.allow(t0 + 6), false, '5회를 넘겼는데 통과했다');
  assert.strictEqual(limiter.allow(t0 + 10001), true, '윈도가 지났는데 복구되지 않았다');
});

test('BackpressureGuard: 정상 → 건너뜀 → 종료 판정', () => {
  const guard = new BackpressureGuard({ maxBuffered: MAX_BUFFERED_BYTES, strikes: 3 });
  const ws = { bufferedAmount: 0 };
  assert.strictEqual(guard.check(ws), 'ok');
  ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  assert.strictEqual(guard.check(ws), 'skip');
  assert.strictEqual(guard.check(ws), 'skip');
  assert.strictEqual(guard.check(ws), 'drop', '연속 3회 막힘을 종료로 판정하지 않았다');
  // 버퍼가 비면 상태가 초기화된다.
  const guard2 = new BackpressureGuard({ maxBuffered: 10, strikes: 2 });
  assert.strictEqual(guard2.check({ bufferedAmount: 50 }), 'skip');
  assert.strictEqual(guard2.check({ bufferedAmount: 0 }), 'ok');
  assert.strictEqual(guard2.check({ bufferedAmount: 50 }), 'skip', '리셋되지 않았다');
});

test('RoomManager가 방 개수 상한을 지킨다', () => {
  const rooms = new RoomManager({ maxRooms: 2 });
  const first = rooms.join({}, 'a', '알파');
  assert.ok(first.room, '기본방 참여 실패');
  const created = rooms.join({ create: true }, 'b', '베타');
  assert.ok(created.room, '첫 방 생성 실패');
  const blocked = rooms.join({ create: true }, 'c', '감마');
  assert.ok(blocked.error, '상한을 넘겼는데 방이 만들어졌다');
  assert.strictEqual(blocked.error.code, 'TOO_MANY_ROOMS');
  assert.strictEqual(blocked.error.message, ERROR.TOO_MANY_ROOMS.message);
  assert.strictEqual(rooms.rooms.size, 2);
  assert.strictEqual(rooms.isFull, true);
});

test('방 정원 상한은 그대로 8명이다', () => {
  const rooms = new RoomManager({ maxRooms: 4 });
  const { room } = rooms.join({ create: true }, 'p0', '피');
  for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i += 1) {
    const res = rooms.join({ code: room.code }, `p${i}`, `피${i}`);
    assert.ok(res.room, `${i}번째 참여 실패`);
  }
  const extra = rooms.join({ code: room.code }, 'px', '초과');
  assert.strictEqual(extra.error.code, 'ROOM_FULL');
});

console.log(`\n[unit] 통과 ${passed} · 실패 ${failed}`);
if (failed > 0) process.exit(1);
