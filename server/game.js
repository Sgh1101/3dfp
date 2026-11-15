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

// ── 수직 물리(점프) ─────────────────────────────────────────────────────────
// 서버가 y/vy 를 소유한다. 클라이언트는 같은 상수로 예측만 하고, 어긋나면 보정 패킷을 받는다.
const GRAVITY = 20; // m/s²
const JUMP_VY = 9.0; // 점프 초속 → 최고 높이 약 1.9m, 체공 약 0.9초(1.6~1.8m 상자 위로 올라설 수 있다)
const MAX_FALL_SPEED = 42;
const JUMP_COOLDOWN_MS = 320;
const STEP_UP_TOLERANCE = 0.32; // 이만큼 아래의 발판은 올라설 수 있다(착지 판정 여유)
const MAX_Y = 14; // 아레나 벽(6m)보다 높이 올라가지 못하게 하는 안전 상한

// ── 자세(앉기) ─────────────────────────────────────────────────────────────
const CROUCH_HEIGHT = 1.22;
const CROUCH_EYE_HEIGHT = 1.02;
const CROUCH_SPEED_MULT = 0.55;
const SPRINT_SPEED_MULT = 1.28;
const ADS_SPEED_MULT = 0.72;

// ── 머리 판정 ──────────────────────────────────────────────────────────────
const HEAD_RADIUS = 0.26;
const HEAD_HEIGHT = 0.42;
const HEADSHOT_MULT = 2;

// ── 보급 아이템(서버 권위 스폰) ──────────────────────────────────────────────
// 종류: ammo(탄약) | kit(힐 키트) | medkit(구급상자, 즉시 회복) | weapon(무기 획득)
const LOOT_RANGE = 2.8;
const LOOT_RESPAWN_MS = 25000;
const LOOT_AMMO_FRACTION = 0.5;
const LOOT_MAX_KITS = 4;
const MEDKIT_HEAL = 50;
const LOOT_ITEM_DEFS = [
  { id: 1, kind: 'ammo', x: 0, z: -26 },
  { id: 2, kind: 'kit', x: 14, z: 0 },
  { id: 3, kind: 'weapon', weapon: 3, x: -14, z: 0 },
  { id: 4, kind: 'weapon', weapon: 3, x: 30, z: -30 },
  { id: 5, kind: 'ammo', x: -30, z: 30 },
  { id: 6, kind: 'medkit', x: 50, z: 0 },
  { id: 7, kind: 'kit', x: -50, z: 0 },
  { id: 8, kind: 'weapon', weapon: 3, x: 0, z: 50 },
  { id: 9, kind: 'medkit', x: 0, z: -50 },
  { id: 10, kind: 'ammo', x: 44, z: 44 },
  { id: 11, kind: 'kit', x: -44, z: -44 },
  { id: 12, kind: 'medkit', x: -22, z: 22 },
];

/** 기본 지급 무기(샷건은 맵에서 습득해야 한다). */
const DEFAULT_OWNED = { 1: true, 2: true, 3: false };

/** AI 봇 난이도: 반사 신경(첫 사격까지 지연)과 조준 오차로 조절한다. */
const BOT_DIFFICULTY = {
  easy: { label: '쉬움', reactionMs: 640, aimError: 0.07, speed: 0.78, shootPauseMs: 420 },
  normal: { label: '보통', reactionMs: 380, aimError: 0.036, speed: 0.9, shootPauseMs: 200 },
  hard: { label: '어려움', reactionMs: 180, aimError: 0.015, speed: 1, shootPauseMs: 60 },
};
const BOT_NAMES = ['알파', '베타', '감마', '델타', '엡실론', '제타', '에타', '세타'];
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
    adsFov: 58,
    recoilPitch: 0.0075,
    recoilYaw: 0.0026,
    bloom: 6,
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
    adsFov: 64,
    recoilPitch: 0.013,
    recoilYaw: 0.002,
    bloom: 4,
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
    adsFov: 68,
    recoilPitch: 0.03,
    recoilYaw: 0.006,
    bloom: 14,
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

function resolveCollisions(x, z, radius, feetY = 0) {
  let px = x;
  let pz = z;
  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (const box of COVERS) {
      // 발이 상자 윗면보다 높으면 그 상자 '위'에 서 있는 것이므로 측면 충돌을 적용하지 않는다.
      if (feetY >= box.maxY - 0.05) continue;
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

/**
 * (x,z)에서 발 아래의 지지 높이(서 있을 수 있는 바닥면)를 구한다.
 * 바닥은 0m, 커버 위에 올라서 있으면 그 커버의 높이가 된다.
 * @param {number} prevY 이번 틱 이동 '전' 발 높이 — 낙하 중 상자 위를 통과하지 않도록 이전 높이로 판정한다.
 */
function supportAt(x, z, prevY, radius = PLAYER_RADIUS) {
  let support = 0;
  for (const box of COVERS) {
    if (box.maxY > prevY + STEP_UP_TOLERANCE) continue;
    const margin = radius * 0.5;
    if (x < box.minX - margin || x > box.maxX + margin) continue;
    if (z < box.minZ - margin || z > box.maxZ + margin) continue;
    if (box.maxY > support) support = box.maxY;
  }
  return support;
}

/** 무기 탄퍼짐 배율: 정조준·앉기는 정확, 점프 중·달리기는 부정확. */
function spreadMultiplier(player) {
  let m = 1;
  if (player.ads) m *= 0.42;
  if (player.crouch && player.grounded) m *= 0.7;
  if (!player.grounded) m *= 2.1;
  if (player.sprint) m *= 1.5;
  return m;
}

/** 발 높이를 반영한 눈 높이 */
function eyeOffset(player) {
  if (player.crouch) return CROUCH_EYE_HEIGHT;
  return EYE_HEIGHT;
}

/** 앉은 자세의 피격 박스 높이(머리 포함) */
function bodyHeight(player) {
  return player.crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT;
}

// ── Game ────────────────────────────────────────────────────────────────────
class Game {
  constructor(code, isDefault = false, botOptions = null, maxPlayers = 8) {
    this.code = code;
    this.isDefault = Boolean(isDefault);
    this.maxPlayers = Math.max(2, Number(maxPlayers) || 8);
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.tickCount = 0;
    /** 방송용 이벤트 큐 */
    this.events = [];
    /** 특정 클라이언트에게만 보낼 메시지 큐 */
    this.direct = [];
    /** 총소리 위치 기록(AI가 소리를 듣고 조사하러 간다) */
    this.noise = [];
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

    /** 보급 아이템 상태(위치는 LOOT_ITEM_DEFS, readyAt 이 지나야 다시 거둘 수 있다) */
    this.items = LOOT_ITEM_DEFS.map((def) => ({ ...def, readyAt: 0 }));

    /** AI 봇 정책(방을 만든 사람의 선택) */
    this.botPolicy = {
      count: clamp(Number(botOptions && botOptions.count) || 0, 0, this.maxPlayers - 1),
      fill: Boolean(botOptions && botOptions.fill),
      difficulty: BOT_DIFFICULTY[botOptions && botOptions.difficulty] ? botOptions.difficulty : 'normal',
    };
    this.botSeq = 0;
    /** server/bots.js 가 주입한다(순환 require 방지) */
    this.botBrain = null;

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

  get humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n += 1;
    return n;
  }

  get botCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot) n += 1;
    return n;
  }

  addPlayer(id, name, { isBot = false } = {}) {
    const now = Date.now();
    // 정원은 사람+AI 합산. 사람이 들어올 자리가 없으면 봇을 먼저 내보낸다(사람 우선).
    if (!isBot && this.players.size >= this.maxPlayers && this.botCount > 0) this.removeBots(this.players.size - this.maxPlayers + 1);
    const spawn = this.pickSpawn(id);
    const player = {
      id,
      name: sanitizeName(name),
      isBot,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      vy: 0,
      grounded: true,
      jumpBlockedUntil: 0,
      crouch: false,
      sprint: false,
      ads: false,
      /** 서버가 판정하는 보유 무기(샷건은 맵에서 습득해야 true) */
      owned: { ...DEFAULT_OWNED },
      /** 봇 두뇌 상태(server/bots.js가 채운다) */
      ai: null,
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
    this.pushEvent({ k: 'join', id, name: player.name, bot: isBot || undefined });
    // 봇은 사람이 들어오면 사람 자리를 비켜 준다.
    if (!isBot) this.syncBots(now);
    // 혼자서는 라운드가 시작되지 않고, 두 번째 플레이어가 들어오면 바로 배틀로얄을 시작한다.
    if (this.round.state === 'waiting') this.tryStartRound(now);
    return player;
  }

  /** 봇 추가(서버 전용). 정원(사람+AI)을 넘기지 않는다. */
  addBot(difficulty = this.botPolicy.difficulty) {
    if (this.players.size >= this.maxPlayers) return null;
    this.botSeq += 1;
    const label = BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length];
    const id = `bot-${this.botSeq}`;
    const bot = this.addPlayer(id, `봇 ${label}`, { isBot: true });
    bot.botDifficulty = BOT_DIFFICULTY[difficulty] ? difficulty : 'normal';
    bot.ai = { nextThinkAt: 0, targetId: null, targetSince: 0, waypoint: null, strafeUntil: 0, strafeDir: 1, stuck: 0, lastX: bot.x, lastZ: bot.z, jumpAt: 0, lootId: 0, patrolAt: 0 };
    return bot;
  }

  removeBots(count = Infinity) {
    let removed = 0;
    for (const player of [...this.players.values()]) {
      if (removed >= count) break;
      if (!player.isBot) continue;
      this.players.delete(player.id);
      this.pushEvent({ k: 'leave', id: player.id, name: player.name });
      removed += 1;
    }
    return removed;
  }

  /**
   * 봇 인원을 정책에 맞춘다.
   * - fill: 사람이 몇 명이든 정원까지 봇으로 채운다.
   * - count: 고정 봇 수(정원을 넘지 않게).
   * - 사람이 0명이 되면 봇을 모두 내보낸다(빈 방 정리).
   */
  syncBots(now = Date.now()) {
    const humans = this.humanCount;
    if (humans === 0) {
      this.removeBots();
      return;
    }
    let target = this.botPolicy.fill ? this.maxPlayers - humans : this.botPolicy.count;
    target = clamp(target, 0, Math.max(0, this.maxPlayers - humans));
    let current = this.botCount;
    while (current > target) {
      const bot = [...this.players.values()].find((p) => p.isBot);
      if (!bot) break;
      this.players.delete(bot.id);
      this.pushEvent({ k: 'leave', id: bot.id, name: bot.name });
      current -= 1;
    }
    while (current < target) {
      if (!this.addBot()) break;
      current += 1;
    }
    if (this.round.state === 'waiting') this.tryStartRound(now);
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return null;
    this.players.delete(id);
    this.lastActivityAt = Date.now();
    this.pushEvent({ k: 'leave', id, name: player.name });
    if (!player.isBot) this.syncBots();
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
    player.vy = 0;
    player.grounded = true;
    player.jumpBlockedUntil = 0;
    player.crouch = false;
    player.sprint = false;
    player.ads = false;
    player.yaw = spawn.yaw || 0;
    player.pitch = 0;
    player.hp = MAX_HP;
    player.alive = true;
    player.weapon = 1;
    if (player.ai) {
      player.ai.targetId = null;
      player.ai.targetSince = 0;
      player.ai.waypoint = null;
      player.ai.lootId = 0;
      player.ai.stuck = 0;
      player.ai.lastX = player.x;
      player.ai.lastZ = player.z;
      player.ai.nextThinkAt = now + Math.random() * 300;
    }
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
  /**
   * 수직 물리 한 틱(서버 권위): 중력 → 낙하 → 바닥/엄폐물 윗면 착지.
   * 착지·점프는 이벤트로 방송해 클라이언트가 효과음/카메라 반동을 낼 수 있게 한다.
   */
  stepVertical(player, dt, now) {
    if (!player.alive) {
      player.y = 0;
      player.vy = 0;
      player.grounded = true;
      return;
    }
    const prevY = player.y;
    const wasGrounded = player.grounded;
    player.vy -= GRAVITY * dt;
    if (player.vy < -MAX_FALL_SPEED) player.vy = -MAX_FALL_SPEED;
    let nextY = prevY + player.vy * dt;
    const support = supportAt(player.x, player.z, prevY, PLAYER_RADIUS);
    if (nextY <= support && player.vy <= 0) {
      nextY = support;
      if (!wasGrounded && prevY - support > 0.15) {
        this.pushEvent({ k: 'land', id: player.id, speed: round2(Math.abs(player.vy)) });
      }
      player.vy = 0;
      player.grounded = true;
    } else {
      player.grounded = false;
    }
    if (nextY > MAX_Y) {
      nextY = MAX_Y;
      if (player.vy > 0) player.vy = 0;
    }
    player.y = nextY;
    if (player.y > 0.02) player.lastGroundAt = now;
  }

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

    // 자세/달리기/정조준 상태(탄퍼짐·속도·눈높이에 쓰인다)
    player.crouch = Boolean(msg.crouch);
    player.sprint = Boolean(msg.sprint) && !player.crouch && !player.ads;
    if (typeof msg.ads === 'boolean') player.ads = msg.ads;

    // 속도 검증: 한 틱에 이동 가능한 거리를 넘으면 되돌린다(스피드핵 롤백).
    // 달리기는 더 빠른 속도를 허용하고, 앉기/정조준은 느려지기만 하므로 기본 상한으로 충분하다.
    const dt = clamp((now - player.lastMoveAt) / 1000, 0.01, 0.35);
    const speedCap = MAX_SPEED * (player.sprint ? SPRINT_SPEED_MULT : 1);
    const maxDist = speedCap * dt + SPEED_GRACE;
    const dx = x - player.x;
    const dz = z - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) {
      const scale = maxDist / dist;
      player.x += dx * scale;
      player.z += dz * scale;
      player.violations += 1;
      this.pushDirect(player.id, { t: 'corr', x: round2(player.x), y: round2(player.y), z: round2(player.z) });
    } else {
      player.x = x;
      player.z = z;
    }

    // 수직 위치는 서버가 소유한다. 클라이언트 예측이 크게 어긋났을 때만 되돌린다.
    const clientY = Number(msg.y);
    if (Number.isFinite(clientY) && Math.abs(clientY - player.y) > 1.1) {
      this.pushDirect(player.id, { t: 'corr', x: round2(player.x), y: round2(player.y), z: round2(player.z) });
    }

    const resolved = resolveCollisions(player.x, player.z, PLAYER_RADIUS, player.y);
    if (Math.hypot(resolved.x - player.x, resolved.z - player.z) > 0.001) {
      player.x = resolved.x;
      player.z = resolved.z;
      this.pushDirect(player.id, { t: 'corr', x: round2(player.x), y: round2(player.y), z: round2(player.z) });
    }
    player.lastMoveAt = now;

    if (player.violations > MAX_VIOLATIONS) {
      this.pushDirect(player.id, { t: 'kick', message: '비정상적인 이동이 감지되어 연결을 종료합니다.' });
    }
  }

  /** 점프: 지상일 때만 수직 속도를 준다(서버 권위). */
  handleJump(id) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    const now = Date.now();
    if (!player.rate.action.allow(now)) return;
    if (now < player.jumpBlockedUntil) return;
    if (!player.grounded) return;
    player.vy = JUMP_VY;
    player.grounded = false;
    player.jumpBlockedUntil = now + JUMP_COOLDOWN_MS;
    this.pushEvent({ k: 'jump', id, x: round2(player.x), z: round2(player.z) });
  }

  /**
   * 보급 아이템 줍기(서버 권위). 범위 안 + 아직 사라지지 않은 아이템만 지급한다.
   * 효과(무기 획득·탄약 보충·체력 회복)는 모두 서버가 계산하며, 쓸 수 없는 상황이면
   * 아이템을 소모하지 않고 조용히 넘기다(자동 줍기 반복에도 이득이 없다).
   */
  handleLoot(id) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    const now = Date.now();
    if (!player.rate.action.allow(now)) return;
    let best = null;
    let bestDist = LOOT_RANGE;
    for (const item of this.items) {
      if (item.readyAt > now) continue;
      const dist = Math.hypot(player.x - item.x, player.z - item.z);
      if (dist <= bestDist) {
        best = item;
        bestDist = dist;
      }
    }
    if (!best) {
      this.pushDirect(player.id, { t: 'toast', text: '가까이에 주울 아이템이 없습니다.' });
      return;
    }

    let text = '';
    if (best.kind === 'weapon') {
      const weaponId = best.weapon;
      const weapon = WEAPONS[weaponId];
      if (!weapon) return;
      const firstTime = !player.owned[weaponId];
      if (!firstTime && player.mag[weaponId] >= weapon.mag && player.reserve[weaponId] >= weapon.reserve) {
        return; // 이미 가득 획득한 무기
      }
      player.owned[weaponId] = true;
      player.mag[weaponId] = weapon.mag;
      player.reserve[weaponId] = weapon.reserve;
      if (firstTime) {
        this.cancelReload(player);
        player.weapon = weaponId;
        text = `${weapon.name} 획득`;
      } else {
        text = `${weapon.name} 탄약 보충`;
      }
    } else if (best.kind === 'ammo') {
      let gained = 0;
      for (const key of WEAPON_ORDER) {
        if (!player.owned[key]) continue;
        const max = WEAPONS[key].reserve;
        if (player.reserve[key] >= max) continue;
        const add = Math.max(6, Math.round(max * LOOT_AMMO_FRACTION));
        const before = player.reserve[key];
        player.reserve[key] = Math.min(max, before + add);
        gained += player.reserve[key] - before;
      }
      if (gained <= 0) return;
      text = `탄약 +${gained}`;
    } else if (best.kind === 'kit') {
      if (player.kits >= LOOT_MAX_KITS) return;
      player.kits += 1;
      text = '힐 키트 +1';
    } else if (best.kind === 'medkit') {
      if (player.hp >= MAX_HP) return;
      const healed = Math.min(MAX_HP - player.hp, MEDKIT_HEAL);
      player.hp += healed;
      text = `구급상자 — HP +${Math.round(healed)}`;
    } else {
      return;
    }

    best.readyAt = now + LOOT_RESPAWN_MS;
    this.pushEvent({ k: 'loot', id: best.id, by: player.id, name: player.name, kind: best.kind });
    this.pushDirect(player.id, {
      t: 'looted',
      itemId: best.id,
      kind: best.kind,
      text: `보급 획득 — ${text}`,
      kits: player.kits,
      hp: Math.round(player.hp),
      weapon: player.weapon,
      owned: { ...player.owned },
      mag: player.mag[player.weapon],
      reserve: { 1: player.reserve[1], 2: player.reserve[2], 3: player.reserve[3] },
    });
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
    if (msg && typeof msg.ads === 'boolean') player.ads = msg.ads;

    if (player.mag[player.weapon] <= 0) {
      this.pushDirect(player.id, { t: 'dry' });
      return;
    }

    player.mag[player.weapon] -= 1;
    player.spawnProtectUntil = 0; // 사격하면 스폰 보호 해제

    const origin = {
      x: player.x,
      y: player.y + eyeOffset(player),
      z: player.z,
    };
    const baseDir = directionFromAngles(player.yaw, player.pitch);
    const start = { x: origin.x + baseDir.x * 0.4, y: origin.y, z: origin.z + baseDir.z * 0.4 };

    // 정조준·앉기는 명중률 상승, 점프 중·달리기는 하락(서버가 계산).
    const spread = weapon.spread * spreadMultiplier(player);

    let anyHit = false;
    let anyHead = false;
    const impacts = [];

    for (let pellet = 0; pellet < weapon.pellets; pellet += 1) {
      const dir = pellet === 0 && weapon.pellets === 1 ? baseDir : applySpread(baseDir, spread);
      const hit = this.traceShot(player, start, dir, weapon.range);
      impacts.push({
        x: round2(start.x + dir.x * hit.dist),
        y: round2(start.y + dir.y * hit.dist),
        z: round2(start.z + dir.z * hit.dist),
      });
      if (hit.playerId && hit.playerId !== player.id) {
        anyHit = true;
        if (hit.headshot) anyHead = true;
        this.applyDamage(player, hit.playerId, weapon.damage, weapon.key, now, hit.headshot);
      }
    }

    // 총소리는 AI가 듣는다(가까운 봇이 조사하러 온다). 최근 8발만 유지.
    this.noise.push({ x: round2(player.x), z: round2(player.z), t: now, by: player.id });
    if (this.noise.length > 8) this.noise.splice(0, this.noise.length - 8);

    this.pushEvent({
      k: 'shot',
      id: player.id,
      w: player.weapon,
      from: [round2(start.x), round2(start.y), round2(start.z)],
      to: [impacts[0].x, impacts[0].y, impacts[0].z],
      impacts,
      hit: anyHit,
      head: anyHead,
      ammo: player.mag[player.weapon],
    });
  }

  /**
   * 히트스캔: 커버(벽)를 먼저 검사하고, 그보다 가까운 플레이어만 맞은 것으로 판정한다.
   * 플레이어 판정은 **지금 이 순간의 발 높이(y)** 를 쓰므로 점프·앉기·엄폐물 위 사격이 그대로 반영된다.
   * 머리(마지막 0.42m)에 맞으면 headshot=true.
   */
  traceShot(shooter, origin, dir, maxDist) {
    let bestDist = maxDist;
    let hitPlayerId = null;
    let headshot = false;
    const now = Date.now();

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
      if (other.spawnProtectUntil > now) continue;
      const height = bodyHeight(other);
      const top = other.y + height;
      const headBottom = Math.max(other.y, top - HEAD_HEIGHT);
      const tBody = rayAABB(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        other.x - PLAYER_RADIUS, other.y, other.z - PLAYER_RADIUS,
        other.x + PLAYER_RADIUS, headBottom, other.z + PLAYER_RADIUS,
        bestDist,
      );
      const tHead = rayAABB(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        other.x - HEAD_RADIUS, headBottom, other.z - HEAD_RADIUS,
        other.x + HEAD_RADIUS, top, other.z + HEAD_RADIUS,
        bestDist,
      );
      let t = null;
      let hitIsHead = false;
      if (tBody !== null) t = tBody;
      if (tHead !== null && (t === null || tHead < t)) {
        t = tHead;
        hitIsHead = true;
      }
      if (t !== null && t < bestDist) {
        // 몸통과 머리를 겹치지 않는 볼륨으로 검사하고, 실제 가장 가까운 볼륨으로 판정한다.
        headshot = hitIsHead;
        bestDist = t;
        hitPlayerId = other.id;
      }
    }

    return { dist: bestDist, playerId: hitPlayerId, headshot };
  }

  applyDamage(attacker, targetId, damage, weaponKey, now, headshot = false) {
    const target = this.players.get(targetId);
    if (!target || !target.alive) return;
    if (target.spawnProtectUntil > now) return;

    if (target.ai) {
      // 봇은 맞으면 엄폐로 피한다(사람처럼 반응).
      target.ai.recentlyHit = true;
      target.ai.cowerUntil = now + 900 + Math.random() * 700;
    }

    const mul = headshot ? HEADSHOT_MULT : 1;
    const dealt = Math.min(target.hp, damage * mul);
    target.hp -= dealt;

    this.pushEvent({
      k: 'hit',
      by: attacker ? attacker.id : null,
      id: targetId,
      dmg: Math.round(dealt),
      hp: Math.max(0, Math.round(target.hp)),
      head: headshot ? 1 : 0,
    });

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.deaths += 1;
      target.respawnAt = 0; // 배틀로얄: 라운드 중 리스폰 없음(라운드 종료 후 일괄 부활)
      target.reloadEnd = 0;
      target.reloadWeapon = 0;
      target.ready = false;
      target.y = 0;
      target.vy = 0;
      target.grounded = true;
      if (attacker && attacker.id !== target.id) attacker.kills += 1;
      this.pushEvent({
        k: 'kill',
        killer: attacker ? attacker.name : null,
        killerId: attacker ? attacker.id : null,
        victim: target.name,
        victimId: target.id,
        weapon: weaponKey,
        headshot,
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
      // 보유하지 않은 무기로는 바꿀 수 없다(클라이언트 임의 무기 획득 차단 — 서버가 판정).
      if (!player.owned[requested]) {
        this.pushDirect(player.id, { t: 'noWeapon', weapon: requested });
        return;
      }
      next = requested;
    } else {
      // 다음 보유 무기로 순환(샷건을 줍기 전에는 1↔2만)。
      const idx = WEAPON_ORDER.indexOf(player.weapon);
      for (let step = 1; step <= WEAPON_ORDER.length; step += 1) {
        const candidate = WEAPON_ORDER[(idx + step) % WEAPON_ORDER.length];
        if (player.owned[candidate]) {
          next = candidate;
          break;
        }
      }
    }
    if (!next || next === player.weapon) return;
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
    for (const item of this.items) item.readyAt = 0;
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
      // 수직 물리(점프·중력·착지) — 재장전 처리보다 먼저 돈다.
      this.stepVertical(player, TICK_MS / 1000, now);

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

    // AI 봇 판단/이동/사격(서버 권위). 사람 입력과 같은 핸들러를 쓴다.
    if (this.botBrain) this.botBrain.update(now);
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
        round2(player.y),
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
        // 17: 상태 플래그 비트(1 정조준, 2 앉기, 4 지상, 8 달리기, 16 AI 봇)
        (player.ads ? 1 : 0) | (player.crouch ? 2 : 0) | (player.grounded ? 4 : 0) | (player.sprint ? 8 : 0) | (player.isBot ? 16 : 0),
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
      // 보급 아이템 상태: [id, 지금 주울 수 있으면 1]
      items: this.items.map((item) => [item.id, item.readyAt > now ? 0 : 1]),
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
        humans: this.humanCount,
        bots: this.botCount,
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
      adsFov: w.adsFov,
      recoilPitch: w.recoilPitch,
      recoilYaw: w.recoilYaw,
      bloom: w.bloom,
    };
  }
  return {
    tickRate: TICK_RATE,
    tickMs: TICK_MS,
    maxHp: MAX_HP,
    maxSpeed: 6.0,
    eyeHeight: EYE_HEIGHT,
    crouchEyeHeight: CROUCH_EYE_HEIGHT,
    crouchHeight: CROUCH_HEIGHT,
    playerRadius: PLAYER_RADIUS,
    playerHeight: PLAYER_HEIGHT,
    // 점프·자세 물리(클라이언트 예측과 서버 시뮬레이션이 같은 값을 쓴다)
    gravity: GRAVITY,
    jumpVelocity: JUMP_VY,
    jumpCooldownMs: JUMP_COOLDOWN_MS,
    sprintMultiplier: SPRINT_SPEED_MULT,
    crouchMultiplier: CROUCH_SPEED_MULT,
    adsMultiplier: ADS_SPEED_MULT,
    adsSensitivity: 0.55,
    baseFov: 78,
    headshotMultiplier: HEADSHOT_MULT,
    loot: LOOT_ITEM_DEFS.map((item) => ({ id: item.id, x: item.x, z: item.z, kind: item.kind, weapon: item.weapon })),
    lootRange: LOOT_RANGE,
    lootRespawnMs: LOOT_RESPAWN_MS,
    lootMaxKits: LOOT_MAX_KITS,
    medkitHeal: MEDKIT_HEAL,
    ownedAtStart: { ...DEFAULT_OWNED },
    bots: {
      maxPerRoom: 7,
      difficulties: Object.keys(BOT_DIFFICULTY).map((key) => ({ key, label: BOT_DIFFICULTY[key].label })),
      defaultDifficulty: 'normal',
    },
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
  PLAYER_HEIGHT,
  EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
  CROUCH_HEIGHT,
  GRAVITY,
  JUMP_VY,
  JUMP_COOLDOWN_MS,
  HEADSHOT_MULT,
  LOOT_ITEM_DEFS,
  LOOT_RANGE,
  LOOT_RESPAWN_MS,
  DEFAULT_OWNED,
  BOT_DIFFICULTY,
  MAX_HP,
  ROUND_MS,
  INTERMISSION_MS,
  MIN_PLAYERS_TO_START,
  sanitizeName,
  publicConfig,
  directionFromAngles,
  resolveCollisions,
  supportAt,
  spreadMultiplier,
  rayAABB,
};
