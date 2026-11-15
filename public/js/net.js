/**
 * WebSocket 클라이언트 래퍼.
 *
 * - JSON 패킷을 타입(t)별 핸들러로 전달한다.
 * - RTT(핑) 측정과 연결 종료 콜백을 제공한다.
 */

export class Net {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.pingSeq = 0;
    this.pendingPings = new Map();
    this.rtt = 0;
    this.pingTimer = null;
    this.closedByServer = false;
  }

  get connected() {
    return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
  }

  /** 이벤트 타입별 핸들러 등록 */
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[net] ${type} 핸들러 오류`, err);
      }
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.addEventListener('open', () => {
        settled = true;
        this.startPing();
        resolve();
      });

      this.ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;

        if (msg.t === 'pong') {
          const sentAt = this.pendingPings.get(msg.c);
          if (sentAt) {
            this.pendingPings.delete(msg.c);
            this.rtt = Math.round(performance.now() - sentAt);
          }
          return;
        }

        this.emit(msg.t, msg);
        this.emit('*', msg);
      });

      this.ws.addEventListener('close', (event) => {
        this.stopPing();
        this.emit('close', event);
        if (!settled) {
          settled = true;
          reject(new Error('연결에 실패했습니다.'));
        }
      });

      this.ws.addEventListener('error', () => {
        this.emit('error');
        if (!settled) {
          settled = true;
          reject(new Error('연결에 실패했습니다.'));
        }
      });
    });
  }

  send(message) {
    if (!this.connected) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.pingSeq = (this.pingSeq + 1) % 100000;
      this.pendingPings.set(this.pingSeq, performance.now());
      this.send({ t: 'ping', c: this.pingSeq });
      // 오래된 대기 항목 정리
      if (this.pendingPings.size > 8) {
        const oldest = this.pendingPings.keys().next().value;
        this.pendingPings.delete(oldest);
      }
    }, 2000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pendingPings.clear();
  }

  close() {
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 무시
      }
    }
  }
}

/** 현재 페이지와 같은 호스트로 WebSocket URL을 만든다. */
export function defaultSocketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}
