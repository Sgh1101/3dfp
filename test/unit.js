'use strict';

/**
 * 서버 게임 로직 단위 테스트 (네트워크 없이 Game 클래스만 검사).
 * 실행: node test/unit.js
 */

const assert = require('assert');
const { Game, sanitizeName, rayAABB, resolveCollisions } = require('../server/game');
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
  const game = new Game('TEST01', false);
  return game;
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
  place(a, 60, 0, Math.PI, 0);
  a.mag[1] = 0;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'dry'));
});

test('연사 무기 사격 속도가 제한된다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
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
  place(a, 78, 0);
  // 모든 축소 단계가 끝난 시점(반지름 12m)으로 진행시킨 뒤 한 틱 돌린다.
  game.tick(Date.now() + 160000);
  assert.ok(a.hp < 100, '존 밖인데 피해가 없다');
});

test('라운드 종료 후 재시작하면 킬 수가 초기화된다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  a.kills = 15;
  game.tick(Date.now());
  assert.strictEqual(game.round.state, 'ended');
  game.startRound(Date.now());
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(a.kills, 0);
  assert.strictEqual(a.hp, 100);
});

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
});

test('사망한 플레이어는 즉시 alive=0으로 스냅샷에 반영된다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 10, 0, 0);
  b.hp = 5;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  const snap = game.snapshot();
  const entry = snap.players.find((p) => p[0] === 'b');
  assert.strictEqual(entry[8], 0);
  assert.strictEqual(snap.alive, 1);
});

console.log(`\n[unit] 통과 ${passed} · 실패 ${failed}`);
if (failed > 0) process.exit(1);
