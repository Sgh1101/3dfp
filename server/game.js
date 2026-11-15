'use strict';

/**
 * 권위 서버(authoritative server) 게임 로직.
 *
 * - 방 하나 = Game 인스턴스 하나. 20Hz(50ms) 틱으로 상태를 갱신하고 스냅샷을 만든다.
 * - 이동은 클라이언트 예측 + 서버 검증(속도 제한/좌표 범위/NaN) 방식이고,
 *   사격·피해·존·라운드는 전부 서버가 계산한다.
 * - 라운드 규칙은 **배틀로얄(노리스폰)**: 라운드 중 사망한 플레이어는 라운드가 끝날 때까지 관전하고,
 *   마지막 생존자가 승리한다. 라운드 사이(인터미션)에 전원이 alive/HP/탄약을 새로 받는다.
 */

const { ARENA, COVERS, SPAWNS } = require('./map');
const { RateLimiter } = require('./limits');

// ── 상수 ────────────────────────────────────────────────────────────────────
const TICK_MS = 50;
const TICK_RATE = 1000 / TICK_MS;

const MAX_SPEED = 6.6; // m/s (클라이언트 이동 속도 6.0 + 여유)
const SPEED_GRACE = 0.07; // 패킷 지터 허용치(m)
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const MAX_HP = 100;
const HEAL_KITS = 2;
const HEAL_AMOUNT = 35;
const HEAL_COOLDOWN_MS = 1200;
const SPAWN_PROTECT_MS = 10000;

// 배틀로얄: 라운드 중 리스폰 없음. 라운드 사이 인터미션에서만 되살아난다.
const ROUND_MS = 180000;
const INTERMISSION_MS = 8000;
/** 라운드를 시작하려면 이 인원이 필요하다(혼자면 워밍업 대기). */
const MIN_PLAYERS_TO_START = 2;

const START_RADIUS = 80;
const ZONE_DPS = 12;
const ZONE_PHASES = [
  { waitMs: 20000, shrinkMs: 40000, radius: 55 },
  { waitMs: 15000, shrinkMs: 30000, radius: 32 },
  { waitMs: 15000, shrinkMs: 25000, radius: 12 },
];

const MAX_NAME_LENGTH = 16;
const MAX_VIOLATIONS = 400;

const WEAPONS = {
  1: {
    id: 1,
    key: 'rifle',
    name: '라이플',
    damage: 24,
    fireDelay: 110,
    mag: 30,
    reserve: 150,
    reloadMs: 2200,
    pellets: 1,
    spread: 0.006,
    range: 140,
    auto: true,
  },
  2: {
    id: 2,
    key: 'pistol',
    name: '권총',
    damage: 32,
    fireDelay: 220,
    mag: 12,
    reserve: 72,
    reloadMs: 1400,
    pellets: 1,
    spread: 0.004,
    range: 90,
    auto: false,
  },
  3: {
    id: 3,
    key: 'shotgun',
    name: '샷건',
    damage: 11,
    fireDelay: 800,
    mag: 6,
    reserve: 36,
    reloadMs: 2500,
    pellets: 8,
    spread: 0.055,
    range: 42,
    auto: false,
  },
};

const WEAPON_ORDER = [1, 2, 3];

// ── 유틸 ────────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** yaw를 -PI ~ PI로 정규화 */
function normalizeAngle(a) {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** 닉네임 새니타이즈: HTML 태그 제거 + 특수문자 이스케이프 + 길이/공백 정리 */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '플레이어';
  let name = raw
    .replace(/<[^>]*>/g, '') // 태그 제거
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '') // 제어/제로폭 문자 제거
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return '플레이어';
  const chars = Array.from(name);
  if (chars.length > MAX_NAME_LENGTH) name = chars.slice(0, MAX_NAME_LENGTH).join('');
  return name;
}

/** 초당/기간당 호출 횟수 제한(토큰 버킷 대용 슬라이딩 윈도)은 server/limits.js 의 RateLimiter를 쓴다. */

/** 슬랩(slab) 방식 레이-AABB 교차. 진입 거리(t>=0)를 반환하고, 빗나가면 null. */
function rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
  let tmin = 0;
  let tmax = maxDist;

  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let t1 = (minX - ox) / dx;
    let t2 = (maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return null;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let t1 = (minZ - oz) / dz;
    let t2 = (maxZ - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** 원(플레이어)과 AABB의 수평 충돌을 밀어내 해소한다. */
function pushOutOfBox(x, z, radius, box) {
  const cx = clamp(x, box.minX, box.maxX);
  const cz = clamp(z, box.minZ, box.maxZ);
  const dx = x - cx;
  const dz = z - cz;
  const distSq = dx * dx + dz * dz;
  if (distSq > radius * radius) return null;
  if (distSq > 1e-9) {
    const dist = Math.sqrt(distSq);
    return { x: x + (dx / dist) * (radius - dist), z: z + (dz / dist) * (radius - dist) };
  }
  // 박스 내부에 들어간 경우 가장 가까운 면으로 밀어낸다.
  const toLeft = x - box.minX;
  const toRight = box.maxX - x;
  const toBack = z - box.minZ;
  const toFront = box.maxZ - z;
  const min = Math.min(toLeft, toRight, toBack, toFront);
  if (min === toLeft) return { x: box.minX - radius, z };
  if (min === toRight) return { x: box.maxX + radius, z };
  if (min === toBack) return { x, z: box.minZ - radius };
  return { x, z: box.maxZ + radius };
}

function resolveCollisions(x, z, radius) {
  let px = x;
  let pz = z;
  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (const box of COVERS) {
      const hit = pushOutOfBox(px, pz, radius, box);
      if (hit) {
        px = hit.x;
        pz = hit.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const limit = ARENA.half - radius;
  return { x: clamp(px, -limit, limit), z: clamp(pz, -limit, limit) };
}

// ── Game ────────────────────────────────────────────────────────────────────
class Game {
  constructor(code, isDefault = false) {
    this.code = code;
    this.isDefault = Boolean(isDefault);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.tickCount = 0;
    /** 방송용 이벤트 큐 */
    this.events = [];
    /** 특정 클라이언트에게만 보낼 메시지 큐 */
    this.direct = [];
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();

    this.zone = {
      stage: 0,
      radius: START_RADIUS,
      centerX: 0,
      centerZ: 0,
      shrinking: false,
      nextIn: 0,
      schedule: [],
    };
    this.resetZone(Date.now());

    this.round = {
      index: 0,
      state: 'waiting', // waiting(인원 부족 워밍업) | live | ended(인터미션)
      startedAt: 0,
      endsAt: 0,
      winner: null,
      nextRoundAt: 0,
      /** 라운드 시작 시점 인원(2명 이상일 때만 마지막 생존자 승리 판정) */
      startedWith: 0,
      /** 종료 사유: last-survivor | timeout | wipe */
      reason: null,
    };
  }

  // ── 방 상태 ──
  get playerCount() {
    return this.players.size;
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  get aliveCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.alive) n += 1;
    return n;
  }

  // ── 존 ──
  resetZone(now) {
    const schedule = [];
    let t = now;
    let radius = START_RADIUS;
    for (const phase of ZONE_PHASES) {
      schedule.push({ kind: 'wait', start: t, end: t + phase.waitMs, from: radius, to: radius });
      t += phase.waitMs;
      schedule.push({ kind: 'shrink', start: t, end: t + phase.shrinkMs, from: radius, to: phase.radius });
      t += phase.shrinkMs;
      radius = phase.radius;
    }
    this.zone.stage = 0;
    this.zone.radius = START_RADIUS;
    this.zone.centerX = 0;
    this.zone.centerZ = 0;
    this.zone.shrinking = false;
    this.zone.schedule = schedule;
    this.zone.nextIn = ZONE_PHASES[0].waitMs;
  }

  updateZone(now) {
    const schedule = this.zone.schedule;
    if (!schedule.length) return;
    let segment = schedule[schedule.length - 1];
    for (const seg of schedule) {
      if (now < seg.end) {
        segment = seg;
        break;
      }
    }
    let stage = 0;
    for (const seg of schedule) {
      if (seg.kind === 'shrink' && seg.start <= now) stage += 1;
    }
    const span = Math.max(1, segment.end - segment.start);
    const k = clamp((now - segment.start) / span, 0, 1);
    this.zone.stage = Math.min(stage, ZONE_PHASES.length);
    this.zone.radius = segment.from + (segment.to - segment.from) * k;
    this.zone.shrinking = segment.kind === 'shrink' && now >= segment.start && now < segment.end;
    this.zone.nextIn = Math.max(0, segment.end - now);
    this.zone.final = stage >= ZONE_PHASES.length && now >= segment.end;
  }

  distanceToZoneCenter(x, z) {
    return Math.hypot(x - this.zone.centerX, z - this.zone.centerZ);
  }

  // ── 플레이어 ──
  pickSpawn(excludeId) {
    let best = SPAWNS[0];
    let bestScore = -Infinity;
    for (const spawn of SPAWNS) {
      let nearest = 300;
      for (const other of this.players.values()) {
        if (!other.alive || other.id === excludeId) continue;
        const d = Math.hypot(other.x - spawn.x, other.z - spawn.z);
        if (d < nearest) nearest = d;
      }
      let score = nearest + Math.random() * 5;
      // 이미 닫힌 존 밖 스폰은 감점 (존 안에서 스폰되면 불리하므로)
      if (Math.hypot(spawn.x, spawn.z) > this.zone.radius - 6) score -= 120;
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    return best;
  }

  addPlayer(id, name) {
    const now = Date.now();
    const spawn = this.pickSpawn(id);
    const player = {
      id,
      name: sanitizeName(name),
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: spawn.yaw || 0,
      pitch: 0,
      hp: MAX_HP,
      alive: true,
      weapon: 1,
      mag: {},
      reserve: {},
      reloadEnd: 0,
      reloadWeapon: 0,
      nextShotAt: 0,
      nextHealAt: 0,
      kits: HEAL_KITS,
      kills: 0,
      deaths: 0,
      ready: false,
      spawnProtectUntil: now + SPAWN_PROTECT_MS,
      respawnAt: 0,
      /** 라운드 진행 중에 들어와 다음 라운드까지 기다리는 관전자 */
      spectator: false,
      lastMoveAt: now,
      lastZoneDamageAt: 0,
      lastStepAt: 0,
      violations: 0,
      joinedAt: now,
      rate: {
        move: new RateLimiter(TICK_RATE * 2, 1000),
        shoot: new RateLimiter(25, 1000),
        action: new RateLimiter(15, 1000),
      },
    };
    for (const key of WEAPON_ORDER) {
      player.mag[key] = WEAPONS[key].mag;
      player.reserve[key] = WEAPONS[key].reserve;
    }
    // 진행 중인 라운드에 새로 들어온 플레이어는 탈락 상태로 관전하고, 다음 라운드에 합류한다.
    if (this.round.state === 'live') {
      player.alive = false;
      player.hp = 0;
      player.spectator = true;
    }
    this.players.set(id, player);
    this.lastActivityAt = now;
    this.pushEvent({ k: 'join', id, name: player.name });
    // 혼자서는 라운드가 시작되지 않고, 두 번째 플레이어가 들어오면 바로 배틀로얄을 시작한다.
    if (this.round.state === 'waiting') this.tryStartRound(now);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return null;
    this.players.delete(id);
    this.lastActivityAt = Date.now();
    this.pushEvent({ k: 'leave', id, name: player.name });
    // 상대가 나가 1명만 남으면 라운드를 계속할 수 없다 → 워밍업으로 돌린다.
    if (this.round.state === 'live' && this.players.size < MIN_PLAYERS_TO_START) {
      this.goWaiting(Date.now());
    }
    return player;
  }

  /** 새 라운드/리젠 시 플레이어 상태 초기화 */
  resetPlayer(player, now, keepScore = true) {
    const spawn = this.pickSpawn(player.id);
    player.x = spawn.x;
    player.z = spawn.z;
    player.y = 0;
    player.yaw = spawn.yaw || 0;
    player.pitch = 0;
    player.hp = MAX_HP;
    player.alive = true;
    player.weapon = 1;
    for (const key of WEAPON_ORDER) {
      player.mag[key] = WEAPONS[key].mag;
      player.reserve[key] = WEAPONS[key].reserve;
    }
    player.reloadEnd = 0;
    player.reloadWeapon = 0;
    player.nextShotAt = 0;
    player.nextHealAt = 0;
    player.kits = HEAL_KITS;
    player.spawnProtectUntil = now + SPAWN_PROTECT_MS;
    player.respawnAt = 0;
    player.spectator = false;
    player.lastMoveAt = now;
    player.lastZoneDamageAt = 0;
    player.ready = false;
    if (!keepScore) {
      player.kills = 0;
      player.deaths = 0;
    }
    this.pushEvent({ k: 'respawn', id: player.id });
  }

  // ── 입력 처리 ──
  handleMove(id, msg) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    if (!msg || typeof msg !== 'object') return;
    const now = Date.now();
    if (!player.rate.move.allow(now)) return;

    const x = Number(msg.x);
    const z = Number(msg.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return; // NaN / Infinity 차단
    if (Math.abs(x) > ARENA.half || Math.abs(z) > ARENA.half) {
      player.violations += 1;
      return; // 범위 밖 좌표는 패킷 폐기
    }

    const yaw = Number(msg.yaw);
    const pitch = Number(msg.pitch);
    if (Number.isFinite(yaw)) player.yaw = normalizeAngle(yaw);
    if (Number.isFinite(pitch)) player.pitch = clamp(pitch, -1.5, 1.5);

    // 속도 검증: 한 틱에 이동 가능한 거리를 넘으면 되돌린다(스피드핵 롤백).
    const dt = clamp((now - player.lastMoveAt) / 1000, 0.01, 0.35);
    const maxDist = MAX_SPEED * dt + SPEED_GRACE;
    const dx = x - player.x;
    const dz = z - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) {
      const scale = maxDist / dist;
      player.x += dx * scale;
      player.z += dz * scale;
      player.violations += 1;
      this.pushDirect(player.id, { t: 'corr', x: round2(player.x), z: round2(player.z) });
    } else {
      player.x = x;
      player.z = z;
    }

    const resolved = resolveCollisions(player.x, player.z, PLAYER_RADIUS);
    if (Math.hypot(resolved.x - player.x, resolved.z - player.z) > 0.001) {
      player.x = resolved.x;
      player.z = resolved.z;
      this.pushDirect(player.id, { t: 'corr', x: round2(player.x), z: round2(player.z) });
    }
    player.y = 0;
    player.lastMoveAt = now;

    if (player.violations > MAX_VIOLATIONS) {
      this.pushDirect(player.id, { t: 'kick', message: '비정상적인 이동이 감지되어 연결을 종료합니다.' });
    }
  }

  handleShoot(id, msg) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    if (this.round.state !== 'live') return;
    const now = Date.now();
    if (!player.rate.shoot.allow(now)) return;
    if (now < player.reloadEnd) return;

    const weapon = WEAPONS[player.weapon];
    if (now < player.nextShotAt) return;
    player.nextShotAt = now + weapon.fireDelay;

    if (Number.isFinite(Number(msg && msg.yaw))) player.yaw = normalizeAngle(Number(msg.yaw));
    if (Number.isFinite(Number(msg && msg.pitch))) player.pitch = clamp(Number(msg.pitch), -1.5, 1.5);

    if (player.mag[player.weapon] <= 0) {
      this.pushDirect(player.id, { t: 'dry' });
      return;
    }

    player.mag[player.weapon] -= 1;
    player.spawnProtectUntil = 0; // 사격하면 스폰 보호 해제

    const origin = {
      x: player.x,
      y: player.y + EYE_HEIGHT,
      z: player.z,
    };
    const baseDir = directionFromAngles(player.yaw, player.pitch);
    const start = { x: origin.x + baseDir.x * 0.4, y: origin.y, z: origin.z + baseDir.z * 0.4 };

    let anyHit = false;
    const impacts = [];

    for (let pellet = 0; pellet < weapon.pellets; pellet += 1) {
      const dir = pellet === 0 && weapon.pellets === 1 ? baseDir : applySpread(baseDir, weapon.spread);
      const hit = this.traceShot(player, start, dir, weapon.range);
      impacts.push({
        x: round2(start.x + dir.x * hit.dist),
        y: round2(start.y + dir.y * hit.dist),
        z: round2(start.z + dir.z * hit.dist),
      });
      if (hit.playerId && hit.playerId !== player.id) {
        anyHit = true;
        this.applyDamage(player, hit.playerId, weapon.damage, weapon.key, now);
      }
    }

    this.pushEvent({
      k: 'shot',
      id: player.id,
      w: player.weapon,
      from: [round2(start.x), round2(start.y), round2(start.z)],
      to: [impacts[0].x, impacts[0].y, impacts[0].z],
      impacts,
      hit: anyHit,
      ammo: player.mag[player.weapon],
    });
  }

  /** 히트스캔: 커버(벽)를 먼저 검사하고, 그보다 가까운 플레이어만 맞은 것으로 판정한다. */
  traceShot(shooter, origin, dir, maxDist) {
    let bestDist = maxDist;
    let hitPlayerId = null;

    for (const cover of COVERS) {
      const t = rayAABB(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        cover.minX, cover.minY, cover.minZ,
        cover.maxX, cover.maxY, cover.maxZ,
        bestDist,
      );
      if (t !== null && t < bestDist) bestDist = t;
    }

    for (const other of this.players.values()) {
      if (other.id === shooter.id || !other.alive) continue;
      if (other.spawnProtectUntil > Date.now()) continue;
      const t = rayAABB(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        other.x - PLAYER_RADIUS, other.y, other.z - PLAYER_RADIUS,
        other.x + PLAYER_RADIUS, other.y + PLAYER_HEIGHT, other.z + PLAYER_RADIUS,
        bestDist,
      );
      if (t !== null && t < bestDist) {
        bestDist = t;
        hitPlayerId = other.id;
      }
    }

    return { dist: bestDist, playerId: hitPlayerId };
  }

  applyDamage(attacker, targetId, damage, weaponKey, now) {
    const target = this.players.get(targetId);
    if (!target || !target.alive) return;
    if (target.spawnProtectUntil > now) return;

    const dealt = Math.min(target.hp, damage);
    target.hp -= dealt;

    this.pushEvent({
      k: 'hit',
      by: attacker ? attacker.id : null,
      id: targetId,
      dmg: Math.round(dealt),
      hp: Math.max(0, Math.round(target.hp)),
    });

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.deaths += 1;
      target.respawnAt = 0; // 배틀로얄: 라운드 중 리스폰 없음(라운드 종료 후 일괄 부활)
      target.reloadEnd = 0;
      target.reloadWeapon = 0;
      target.ready = false;
      if (attacker && attacker.id !== target.id) attacker.kills += 1;
      this.pushEvent({
        k: 'kill',
        killer: attacker ? attacker.name : null,
        killerId: attacker ? attacker.id : null,
        victim: target.name,
        victimId: target.id,
        weapon: weaponKey,
        headshot: false,
      });
    }
  }

  handleReload(id) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    const now = Date.now();
    if (!player.rate.action.allow(now)) return;
    if (now < player.reloadEnd) return;
    const weapon = WEAPONS[player.weapon];
    if (player.mag[player.weapon] >= weapon.mag) return;
    if (player.reserve[player.weapon] <= 0) {
      this.pushDirect(player.id, { t: 'dry', reason: 'reserve' });
      return;
    }
    player.reloadEnd = now + weapon.reloadMs;
    player.reloadWeapon = player.weapon;
    this.pushDirect(player.id, { t: 'reloadStart', weapon: player.weapon, ms: weapon.reloadMs });
    this.pushEvent({ k: 'reload', id: player.id, weapon: player.weapon, ms: weapon.reloadMs });
  }

  /** 재장전 취소(무기 교체·사망 시). 진행 중이던 타이머를 즉시 버린다. */
  cancelReload(player) {
    const wasReloading = player.reloadEnd > Date.now();
    player.reloadEnd = 0;
    player.reloadWeapon = 0;
    if (wasReloading) this.pushDirect(player.id, { t: 'reloadCancel', weapon: player.weapon });
    return wasReloading;
  }

  finishReload(player) {
    const weapon = WEAPONS[player.weapon];
    const need = weapon.mag - player.mag[player.weapon];
    const take = Math.min(need, player.reserve[player.weapon]);
    player.mag[player.weapon] += take;
    player.reserve[player.weapon] -= take;
  }

  handleSwap(id, msg) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    const now = Date.now();
    if (!player.rate.action.allow(now)) return;
    const requested = msg ? Number(msg.w) : NaN;
    let next;
    if (Number.isFinite(requested) && WEAPONS[requested]) {
      next = requested;
    } else {
      const idx = WEAPON_ORDER.indexOf(player.weapon);
      next = WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length];
    }
    if (next === player.weapon) return;
    player.weapon = next;
    // 무기 교체 시 이전 무기의 재장전은 즉시 취소한다(새 무기에 완료가 얹히지 않도록).
    this.cancelReload(player);
    player.nextShotAt = Math.max(player.nextShotAt, now + 250);
    this.pushEvent({ k: 'swap', id, weapon: next });
  }

  handleHeal(id) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    const now = Date.now();
    if (!player.rate.action.allow(now)) return;
    if (now < player.nextHealAt) return;
    if (player.kits <= 0) {
      this.pushDirect(player.id, { t: 'dry', reason: 'kits' });
      return;
    }
    if (player.hp >= MAX_HP) return;
    player.kits -= 1;
    player.nextHealAt = now + HEAL_COOLDOWN_MS;
    player.hp = Math.min(MAX_HP, player.hp + HEAL_AMOUNT);
    this.pushEvent({ k: 'heal', id, hp: Math.round(player.hp), kits: player.kits });
    this.pushDirect(player.id, { t: 'healed', hp: Math.round(player.hp), kits: player.kits });
  }

  handleReady(id) {
    const player = this.players.get(id);
    if (!player) return;
    if (this.round.state === 'live') return;
    const now = Date.now();
    player.ready = true;
    this.pushEvent({ k: 'ready', id, name: player.name });
    let allReady = true;
    for (const p of this.players.values()) {
      if (!p.ready) allReady = false;
    }
    // 전원 준비되면 인터미션을 기다리지 않고 바로 다음 라운드를 시작한다.
    if (allReady && this.players.size >= MIN_PLAYERS_TO_START) {
      this.round.nextRoundAt = 0;
      this.startRound(now);
    }
  }

  // ── 라운드(배틀로얄) ──
  /** 인원이 모자라 라운드를 시작할 수 없을 때의 워밍업 상태로 되돌린다. */
  goWaiting(now) {
    this.round.state = 'waiting';
    this.round.startedAt = 0;
    this.round.endsAt = 0;
    this.round.nextRoundAt = 0;
    this.round.winner = null;
    this.round.startedWith = 0;
    this.resetZone(now);
    for (const player of this.players.values()) this.resetPlayer(player, now, true);
    this.pushEvent({
      k: 'round',
      phase: 'waiting',
      index: this.round.index,
      need: MIN_PLAYERS_TO_START,
      total: this.players.size,
    });
  }

  /** 대기 중이고 인원이 찼으면 라운드를 시작한다. */
  tryStartRound(now) {
    if (this.round.state !== 'waiting') return false;
    if (this.players.size < MIN_PLAYERS_TO_START) return false;
    this.startRound(now);
    return true;
  }

  startRound(now) {
    if (this.players.size < MIN_PLAYERS_TO_START) {
      this.goWaiting(now);
      return;
    }
    this.round.index += 1;
    this.round.state = 'live';
    this.round.reason = null;
    this.round.startedAt = now;
    this.round.endsAt = now + ROUND_MS;
    this.round.winner = null;
    this.round.nextRoundAt = 0;
    this.round.startedWith = this.players.size;
    this.resetZone(now);
    for (const player of this.players.values()) {
      player.kills = 0;
      player.deaths = 0;
      this.resetPlayer(player, now, false);
    }
    this.pushEvent({
      k: 'round',
      phase: 'start',
      index: this.round.index,
      total: this.players.size,
      timeMs: ROUND_MS,
    });
  }

  /**
   * 라운드 종료. winner 는 마지막 생존자(또는 시간 종료 시 HP 우세자).
   * @param {number} now
   * @param {string|null} winnerId
   * @param {'last-survivor'|'timeout'|'wipe'} reason
   */
  endRound(now, winnerId = null, reason = 'last-survivor') {
    if (this.round.state !== 'live') return;
    this.round.state = 'ended';
    this.round.reason = reason;
    this.round.nextRoundAt = now + INTERMISSION_MS;
    const winner = winnerId ? this.players.get(winnerId) : null;
    this.round.winner = winner
      ? { id: winner.id, name: winner.name, kills: winner.kills, hp: Math.max(0, Math.round(winner.hp)) }
      : null;
    this.pushEvent({
      k: 'round',
      phase: 'end',
      index: this.round.index,
      reason,
      winner: winner ? winner.name : null,
      winnerId: winner ? winner.id : null,
      kills: winner ? winner.kills : 0,
      hp: winner ? Math.max(0, Math.round(winner.hp)) : 0,
      draw: !winner,
    });
  }

  /** 생존자 중 HP가 가장 높은 사람(동점이면 킬 수) — 시간 종료 시 승자 결정 */
  pickHpLeader() {
    let best = null;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      if (!best) {
        best = player;
        continue;
      }
      if (player.hp > best.hp) best = player;
      else if (player.hp === best.hp && player.kills > best.kills) best = player;
    }
    return best;
  }

  updateRound(now) {
    if (this.round.state === 'live') {
      // 마지막 생존자 승리: 2명 이상으로 시작한 라운드에서 생존자가 1명(또는 0명)이 되면 종료.
      if (this.round.startedWith >= MIN_PLAYERS_TO_START && this.aliveCount <= 1) {
        let survivor = null;
        for (const player of this.players.values()) {
          if (player.alive) {
            survivor = player;
            break;
          }
        }
        this.endRound(now, survivor ? survivor.id : null, survivor ? 'last-survivor' : 'wipe');
        return;
      }
      // 시간 종료: 남은 생존자 중 HP 우세자 승리(전멸이면 무승부).
      if (now >= this.round.endsAt) {
        const leader = this.pickHpLeader();
        this.endRound(now, leader ? leader.id : null, 'timeout');
      }
      return;
    }

    if (this.round.state === 'ended' && this.round.nextRoundAt && now >= this.round.nextRoundAt) {
      this.round.nextRoundAt = 0;
      if (this.players.size >= MIN_PLAYERS_TO_START) this.startRound(now);
      else this.goWaiting(now);
      return;
    }

    if (this.round.state === 'waiting') this.tryStartRound(now);
  }

  // ── 틱 ──
  tick(now = Date.now()) {
    this.tickCount += 1;
    this.updateZone(now);

    for (const player of this.players.values()) {
      // 재장전 완료: 재장전을 시작한 무기와 현재 무기가 같을 때만 탄창을 채운다.
      if (player.reloadEnd && now >= player.reloadEnd) {
        const reloadedWeapon = player.reloadWeapon;
        player.reloadEnd = 0;
        player.reloadWeapon = 0;
        if (reloadedWeapon && reloadedWeapon === player.weapon) {
          this.finishReload(player);
          this.pushDirect(player.id, {
            t: 'reloaded',
            weapon: player.weapon,
            mag: player.mag[player.weapon],
            reserve: player.reserve[player.weapon],
          });
        }
      }

      // 배틀로얄: 라운드 중에는 절대 리스폰하지 않는다(라운드 종료 후 일괄 부활).
      // 존 밖 피해
      if (player.alive && this.round.state === 'live') {
        const dist = this.distanceToZoneCenter(player.x, player.z);
        if (dist > this.zone.radius) {
          if (now - player.lastZoneDamageAt >= 500) {
            player.lastZoneDamageAt = now;
            const dmg = (ZONE_DPS * 0.5);
            player.hp -= dmg;
            this.pushEvent({ k: 'zoneHit', id: player.id, hp: Math.max(0, Math.round(player.hp)) });
            if (player.hp <= 0) {
              player.hp = 0;
              player.alive = false;
              player.deaths += 1;
              player.respawnAt = 0;
              player.reloadEnd = 0;
              player.reloadWeapon = 0;
              this.pushEvent({
                k: 'kill',
                killer: null,
                killerId: null,
                victim: player.name,
                victimId: player.id,
                weapon: 'zone',
                headshot: false,
              });
            }
          }
        } else {
          player.lastZoneDamageAt = 0;
        }
      }
    }

    this.updateRound(now);
  }

  // ── 이벤트/스냅샷 ──
  pushEvent(event) {
    this.events.push(event);
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  pushDirect(id, message) {
    this.direct.push({ id, message });
    if (this.direct.length > 128) this.direct.splice(0, this.direct.length - 128);
  }

  drainEvents() {
    if (!this.events.length) return [];
    const events = this.events;
    this.events = [];
    return events;
  }

  drainDirect() {
    if (!this.direct.length) return [];
    const direct = this.direct;
    this.direct = [];
    return direct;
  }

  snapshot() {
    const now = Date.now();
    const players = [];
    for (const player of this.players.values()) {
      players.push([
        player.id,
        player.name,
        round2(player.x),
        0,
        round2(player.z),
        round3(player.yaw),
        round3(player.pitch),
        Math.round(player.hp),
        player.alive ? 1 : 0,
        player.weapon,
        player.mag[player.weapon] ?? 0,
        player.reserve[player.weapon] ?? 0,
        player.kills,
        player.deaths,
        player.spawnProtectUntil > now ? 1 : 0,
        player.reloadEnd > now ? Math.round(player.reloadEnd - now) : 0,
        player.kits,
      ]);
    }

    let ready = 0;
    for (const player of this.players.values()) if (player.ready) ready += 1;

    return {
      t: 's',
      tick: this.tickCount,
      now,
      players,
      alive: this.aliveCount,
      zone: {
        stage: this.zone.stage,
        radius: round2(this.zone.radius),
        centerX: this.zone.centerX,
        centerZ: this.zone.centerZ,
        shrinking: this.zone.shrinking,
        nextIn: Math.round(this.zone.nextIn),
      },
      round: {
        mode: 'br',
        index: this.round.index,
        state: this.round.state,
        reason: this.round.reason,
        timeLeft: this.round.state === 'live' ? Math.max(0, Math.round((this.round.endsAt - now) / 1000)) : 0,
        winner: this.round.winner ? this.round.winner.name : null,
        winnerId: this.round.winner ? this.round.winner.id : null,
        winnerKills: this.round.winner ? this.round.winner.kills : 0,
        winnerHp: this.round.winner ? this.round.winner.hp : 0,
        ready,
        total: this.players.size,
        alive: this.aliveCount,
        need: MIN_PLAYERS_TO_START,
        nextIn: this.round.state === 'ended' ? Math.max(0, Math.round((this.round.nextRoundAt - now) / 1000)) : 0,
      },
    };
  }
}

/** yaw/pitch(라디안) → 단위 방향 벡터. yaw 0은 -Z를 바라본다(Three.js 기본 카메라와 동일). */
function directionFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** 원뿔형 탄퍼짐 적용 */
function applySpread(dir, spread) {
  if (spread <= 0) return dir;
  const theta = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  // dir에 수직인 두 축
  const upX = 0;
  const upY = 1;
  const upZ = 0;
  let rightX = dir.y * upZ - dir.z * upY;
  let rightY = dir.z * upX - dir.x * upZ;
  let rightZ = dir.x * upY - dir.y * upX;
  const rightLen = Math.hypot(rightX, rightY, rightZ) || 1;
  rightX /= rightLen;
  rightY /= rightLen;
  rightZ /= rightLen;
  const up2X = rightY * dir.z - rightZ * dir.y;
  const up2Y = rightZ * dir.x - rightX * dir.z;
  const up2Z = rightX * dir.y - rightY * dir.x;
  const cosT = Math.cos(theta) * r;
  const sinT = Math.sin(theta) * r;
  const nx = dir.x + rightX * cosT + up2X * sinT;
  const ny = dir.y + rightY * cosT + up2Y * sinT;
  const nz = dir.z + rightZ * cosT + up2Z * sinT;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** 클라이언트에 내려줄 설정(무기표, 상수) */
function publicConfig() {
  const weapons = {};
  for (const key of WEAPON_ORDER) {
    const w = WEAPONS[key];
    weapons[key] = {
      id: w.id,
      key: w.key,
      name: w.name,
      damage: w.damage,
      fireDelay: w.fireDelay,
      mag: w.mag,
      reserve: w.reserve,
      reloadMs: w.reloadMs,
      auto: w.auto,
      pellets: w.pellets,
      range: w.range,
    };
  }
  return {
    tickRate: TICK_RATE,
    tickMs: TICK_MS,
    maxHp: MAX_HP,
    maxSpeed: 6.0,
    eyeHeight: EYE_HEIGHT,
    playerRadius: PLAYER_RADIUS,
    playerHeight: PLAYER_HEIGHT,
    respawnMs: 0, // 배틀로얄: 라운드 중 리스폰 없음
    spawnProtectMs: SPAWN_PROTECT_MS,
    roundMs: ROUND_MS,
    intermissionMs: INTERMISSION_MS,
    minPlayers: MIN_PLAYERS_TO_START,
    mode: 'br',
    healKits: HEAL_KITS,
    zonePhases: ZONE_PHASES,
    zoneDps: ZONE_DPS,
    arena: ARENA,
    weapons,
  };
}

module.exports = {
  Game,
  WEAPONS,
  WEAPON_ORDER,
  TICK_MS,
  TICK_RATE,
  MAX_SPEED,
  PLAYER_RADIUS,
  MAX_HP,
  ROUND_MS,
  INTERMISSION_MS,
  MIN_PLAYERS_TO_START,
  sanitizeName,
  publicConfig,
  directionFromAngles,
  resolveCollisions,
  rayAABB,
};
