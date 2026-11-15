'use strict';

/**
 * AI 봇 두뇌(서버 권위).
 *
 * - 봇은 사람과 똑같은 player 객체다. 이동/사격/줍기 모두 사람과 같은 서버 핸들러
 *   (handleShoot / handleLoot / handleJump)를 거치므로 규칙(사거리·탄퍼짐·탄약·쿨다운)이 동일하다.
 * - 벽 너머 투시 금지: 사격 전에 커버 AABB로 시야선(LOS)을 검사하고, 안 보이면 쏘지 않는다.
 *   (설령 쏘더라도 서버 히트스캔이 벽을 먼저 맞히므로 관통 피해는 없다.)
 * - 자동 명중 치트 금지: 난이도별 조준 오차 + 반응 시간 + 사람과 같은 탄퍼짐을 쓴다.
 * - 자기장: 존 밖이면 안쪽으로 이동한다. 엄폐물·아이템·교전 거리를 판단해 웨이포인트를 고른다.
 */

const {
  rayAABB,
  resolveCollisions,
  supportAt,
  WEAPONS,
  PLAYER_RADIUS,
  EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
  BOT_DIFFICULTY,
  LOOT_RANGE,
} = require('./game');
const { COVERS } = require('./map');

const TICK_DT = 0.05;
const SIGHT_RANGE = 72;
const ENGAGE_RANGE = 26;
const LOOT_SEARCH_RANGE = 20;
const COVER_SEARCH_RANGE = 14;
const HEARING_RANGE = 62;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class BotDirector {
  constructor(game) {
    this.game = game;
  }

  update(now) {
    for (const bot of this.game.players.values()) {
      if (!bot.isBot || !bot.alive || !bot.ai) continue;
      try {
        this.think(bot, now);
      } catch (err) {
        // 봇 하나의 오류가 서버 틱을 멈추지 않게 한다.
        bot.ai = bot.ai || {};
        bot.ai.nextThinkAt = now + 500;
      }
    }
  }

  // ── 판단 ──────────────────────────────────────────────────────────────────
  think(bot, now) {
    const game = this.game;
    const ai = bot.ai;
    const cfg = BOT_DIFFICULTY[bot.botDifficulty] || BOT_DIFFICULTY.normal;

    // 200ms 주기로 "무엇을 할지"를 다시 판단한다(매 틱 전수 탐색을 피한다).
    if (now >= ai.nextThinkAt) {
      ai.nextThinkAt = now + 180 + Math.random() * 120;
      const target = this.pickTarget(bot, now);
      if (target) {
        if (target.id !== ai.targetId) {
          ai.targetId = target.id;
          ai.targetSince = now + cfg.reactionMs; // 반응 시간만큼 기다렸다 쏜다
        }
      } else {
        ai.targetId = null;
      }
      ai.target = target;
      this.planMovement(bot, target, now);
    }

    const target = this.currentTarget(bot, now);
    if (target) this.fight(bot, target, cfg, now);
    this.stepMovement(bot, cfg, now);
  }

  currentTarget(bot, now) {
    const ai = bot.ai;
    if (!ai.targetId) return null;
    const target = this.game.players.get(ai.targetId);
    if (!target || !target.alive) return null;
    const from = this.eyeOf(bot);
    const to = { x: target.x, y: target.y + this.chestHeight(target), z: target.z };
    if (Math.hypot(to.x - from.x, to.z - from.z) > SIGHT_RANGE) return null;
    if (!this.hasLineOfSight(from, to)) return null;
    return target;
  }

  /** 가장 가까운 시야 안의 적. 벽 뒤/스폰 보호 중인 적은 후보에서 뺀다. */
  pickTarget(bot, now) {
    const from = this.eyeOf(bot);
    let best = null;
    let bestDist = SIGHT_RANGE;
    for (const other of this.game.players.values()) {
      if (other.id === bot.id || !other.alive || other.spectator) continue;
      if (other.spawnProtectUntil > now) continue;
      const dist = Math.hypot(other.x - bot.x, other.z - bot.z);
      if (dist >= bestDist) continue;
      const to = { x: other.x, y: other.y + this.chestHeight(other), z: other.z };
      if (!this.hasLineOfSight(from, to)) continue;
      best = other;
      bestDist = dist;
    }
    return best;
  }

  planMovement(bot, target, now) {
    const ai = bot.ai;
    const game = this.game;
    const zone = game.zone;

    // 1) 자기장 밖(또는 경계 근처)이면 안쪽으로 — 최우선 생존 행동
    const distCenter = Math.hypot(bot.x - zone.centerX, bot.z - zone.centerZ);
    if (distCenter > zone.radius - 6) {
      ai.waypoint = this.zoneWaypoint(bot, zone);
      ai.intent = 'zone';
      return;
    }

    // 2) 적이 보이면 교전이 최우선(아이템 줍다 얻어맞지 않게)
    if (target) {
      const dist = Math.hypot(target.x - bot.x, target.z - bot.z);
      if (dist > ENGAGE_RANGE + 8) {
        ai.waypoint = this.zoneWaypoint({ x: target.x, z: target.z }, zone, 0.8);
        ai.intent = 'engage';
      } else if (ai.recentlyHit && now < (ai.cowerUntil || 0)) {
        ai.waypoint = this.findCover(bot, target, zone) || this.zoneWaypoint({ x: target.x, z: target.z }, zone, 0.8);
        ai.intent = 'cover';
      } else {
        // 가까이 붙지 않게 옆으로 돌며 사격(스트레이프)
        if (now > ai.strafeUntil) {
          ai.strafeDir = Math.random() < 0.5 ? -1 : 1;
          ai.strafeUntil = now + 900 + Math.random() * 900;
        }
        const dx = target.x - bot.x;
        const dz = target.z - bot.z;
        const d = Math.hypot(dx, dz) || 1;
        const keep = dist < 9 ? -1 : dist > 20 ? 1 : 0;
        const px = -dz / d;
        const pz = dx / d;
        ai.waypoint = this.zoneWaypoint(
          { x: bot.x + px * 6 * ai.strafeDir + (dx / d) * keep * 5, z: bot.z + pz * 6 * ai.strafeDir + (dz / d) * keep * 5 },
          zone,
          0.9,
        );
        ai.intent = 'strafe';
      }
      return;
    }

    // 3) 총소리(소음)를 들으면 그쪽으로 조사하러 간다 — 사람처럼 소리로 위치를 좁힌다.
    const noise = this.loudestNoise(bot, now);
    if (noise && now > (ai.waypointAt || 0)) {
      ai.waypoint = this.zoneWaypoint({ x: noise.x + (Math.random() * 6 - 3), z: noise.z + (Math.random() * 6 - 3) }, zone, 0.9);
      ai.intent = 'investigate';
      ai.waypointAt = now + 2500;
      return;
    }

    // 4) 살 만한 아이템이 가까이 있으면 줍으러 간다(무기 > 회복 > 탄약 순)
    const item = this.findItem(bot, now);
    if (item) {
      ai.waypoint = { x: item.x, z: item.z };
      ai.intent = 'loot';
      ai.lootId = item.id;
      return;
    }
    ai.lootId = 0;

    // 5) 적이 안 보이면: 자기장 안에서 순찰(존 가장자리로 몰리지 않게)
    if (!ai.waypoint || now > ai.patrolAt) {
      ai.patrolAt = now + 3500 + Math.random() * 2500;
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * Math.max(6, zone.radius * 0.62);
      ai.waypoint = this.zoneWaypoint({ x: zone.centerX + Math.cos(angle) * r, z: zone.centerZ + Math.sin(angle) * r }, zone, 0.85);
      ai.intent = 'patrol';
    }
  }

  /** 최근 4초 안의 가장 가까운 총소리(자기 위치 기준, 들리는 거리 안) */
  loudestNoise(bot, now) {
    const noises = this.game.noise || [];
    let best = null;
    let bestDist = HEARING_RANGE;
    for (const noise of noises) {
      if (now - noise.t > 4000) continue;
      const dist = Math.hypot(noise.x - bot.x, noise.z - bot.z);
      if (dist < bestDist) {
        best = noise;
        bestDist = dist;
      }
    }
    return best;
  }

  fight(bot, target, cfg, now) {
    const ai = bot.ai;
    if (now < ai.targetSince) return; // 아직 반응 시간이 지나지 않았다
    const dist = Math.hypot(target.x - bot.x, target.z - bot.z);
    const weapon = WEAPONS[bot.weapon];
    if (!weapon) return;
    if ((bot.mag[bot.weapon] ?? 0) <= 0) {
      if (now > (ai.reloadAt || 0)) {
        this.game.handleReload(bot.id);
        ai.reloadAt = now + weapon.reloadMs + 400;
      }
      return;
    }
    if (dist > weapon.range) return;

    const eye = this.eyeOf(bot);
    const aimY = target.y + this.chestHeight(target);
    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const horiz = Math.hypot(dx, dz) || 1;
    // 조준 오차: 난이도 + 거리 + 움직임. 사람과 같은 탄퍼짐도 서버에서 추가로 적용된다.
    const err = cfg.aimError * (1 + horiz / 45) * (bot.sprint ? 1.5 : 1);
    const yaw = Math.atan2(-dx, -dz) + (Math.random() * 2 - 1) * err;
    const pitch = Math.atan2(aimY - eye.y, horiz) + (Math.random() * 2 - 1) * err * 0.55;
    this.game.handleShoot(bot.id, { yaw, pitch, ads: horiz < 26 });
    if (now > (ai.shootPauseAt || 0)) ai.shootPauseAt = now + cfg.shootPauseMs;
  }

  // ── 이동 ──────────────────────────────────────────────────────────────────
  stepMovement(bot, cfg, now) {
    const ai = bot.ai;
    const speed = 6.0 * cfg.speed;
    if (!ai.waypoint) return;
    const dx = ai.waypoint.x - bot.x;
    const dz = ai.waypoint.z - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) {
      ai.arrivedAt = now;
      ai.waypoint = null;
      ai.patrolAt = 0;
      return;
    }
    const stepLen = Math.min(dist, speed * TICK_DT);
    const nx = bot.x + (dx / dist) * stepLen;
    const nz = bot.z + (dz / dist) * stepLen;
    const resolved = resolveCollisions(nx, nz, PLAYER_RADIUS, bot.y);
    const moved = Math.hypot(resolved.x - bot.x, resolved.z - bot.z);
    bot.x = resolved.x;
    bot.z = resolved.z;

    // 이동 중 걸리면: 낮은 엄폐물이면 점프로 넘고, 아니면 다른 방향으로 돈다.
    if (moved < stepLen * 0.35) {
      ai.stuck += TICK_DT;
      if (ai.stuck > 0.35 && now > (ai.jumpAt || 0) && bot.grounded) {
        this.game.handleJump(bot.id);
        ai.jumpAt = now + 700;
      }
      if (ai.stuck > 0.9) {
        const angle = Math.atan2(-dz, -dx) + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
        ai.waypoint = this.zoneWaypoint({ x: bot.x + Math.cos(angle) * 8, z: bot.z + Math.sin(angle) * 8 }, this.game.zone, 0.9);
        ai.stuck = 0;
      }
    } else {
      ai.stuck = 0;
    }

    // 아이템 위에 도착했으면 줍는다(서버가 범위/효과를 다시 판정).
    if (ai.intent === 'loot') {
      const item = this.game.items.find((it) => it.id === ai.lootId);
      if (item && Math.hypot(item.x - bot.x, item.z - bot.z) <= LOOT_RANGE && item.readyAt <= now) {
        this.game.handleLoot(bot.id);
        ai.lootId = 0;
        ai.waypoint = null;
        ai.patrolAt = 0;
      }
    }
  }

  // ── 보조 ──────────────────────────────────────────────────────────────────
  eyeOf(bot) {
    return { x: bot.x, y: bot.y + (bot.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT), z: bot.z };
  }

  chestHeight(target) {
    return target.crouch ? 0.75 : 1.15;
  }

  /** 벽(커버)에 가려져 있는지. 커버의 실제 높이를 쓰므로 낮은 엄폐물 뒤는 가려지지 않는다. */
  hasLineOfSight(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return true;
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    for (const cover of COVERS) {
      const t = rayAABB(
        from.x, from.y, from.z,
        nx, ny, nz,
        cover.minX, cover.minY, cover.minZ,
        cover.maxX, cover.maxY, cover.maxZ,
        dist - 0.25,
      );
      if (t !== null) return false;
    }
    return true;
  }

  /** 목표 지점을 자기장 안쪽으로 당긴 좌표(존 밖으로는 이동하지 않는다). */
  zoneWaypoint(point, zone, factor = 0.9) {
    const dx = point.x - zone.centerX;
    const dz = point.z - zone.centerZ;
    const dist = Math.hypot(dx, dz);
    const limit = Math.max(2, zone.radius * factor);
    if (dist <= limit) return { x: point.x, z: point.z };
    return { x: zone.centerX + (dx / dist) * limit, z: zone.centerZ + (dz / dist) * limit };
  }

  /** 지금 주우러 갈 만한 아이템을 고른다(무기 > 구급상자 > 힐 키트 > 탄약). */
  findItem(bot, now) {
    let best = null;
    let bestScore = Infinity;
    for (const item of this.game.items) {
      if (item.readyAt > now) continue;
      const dist = Math.hypot(item.x - bot.x, item.z - bot.z);
      if (dist > LOOT_SEARCH_RANGE) continue;
      let priority;
      if (item.kind === 'weapon') {
        if (bot.owned[item.weapon]) continue;
        priority = 0;
      } else if (item.kind === 'medkit') {
        if (bot.hp > 62) continue;
        priority = 1;
      } else if (item.kind === 'kit') {
        if (bot.kits >= 2) continue;
        priority = 2;
      } else if (item.kind === 'ammo') {
        const weapon = WEAPONS[bot.weapon];
        const max = weapon ? weapon.reserve : 150;
        if ((bot.reserve[bot.weapon] ?? 0) > max * 0.45) continue;
        priority = 3;
      } else {
        continue;
      }
      const score = priority * 100 + dist;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 위협 반대편으로 숨을 수 있는 가까운 엄폐물 뒤 좌표 */
  findCover(bot, threat, zone) {
    let best = null;
    let bestDist = COVER_SEARCH_RANGE;
    for (const cover of COVERS) {
      const cx = cover.x;
      const cz = cover.z;
      const dist = Math.hypot(cx - bot.x, cz - bot.z);
      if (dist > bestDist) continue;
      const dx = cx - threat.x;
      const dz = cz - threat.z;
      const d = Math.hypot(dx, dz) || 1;
      const behind = {
        x: cx + (dx / d) * (Math.max(cover.maxX - cover.minX, cover.maxZ - cover.minZ) / 2 + 1.1),
        z: cz + (dz / d) * (Math.max(cover.maxX - cover.minX, cover.maxZ - cover.minZ) / 2 + 1.1),
      };
      if (Math.abs(behind.x) > 76 || Math.abs(behind.z) > 76) continue;
      best = this.zoneWaypoint(behind, zone, 0.95);
      bestDist = dist;
    }
    return best;
  }
}

module.exports = { BotDirector, SIGHT_RANGE, ENGAGE_RANGE, TICK_DT, clamp, supportAt };
