'use strict';

/**
 * 서버 보호 한도(연결/방/레이트리밋/백프레셔).
 *
 * 폭주하는 클라이언트 하나가 서버 전체를 멈추게 하지 못하도록,
 * 게임 로직(`game.js`/`rooms.js`)과 웹소켓 계층(`index.js`)이 공유하는 값을 여기 한곳에 모은다.
 * 값은 환경 변수로 덮어쓸 수 있다(테스트에서 작은 값으로 한도를 검증한다).
 */

function readIntEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 동시에 열 수 있는 웹소켓 연결 수 상한 */
const MAX_TOTAL_CONNECTIONS = readIntEnv('MAX_TOTAL_CONNECTIONS', 128, 1, 100000);
/** 동시에 존재할 수 있는 방 수 상한(기본 공개방 포함) */
const MAX_ROOMS = readIntEnv('MAX_ROOMS', 32, 1, 10000);
/** 소켓 하나에 쌓아둘 수 있는 전송 버퍼 상한(바이트). 넘으면 스냅샷 방송을 건너뛴다. */
const MAX_BUFFERED_BYTES = readIntEnv('MAX_BUFFERED_BYTES', 256 * 1024, 1024, 64 * 1024 * 1024);
/** 버퍼가 계속 막혀 있는 동안 스냅샷을 건너뛴 횟수가 이 값을 넘으면 소켓을 끊는다(20Hz 기준 약 3초). */
const SLOW_SOCKET_STRIKES = readIntEnv('SLOW_SOCKET_STRIKES', 60, 1, 100000);
/** 참여(join) 시도: 10초에 5회 */
const JOIN_RATE = { max: readIntEnv('JOIN_RATE_MAX', 5, 1, 1000), windowMs: 10000 };
/** 핑: 1초에 5회 */
const PING_RATE = { max: readIntEnv('PING_RATE_MAX', 5, 1, 1000), windowMs: 1000 };

/** 기간당 호출 횟수 제한(토큰 버킷 대용 슬라이딩 윈도) */
class RateLimiter {
  constructor(max, windowMs = 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.windowStart = 0;
    this.count = 0;
  }

  allow(now, weight = 1) {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += weight;
    return this.count <= this.max;
  }

  get used() {
    return this.count;
  }
}

/**
 * 느린 소켓(수신측이 소화하지 못해 `ws.bufferedAmount`가 커진 소켓) 보호.
 *
 * - 버퍼가 한도 이하면 'ok' — 정상 전송.
 * - 한도를 넘으면 'skip' — 이번 스냅샷 틱은 건너뛴다(오래된 상태는 어차피 다음 틱으로 대체된다).
 * - 계속 막혀 strikes 번 연속으로 건너뛰면 'drop' — 그 소켓을 정리해 서버 메모리를 지킨다.
 */
class BackpressureGuard {
  constructor({ maxBuffered = MAX_BUFFERED_BYTES, strikes = SLOW_SOCKET_STRIKES } = {}) {
    this.maxBuffered = maxBuffered;
    this.strikes = strikes;
    this.skipped = 0;
  }

  /** @returns {'ok'|'skip'|'drop'} */
  check(ws) {
    const buffered = ws && typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
    if (buffered <= this.maxBuffered) {
      this.skipped = 0;
      return 'ok';
    }
    this.skipped += 1;
    if (this.skipped >= this.strikes) return 'drop';
    return 'skip';
  }

  reset() {
    this.skipped = 0;
  }
}

module.exports = {
  RateLimiter,
  BackpressureGuard,
  MAX_TOTAL_CONNECTIONS,
  MAX_ROOMS,
  MAX_BUFFERED_BYTES,
  SLOW_SOCKET_STRIKES,
  JOIN_RATE,
  PING_RATE,
};
