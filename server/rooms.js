'use strict';

/**
 * 방 관리.
 *
 * - 기본 공개방(코드 LOBBY0) 1개는 항상 존재하고, 6자리 코드로 새 방을 만들거나 참여할 수 있다.
 * - 방 정원은 8명. 초과 시 에러 코드/메시지를 돌려준다.
 * - 클라이언트에게는 사람이 읽는 message를, 코드로 분기하려는 쪽은 code를 쓰면 된다.
 */

const { Game } = require('./game');

const MAX_PLAYERS_PER_ROOM = 8;
const DEFAULT_ROOM_CODE = 'LOBBY0';
const CODE_LENGTH = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 I, O, 0, 1 제외
const EMPTY_ROOM_TTL_MS = 60000;

const ERROR = Object.freeze({
  ROOM_NOT_FOUND: { code: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없음' },
  ROOM_FULL: { code: 'ROOM_FULL', message: '정원 초과' },
  BAD_REQUEST: { code: 'BAD_REQUEST', message: '잘못된 요청' },
  ALREADY_IN_ROOM: { code: 'ALREADY_IN_ROOM', message: '이미 방에 참여 중' },
});

class Room {
  constructor(code, isDefault = false) {
    this.code = code;
    this.isDefault = Boolean(isDefault);
    this.createdAt = Date.now();
    this.game = new Game(code, isDefault);
    this.emptySince = null;
  }

  get playerCount() {
    return this.game.playerCount;
  }

  get isFull() {
    return this.game.playerCount >= MAX_PLAYERS_PER_ROOM;
  }
}

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.defaultRoom = new Room(DEFAULT_ROOM_CODE, true);
    this.rooms.set(DEFAULT_ROOM_CODE, this.defaultRoom);
  }

  normalizeCode(raw) {
    if (typeof raw !== 'string') return null;
    const code = raw.trim().toUpperCase();
    if (!code) return null;
    return code;
  }

  /** 6자리 고유 코드 생성 */
  generateCode() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // 실패 시 타임스탬프 기반 폴백
    return `R${Date.now().toString(36).toUpperCase().slice(-5)}`.slice(0, CODE_LENGTH);
  }

  createRoom() {
    const code = this.generateCode();
    const room = new Room(code, false);
    this.rooms.set(code, room);
    return room;
  }

  getDefaultRoom() {
    return this.defaultRoom;
  }

  findRoom(rawCode) {
    const code = this.normalizeCode(rawCode);
    if (!code) return null;
    return this.rooms.get(code) || null;
  }

  /**
   * 참여 요청 처리.
   * @param {{code?: string, roomCode?: string, create?: boolean, name?: string}} request
   * @param {string} playerId
   * @param {string} name
   * @returns {{room?: Room, error?: {code: string, message: string}}}
   */
  join(request, playerId, name) {
    const wantsCreate = Boolean(request && request.create);
    let room;

    if (wantsCreate) {
      room = this.createRoom();
    } else {
      const rawCode = request && (request.code ?? request.roomCode);
      const code = this.normalizeCode(rawCode);
      if (!code) {
        room = this.defaultRoom;
      } else {
        room = this.rooms.get(code);
        if (!room) return { error: ERROR.ROOM_NOT_FOUND };
      }
    }

    if (room.isFull) return { error: ERROR.ROOM_FULL };

    room.game.addPlayer(playerId, name);
    room.emptySince = null;
    return { room };
  }

  /** 틱 루프에서 호출: 접속자가 있는 방만 갱신하고, 빈 방은 정리한다. */
  tick(now = Date.now()) {
    const active = [];
    for (const room of this.rooms.values()) {
      if (room.playerCount === 0) {
        // 빈 방에 쌓인 이벤트는 버린다(다음 참가자에게 과거 이벤트가 가지 않도록).
        room.game.drainEvents();
        room.game.drainDirect();
        if (room.isDefault) continue;
        if (room.emptySince === null) room.emptySince = now;
        if (now - room.emptySince > EMPTY_ROOM_TTL_MS) this.rooms.delete(room.code);
        continue;
      }
      room.emptySince = null;
      room.game.tick(now);
      active.push(room);
    }
    return active;
  }
}

module.exports = {
  RoomManager,
  Room,
  ERROR,
  MAX_PLAYERS_PER_ROOM,
  DEFAULT_ROOM_CODE,
  CODE_LENGTH,
};
