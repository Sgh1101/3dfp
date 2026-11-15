/**
 * 절차적(Procedural) 효과음.
 *
 * 외부 오디오 파일 없이 Web Audio API만으로 사격/피격/재장전/발소리 등을 합성한다.
 * → 저장소에 음원 파일이 없어도 첫 클릭 순간부터 소리가 난다.
 */

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = true;

  function ensure() {
    if (!enabled) return null;
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      enabled = false;
      return null;
    }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    // 1초 화이트노이즈 버퍼(재사용)
    const length = Math.floor(ctx.sampleRate * 1);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

    return ctx;
  }

  function noise(duration, { gain = 0.3, type = 'lowpass', freq = 1200, q = 1, attack = 0.002, decay = duration } = {}) {
    const c = ensure();
    if (!c || !noiseBuffer) return;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = c.createGain();
    const now = c.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    src.connect(filter).connect(g).connect(master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  function tone(freq, duration, { gain = 0.2, type = 'sine', slideTo = null, delay = 0 } = {}) {
    const c = ensure();
    if (!c) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    const now = c.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g).connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  const api = {
    resume() {
      ensure();
    },

    setEnabled(value) {
      enabled = Boolean(value);
      if (master) master.gain.value = enabled ? 0.5 : 0;
    },

    /** 무기별 사격음 */
    shoot(weaponKey = 'rifle') {
      if (weaponKey === 'shotgun') {
        noise(0.28, { gain: 0.5, type: 'lowpass', freq: 900, q: 0.7 });
        tone(90, 0.22, { gain: 0.35, type: 'triangle', slideTo: 40 });
        return;
      }
      if (weaponKey === 'pistol') {
        noise(0.14, { gain: 0.36, type: 'bandpass', freq: 1800, q: 0.8 });
        tone(220, 0.1, { gain: 0.2, type: 'square', slideTo: 90 });
        return;
      }
      noise(0.1, { gain: 0.34, type: 'bandpass', freq: 1500, q: 0.9 });
      tone(180, 0.08, { gain: 0.16, type: 'square', slideTo: 80 });
    },

    hitmarker() {
      tone(1400, 0.05, { gain: 0.18, type: 'square' });
    },

    /** 머리 명중 — 일반 히트마커보다 높은 이중음 */
    headshot() {
      tone(1900, 0.045, { gain: 0.2, type: 'square' });
      tone(2400, 0.05, { gain: 0.14, type: 'square', delay: 0.045 });
    },

    /** 점프(발을 떼는 짧은 숨/발소리) */
    jump() {
      noise(0.07, { gain: 0.12, type: 'highpass', freq: 1400 });
      tone(320, 0.08, { gain: 0.07, type: 'triangle', slideTo: 480 });
    },

    /** 착지 — 낙하 속도에 따라 세진다 */
    land(speed = 6) {
      const g = Math.min(0.34, 0.1 + speed * 0.018);
      noise(0.13, { gain: g, type: 'lowpass', freq: 420 });
      tone(90, 0.12, { gain: g * 0.6, type: 'sine', slideTo: 55 });
    },

    /** 정조준 진입/해제 */
    adsIn() {
      noise(0.05, { gain: 0.09, type: 'bandpass', freq: 2200, q: 2 });
      tone(700, 0.05, { gain: 0.05, type: 'sine' });
    },

    adsOut() {
      noise(0.05, { gain: 0.07, type: 'bandpass', freq: 1600, q: 2 });
    },

    /** 보급 획득 */
    loot() {
      tone(660, 0.09, { gain: 0.13, type: 'triangle' });
      tone(880, 0.12, { gain: 0.13, type: 'triangle', delay: 0.08 });
    },

    /** 킬 확정 배너 */
    killConfirm(head = false) {
      tone(head ? 1200 : 980, 0.12, { gain: 0.16, type: 'triangle' });
      tone(head ? 1800 : 1320, 0.16, { gain: 0.13, type: 'triangle', delay: 0.1 });
    },

    kill() {
      tone(900, 0.08, { gain: 0.2, type: 'square' });
      tone(1350, 0.1, { gain: 0.18, type: 'square', delay: 0.07 });
    },

    hurt() {
      noise(0.2, { gain: 0.3, type: 'lowpass', freq: 700 });
      tone(160, 0.18, { gain: 0.2, type: 'sawtooth', slideTo: 70 });
    },

    reload() {
      noise(0.05, { gain: 0.22, type: 'highpass', freq: 2500 });
      noise(0.06, { gain: 0.2, type: 'highpass', freq: 1800 });
      // 탄창 교체 느낌의 두 번째 클릭
      setTimeout(() => noise(0.07, { gain: 0.24, type: 'bandpass', freq: 900, q: 1.5 }), 420);
    },

    reloaded() {
      noise(0.05, { gain: 0.18, type: 'highpass', freq: 3000 });
      tone(520, 0.06, { gain: 0.1, type: 'triangle' });
    },

    dry() {
      noise(0.04, { gain: 0.16, type: 'highpass', freq: 3000 });
    },

    heal() {
      tone(420, 0.16, { gain: 0.14, type: 'sine', slideTo: 720 });
    },

    footstep(runPhase = 0) {
      noise(0.09, { gain: 0.09, type: 'lowpass', freq: 520 + (runPhase % 2) * 120 });
    },

    zoneAlarm() {
      tone(660, 0.18, { gain: 0.12, type: 'triangle', slideTo: 520 });
    },

    uiClick() {
      tone(880, 0.05, { gain: 0.1, type: 'square' });
    },

    roundEnd(win = false) {
      if (win) {
        tone(523, 0.14, { gain: 0.2, type: 'triangle' });
        tone(659, 0.14, { gain: 0.2, type: 'triangle', delay: 0.12 });
        tone(784, 0.24, { gain: 0.22, type: 'triangle', delay: 0.24 });
      } else {
        tone(330, 0.2, { gain: 0.18, type: 'triangle' });
        tone(247, 0.3, { gain: 0.18, type: 'triangle', delay: 0.18 });
      }
    },
  };

  return api;
}
