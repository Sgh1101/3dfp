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
  supportAt,
  spreadMultiplier,
  publicConfig,
  MIN_PLAYERS_TO_START,
  INTERMISSION_MS,
  GRAVITY,
  JUMP_VY,
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  HEADSHOT_MULT,
  LOOT_RANGE,
  BOT_DIFFICULTY,
} = require('../server/game');
const { BotDirector } = require('../server/bots');
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

function newBotGame(botOptions = { count: 1, difficulty: 'normal' }) {
  const game = new Game('TEST02', false, botOptions);
  game.botBrain = new BotDirector(game);
  return game;
}

function addPlayers(game, specs) {
  return specs.map(([id, name]) => game.addPlayer(id, name));
}

/** 스폰 보호 해제 + 위치/시점 강제 */
function place(player, x, z, yaw = 0, pitch = 0) {
  player.x = x;
  player.z = z;
  player.y = 0;
  player.vy = 0;
  player.grounded = true;
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
  // 가슴(1.1m)을 겨냥한 몸통 사격
  game.handleShoot('a', { yaw: Math.PI, pitch: Math.atan2(1.1 - EYE_HEIGHT, 10) });
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
  // 샷건은 기본 지급이 아니므로 1↔2만 순환한다.
  game.handleSwap('a', {});
  assert.strictEqual(a.weapon, 2);
  game.handleSwap('a', {});
  assert.strictEqual(a.weapon, 1);
});

test('보유하지 않은 무기(샷건)로는 바꿀 수 없다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  game.drainDirect();
  game.handleSwap('a', { w: 3 });
  assert.strictEqual(a.weapon, 1, '서버가 보유하지 않은 무기를 허용했다');
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'noWeapon'), 'noWeapon 통보가 없다');
});

console.log('[unit] 보급 아이템(루팅)');
test('무기 아이템을 주우면 샷건을 획득하고 그 무기로 바뀐다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  const item = game.items.find((it) => it.kind === 'weapon');
  a.x = item.x;
  a.z = item.z;
  game.handleLoot('a');
  assert.strictEqual(a.owned[3], true, '샷건 보유가 서버에 반영되지 않았다');
  assert.strictEqual(a.weapon, 3, '획득한 무기로 바뀌지 않았다');
  assert.strictEqual(a.mag[3], 6);
  assert.ok(item.readyAt > Date.now(), '아이템이 소모되지 않았다(무한 파밍)');
  const direct = game.drainDirect();
  assert.ok(direct.some((d) => d.message.t === 'looted' && d.message.weapon === 3), 'looted 통보가 없다');
});

test('탄약·힐·구급상자 효과는 서버가 계산한다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  // 탄약
  a.reserve[1] = 10;
  const ammo = game.items.find((it) => it.kind === 'ammo');
  a.x = ammo.x;
  a.z = ammo.z;
  game.handleLoot('a');
  assert.ok(a.reserve[1] > 10, '탄약이 보충되지 않았다');

  // 힐 키트
  a.kits = 0;
  const kit = game.items.find((it) => it.kind === 'kit');
  a.x = kit.x;
  a.z = kit.z;
  game.handleLoot('a');
  assert.strictEqual(a.kits, 1, '힐 키트가 지급되지 않았다');

  // 구급상자: 즉시 회복
  a.hp = 40;
  const med = game.items.find((it) => it.kind === 'medkit');
  a.x = med.x;
  a.z = med.z;
  game.handleLoot('a');
  assert.ok(a.hp > 40, '구급상자로 회복되지 않았다');
  assert.ok(a.hp <= 100, 'HP 상한을 넘었다');
});

test('범위 밖·재사용 대기 중 아이템은 지급되지 않는다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 0, -60);
  a.reserve[1] = 10;
  const ammo = game.items.find((it) => it.kind === 'ammo');
  a.x = ammo.x + LOOT_RANGE + 1;
  a.z = ammo.z;
  game.handleLoot('a');
  assert.strictEqual(a.reserve[1], 10, '멀리서 아이템을 주웠다');

  // 범위 안에서 줍고, 곧바로 다시 시도하면 재사용 대기로 거절된다.
  a.x = ammo.x;
  game.handleLoot('a');
  const after = a.reserve[1];
  game.handleLoot('a');
  assert.strictEqual(a.reserve[1], after, '재사용 대기 중인 아이템이 또 지급됐다');
});

test('이미 가득 찬 상태에서는 아이템을 소모하지 않는다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  const med = game.items.find((it) => it.kind === 'medkit');
  a.x = med.x;
  a.z = med.z;
  a.hp = 100;
  game.handleLoot('a');
  assert.strictEqual(med.readyAt, 0, 'HP가 가득인데 구급상자가 소모됐다');
});

console.log('[unit] 점프·앉기(수직 물리·판정)');
test('점프하면 y가 올라가고 중력으로 다시 0에 착지한다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  game.handleJump('a');
  assert.ok(a.vy > 0, '점프 속도가 없다');
  assert.strictEqual(a.grounded, false);
  let maxY = 0;
  const t0 = Date.now();
  for (let i = 1; i <= 30; i += 1) {
    game.tick(t0 + i * 50);
    maxY = Math.max(maxY, a.y);
  }
  assert.ok(maxY > 1.2, `점프 높이가 너무 낮다: ${maxY.toFixed(2)}m`);
  assert.ok(maxY < 2.6, `점프가 너무 높다: ${maxY.toFixed(2)}m`);
  assert.strictEqual(a.y, 0, `착지하지 않았다: y=${a.y}`);
  assert.strictEqual(a.grounded, true);
  const events = game.drainEvents();
  assert.ok(events.some((e) => e.k === 'jump' && e.id === 'a'), 'jump 이벤트가 없다');
  assert.ok(events.some((e) => e.k === 'land' && e.id === 'a'), 'land 이벤트가 없다');
});

test('공중에서는 두 번 점프할 수 없다(서버 권위)', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파']]);
  place(a, 60, 0);
  game.handleJump('a');
  const vyAfterFirst = a.vy;
  game.tick(Date.now() + 50);
  game.handleJump('a');
  assert.ok(a.vy <= vyAfterFirst, '공중에서 점프가 중첩됐다');
});

test('스냅샷의 y가 점프 중 실제 높이를 담는다', () => {
  const game = newGame();
  addPlayers(game, [['a', '알파'], ['b', '베타']]);
  const a = game.players.get('a');
  place(a, 60, 0);
  game.handleJump('a');
  game.tick(Date.now() + 250);
  game.tick(Date.now() + 300);
  const snap = game.snapshot();
  const me = snap.players.find((p) => p[0] === 'a');
  assert.ok(me[3] > 0.5, `스냅샷 y가 0이다: ${me[3]}`);
});

test('사격 원점(눈높이)이 점프·앉기 y를 그대로 반영한다', () => {
  const game = newGame();
  const [a] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  forceLive(game);
  place(a, 60, 0, Math.PI, 0);
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  let shot = game.drainEvents().find((e) => e.k === 'shot');
  assert.ok(Math.abs(shot.from[1] - EYE_HEIGHT) < 0.02, `서 있을 때 눈높이가 ${shot.from[1]}`);

  a.nextShotAt = 0;
  a.crouch = true;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  shot = game.drainEvents().find((e) => e.k === 'shot');
  assert.ok(Math.abs(shot.from[1] - CROUCH_EYE_HEIGHT) < 0.02, `앉았을 때 눈높이가 ${shot.from[1]}`);

  a.nextShotAt = 0;
  a.crouch = false;
  a.y = 1.2;
  a.vy = 0;
  a.grounded = false;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  shot = game.drainEvents().find((e) => e.k === 'shot');
  assert.ok(Math.abs(shot.from[1] - (1.2 + EYE_HEIGHT)) < 0.03, `점프 중 눈높이가 ${shot.from[1]}`);
});

test('1.6m 상자 뒤 적은 서 있으면 머리가 노출되어 맞고, 앉으면 가려진다', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  // 상자(7.4, 7.4) 뒤에 b를, 앞에 a를 둔다(둘 다 지상).
  place(a, 7.4, 3.5, Math.PI, 0);
  place(b, 7.4, 9.6, 0, 0);
  // 머리(1.7m) 높이로 겨냥
  const pitch = Math.atan2(1.7 - EYE_HEIGHT, 6.1);
  game.handleShoot('a', { yaw: Math.PI, pitch });
  assert.ok(b.hp < 100, '상자 위로 나온 머리를 맞히지 못했다');

  // 앉으면 머리가 1.22m 아래로 내려가 상자(1.6m)에 완전히 가려진다.
  b.hp = 100;
  b.crouch = true;
  a.nextShotAt = 0;
  a.mag[1] = 30;
  game.handleShoot('a', { yaw: Math.PI, pitch });
  assert.strictEqual(b.hp, 100, '앉아서 가려진 적을 맞혔다');
});

test('마지막 생존자 판정에서 탈락한 뒤 y가 0으로 돌아간다(허공 판정 방지)', () => {
  const game = newGame();
  const [a, b] = addPlayers(game, [['a', '알파'], ['b', '베타']]);
  place(a, 60, 0, Math.PI, 0);
  place(b, 60, 6, 0, 0);
  b.y = 1.4;
  b.grounded = false;
  b.hp = 5;
  game.handleShoot('a', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(b.alive, false);
  assert.strictEqual(b.y, 0, '탈락자의 높이가 남아 있다');
});

test('supportAt이 바닥과 엄폐물 윗면을 구분한다', () => {
  assert.strictEqual(supportAt(0, -40, 0), 0);
  assert.strictEqual(supportAt(0, 0, 3), 2.6, '중앙 블록 윗면을 찾지 못했다');
  assert.strictEqual(supportAt(0, 0, 0), 0, '블록 옆(지상)인데 윗면으로 올렸다');
});

console.log('[unit] AI 봇');
test('방 만든 사람의 봇 설정대로 사람+AI 가 채워진다', () => {
  const game = newBotGame({ count: 3, difficulty: 'hard' });
  addPlayers(game, [['h', '사람']]);
  assert.strictEqual(game.humanCount, 1);
  assert.strictEqual(game.botCount, 3, `봇이 ${game.botCount}명이다`);
  assert.strictEqual(game.playerCount, 4);
  const bot = [...game.players.values()].find((p) => p.isBot);
  assert.strictEqual(bot.name.startsWith('봇'), true);
  assert.ok(bot.ai, '봇 두뇌 상태가 없다');
});

test('빈자리 채우기(fill)는 사람+AI 합산 8명을 유지한다', () => {
  const game = newBotGame({ count: 0, fill: true, difficulty: 'normal' });
  addPlayers(game, [['h1', '사람1']]);
  assert.strictEqual(game.playerCount, 8, `봇 포함 ${game.playerCount}명`);
  addPlayers(game, [['h2', '사람2']]);
  assert.strictEqual(game.playerCount, 8);
  assert.strictEqual(game.humanCount, 2);
  assert.strictEqual(game.botCount, 6);
  assert.ok(game.playerCount <= 8, '정원 8명을 넘었다');
});

test('사람이 모두 나가면 봇도 정리된다(빈 방 유지 방지)', () => {
  const game = newBotGame({ count: 2 });
  addPlayers(game, [['h', '사람']]);
  assert.ok(game.botCount > 0);
  game.removePlayer('h');
  assert.strictEqual(game.humanCount, 0);
  assert.strictEqual(game.botCount, 0, '사람이 없는데 봇이 남았다');
  assert.strictEqual(game.playerCount, 0);
});

test('봇은 벽 너머 적을 보지 못한다(시야선 검사)', () => {
  const game = newBotGame({ count: 1, difficulty: 'hard' });
  const h = addPlayers(game, [['h', '사람']])[0];
  const bot = [...game.players.values()].find((p) => p.isBot);
  const director = game.botBrain;
  // 중앙 블록(10x10, 2.6m)을 사이에 두고 마주 세운다.
  place(h, 0, 14);
  place(bot, 0, -14);
  const visible = director.hasLineOfSight(director.eyeOf(bot), { x: h.x, y: h.y + 1.2, z: h.z });
  assert.strictEqual(visible, false, '벽 너머를 보는 것으로 판정됐다');
  // 벽이 없는 쪽으로 옮기면 보인다.
  place(h, 30, -14);
  const visible2 = director.hasLineOfSight(director.eyeOf(bot), { x: h.x, y: h.y + 1.2, z: h.z });
  assert.strictEqual(visible2, true, '트인 곳인데 시야가 없다고 판정했다');
});

test('봇은 시야가 트인 사거리에서만 사격하고 탄약/탄퍼짐은 사람과 동일 규칙을 쓴다', () => {
  const game = newBotGame({ count: 1, difficulty: 'hard' });
  const h = addPlayers(game, [['h', '사람']])[0];
  const bot = [...game.players.values()].find((p) => p.isBot);
  // 중앙 블록 뒤: 쏘지 않아야 한다.
  place(h, 0, 12);
  place(bot, 0, -12);
  game.round.state = 'live';
  const t0 = Date.now();
  for (let i = 0; i < 20; i += 1) game.tick(t0 + i * 50);
  assert.strictEqual(h.hp, 100, '벽 너머인데 피해를 입었다');
  // 트인 거리로 옮기면(반응 시간 뒤) 쏜다.
  place(h, 42, 4);
  place(bot, 30, 4);
  bot.mag[1] = 30;
  bot.nextShotAt = 0;
  let shots = 0;
  const start = Date.now();
  while (Date.now() - start < 1500) {
    // handleShoot은 실제 시계를 쓰므로 실제 시간으로 돌린다.
    game.tick(Date.now());
    shots = game.events.filter((e) => e.k === 'shot' && e.id === bot.id).length;
    if (shots > 0) break;
    // 바쁜 대기 대신 수면
    const until = Date.now() + 40;
    while (Date.now() < until) {
      /* 대기 */
    }
  }
  assert.ok(shots > 0, '시야가 트였는데 봇이 쏘지 않았다');
  assert.ok(bot.mag[1] < 30, '봇 사격이 탄약을 쓰지 않았다');
});

test('봇 난이도는 반응 시간과 조준 오차로 조절된다', () => {
  assert.ok(BOT_DIFFICULTY.easy.reactionMs > BOT_DIFFICULTY.hard.reactionMs, '난이도별 반응 시간 차이가 없다');
  assert.ok(BOT_DIFFICULTY.easy.aimError > BOT_DIFFICULTY.hard.aimError, '난이도별 조준 오차 차이가 없다');
});

test('사람+AI로 라운드가 시작되고 탈락 시 마지막 생존자 판정이 동작한다', () => {
  const game = newBotGame({ count: 1, difficulty: 'easy' });
  const h = addPlayers(game, [['h', '사람']])[0];
  const bot = [...game.players.values()].find((p) => p.isBot);
  assert.strictEqual(game.round.state, 'live', '사람+AI 2명인데 라운드가 시작되지 않았다');
  assert.strictEqual(game.round.startedWith, 2);
  assert.strictEqual(game.aliveCount, 2);

  // 사람이 봇을 죽인다.
  place(h, 60, 0, Math.PI, 0);
  place(bot, 60, 6, 0, 0);
  bot.hp = 10;
  game.handleShoot('h', { yaw: Math.PI, pitch: 0 });
  assert.strictEqual(bot.alive, false);
  game.tick(Date.now());
  assert.strictEqual(game.round.state, 'ended');
  assert.strictEqual(game.round.winner.id, 'h');

  // 다음 라운드에서 봇도 함께 부활한다.
  game.tick(game.round.nextRoundAt + 1);
  assert.strictEqual(game.round.state, 'live');
  assert.strictEqual(bot.alive, true, '봇이 다음 라운드에 부활하지 않았다');
});

test('방 정원은 사람+AI 합산 8명이다', () => {
  const { RoomManager } = require('../server/rooms');
  const rooms = new RoomManager({ maxRooms: 4 });
  const { room } = rooms.join({ create: true, bots: 7, difficulty: 'normal' }, 'h1', '사람1');
  // 봇 7 + 사람 1 = 8
  assert.strictEqual(room.game.playerCount, 8);
  // 가득 찼지만 봇이 있으므로 사람이 들어오면 봇이 비켜 준다.
  const second = rooms.join({ code: room.code }, 'h2', '사람2');
  assert.ok(second.room, `사람이 들어가지 못했다: ${second.error && second.error.code}`);
  assert.ok(room.game.playerCount <= 8, `정원 초과: ${room.game.playerCount}`);
  assert.strictEqual(room.game.humanCount, 2);
  assert.strictEqual(room.game.botCount, 6);
  // 호스트가 나가면 정원 맞춤(fill 아님)은 유지된다.
  rooms.join({ code: room.code }, 'h3', '사람3');
  rooms.join({ code: room.code }, 'h4', '사람4');
  rooms.join({ code: room.code }, 'h5', '사람5');
  rooms.join({ code: room.code }, 'h6', '사람6');
  assert.ok(room.game.playerCount <= 8, `정원 초과: ${room.game.playerCount}`);
  assert.strictEqual(room.game.humanCount, 6);
  assert.ok(room.game.botCount <= 2, `봇이 자리를 비우지 않았다: ${room.game.botCount}`);
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
  game.handleSwap('a', { w: 2 });
  assert.strictEqual(a.weapon, 2);
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
