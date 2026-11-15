'use strict';

/**
 * 3dfp 아레나 맵 데이터.
 *
 * 서버와 클라이언트가 같은 기하 구조를 쓰도록, 커버 오브젝트 정의는 이 파일 하나에만 둔다.
 * 클라이언트는 `/api/map`(또는 접속 직후 welcome 패킷의 map)으로 이 데이터를 받아 그대로 렌더링한다.
 * 커버는 모두 축 정렬 박스(AABB)이며, 서버의 히트스캔 판정과 이동 충돌이 이 정의를 사용한다.
 */

const ARENA = Object.freeze({
  size: 160, // 160m x 160m (-80 ~ +80)
  half: 80,
  wallHeight: 6, // 외곽 벽 높이
  wallThickness: 2,
});

/**
 * 커버 정의(중심 좌표 기준).
 * mirror가 false가 아니면 x, z의 부호를 뒤집어 4개 사분면에 대칭으로 배치한다.
 * type: crate(나무 상자) | container(컨테이너) | wall(콘크리트 벽) | barrier(낮은 방벽) | pillar(기둥) | block(중앙 구조물)
 */
const COVER_DEFS = [
  // 중앙 구조물
  { type: 'block', x: 0, z: 0, w: 10, d: 10, h: 2.6 },
  { type: 'crate', x: 7.4, z: 7.4, w: 1.6, d: 1.6, h: 1.6 },
  { type: 'barrier', x: 0, z: 20, w: 16, d: 1.2, h: 1.2 },
  { type: 'barrier', x: 20, z: 0, w: 1.2, d: 16, h: 1.2 },

  // 사분면 대칭 구조물
  { type: 'container', x: 38, z: 30, w: 14, d: 7, h: 3.2 },
  { type: 'container', x: 30, z: 38, w: 7, d: 14, h: 3.2 },
  { type: 'wall', x: 22, z: 54, w: 3, d: 14, h: 2.2 },
  { type: 'wall', x: 54, z: 22, w: 14, d: 3, h: 2.2 },
  { type: 'wall', x: 12, z: 40, w: 3, d: 18, h: 2.2 },
  { type: 'barrier', x: 46, z: 12, w: 12, d: 1.2, h: 1.3 },
  { type: 'pillar', x: 16, z: 26, w: 2, d: 2, h: 3.6 },
  { type: 'crate', x: 52, z: 36, w: 1.9, d: 1.9, h: 1.9 },
  { type: 'crate', x: 54.4, z: 36, w: 1.9, d: 1.9, h: 1.9 },
  { type: 'crate', x: 52, z: 38.6, w: 1.9, d: 1.9, h: 1.9 },
  { type: 'crate', x: 26, z: 16, w: 1.8, d: 1.8, h: 1.8 },
  { type: 'crate', x: 66, z: 56, w: 2.4, d: 2.4, h: 2.4 },
  { type: 'crate', x: 60, z: 62, w: 2.4, d: 2.4, h: 2.4 },
];

/** 부호 대칭으로 커버 목록을 펼친다. */
function expandDefs(defs) {
  const out = [];
  const seen = new Set();
  for (const def of defs) {
    const xs = def.x === 0 ? [0] : [def.x, -def.x];
    const zs = def.z === 0 ? [0] : [def.z, -def.z];
    for (const x of xs) {
      for (const z of zs) {
        const key = `${def.type}:${x}:${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: def.type, x, z, w: def.w, d: def.d, h: def.h });
      }
    }
  }
  return out;
}

/** 중심 좌표 정의 -> min/max AABB를 포함한 커버 오브젝트 */
const COVERS = expandDefs(COVER_DEFS).map((def, index) => {
  const halfW = def.w / 2;
  const halfD = def.d / 2;
  return {
    id: index + 1,
    type: def.type,
    x: def.x,
    z: def.z,
    w: def.w,
    d: def.d,
    h: def.h,
    minX: def.x - halfW,
    maxX: def.x + halfW,
    minZ: def.z - halfD,
    maxZ: def.z + halfD,
    minY: 0,
    maxY: def.h,
  };
});

/**
 * 8개 스폰 지점: 반지름 60m 링에 45도 간격.
 * 링 각도에 오프셋을 두어 스폰이 커버(벽·컨테이너) 코앞에 붙지 않도록 한다.
 * (오프셋 0일 때는 모든 스폰이 2.2m 벽에서 0.2m 거리라 시야가 벽으로 막혔다.)
 */
const SPAWN_RADIUS = 60;
const SPAWN_ANGLE_OFFSET = Math.PI / 8 + (22 * Math.PI) / 180;
const SPAWNS = [];
for (let i = 0; i < 8; i += 1) {
  const angle = (Math.PI * 2 * i) / 8 + SPAWN_ANGLE_OFFSET;
  SPAWNS.push({
    x: Math.cos(angle) * SPAWN_RADIUS,
    z: Math.sin(angle) * SPAWN_RADIUS,
    // 아레나 중심(0,0)을 바라보는 yaw. 전방 벡터는 (-sin(yaw), -cos(yaw)).
    yaw: Math.atan2(Math.cos(angle), Math.sin(angle)),
  });
}

/** 스폰 지점이 커버와 겹치면 바깥으로 밀어낸다(맵 수정 시 안전장치). */
function clearSpawn(spawn, radius) {
  let { x, z } = spawn;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let pushed = false;
    for (const c of COVERS) {
      const cx = Math.max(c.minX, Math.min(x, c.maxX));
      const cz = Math.max(c.minZ, Math.min(z, c.maxZ));
      const dx = x - cx;
      const dz = z - cz;
      const dist = Math.hypot(dx, dz);
      if (dist < radius) {
        if (dist > 1e-6) {
          x += (dx / dist) * (radius - dist);
          z += (dz / dist) * (radius - dist);
        } else {
          x += radius;
        }
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  const limit = ARENA.half - radius - ARENA.wallThickness;
  return {
    x: Math.max(-limit, Math.min(limit, x)),
    z: Math.max(-limit, Math.min(limit, z)),
    yaw: spawn.yaw,
  };
}

for (let i = 0; i < SPAWNS.length; i += 1) {
  SPAWNS[i] = clearSpawn(SPAWNS[i], 2.5);
}

/** 클라이언트로 보낼 맵 페이로드(중심 좌표 + 크기). */
function mapPayload() {
  return {
    arena: ARENA,
    covers: COVERS.map((c) => ({ id: c.id, type: c.type, x: c.x, z: c.z, w: c.w, d: c.d, h: c.h })),
    spawns: SPAWNS.map((s) => ({ x: s.x, z: s.z })),
  };
}

module.exports = {
  ARENA,
  COVERS,
  SPAWNS,
  mapPayload,
};
