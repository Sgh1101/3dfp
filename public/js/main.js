import * as THREE from 'three';
import { Net, defaultSocketUrl } from './net.js';
import { createAudio } from './audio.js';

/* ─────────────────────────────────────────────────────────────
   3DFP 클라이언트
   - 서버 권위: 이동은 예측 + 서버 보정, 사격/피해/존은 서버 판정
   - 원격 플레이어는 90ms 지연 보간(Lerp)으로 부드럽게 표시
   - PC: PointerLock + WASD / 모바일: 조이스틱 + 드래그 시점
   ───────────────────────────────────────────────────────────── */

const audio = createAudio();
const net = new Net(defaultSocketUrl());
const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const dom = {
  canvas: document.getElementById('game'),
  hud: document.getElementById('hud'),
  menu: document.getElementById('menu'),
  menuError: document.getElementById('menu-error'),
  menuLoading: document.getElementById('menu-loading'),
  menuLoadingText: document.getElementById('menu-loading-text'),
  nameInput: document.getElementById('name-input'),
  codeInput: document.getElementById('code-input'),
  btnJoin: document.getElementById('btn-join'),
  btnQuick: document.getElementById('btn-quick'),
  btnCreate: document.getElementById('btn-create'),
  btnAi: document.getElementById('btn-ai'),
  botCount: document.getElementById('bot-count'),
  botDifficulty: document.getElementById('bot-difficulty'),
  botFill: document.getElementById('bot-fill'),
  autoPickup: document.getElementById('auto-pickup'),
  pause: document.getElementById('pause'),
  pauseTitle: document.getElementById('pause-title'),
  pauseText: document.getElementById('pause-text'),
  pauseHint: document.getElementById('pause-hint'),
  btnResume: document.getElementById('btn-resume'),
  zoneWarning: document.getElementById('zone-warning'),
  result: document.getElementById('result'),
  resultTitle: document.getElementById('result-title'),
  resultDetail: document.getElementById('result-detail'),
  resultCountdown: document.getElementById('result-countdown'),
  btnReady: document.getElementById('btn-ready'),
  dead: document.getElementById('dead'),
  deadTitle: document.getElementById('dead-title'),
  deadTimer: document.getElementById('dead-timer'),
  deadHint: document.getElementById('dead-hint'),
  waitBanner: document.getElementById('wait-banner'),
  waitCount: document.getElementById('wait-count'),
  disconnected: document.getElementById('disconnected'),
  disconnectedReason: document.getElementById('disconnected-reason'),
  btnReconnect: document.getElementById('btn-reconnect'),
  zoneBox: document.querySelector('.zone-box'),
  zoneLabel: document.getElementById('zone-label'),
  zoneTimer: document.getElementById('zone-timer'),
  roundTime: document.getElementById('round-time'),
  roundKills: document.getElementById('round-kills'),
  aliveCount: document.getElementById('alive-count'),
  roomCode: document.getElementById('room-code'),
  killfeed: document.getElementById('killfeed'),
  crosshair: document.getElementById('crosshair'),
  hitmarker: document.getElementById('hitmarker'),
  hpFill: document.getElementById('hp-fill'),
  hpValue: document.getElementById('hp-value'),
  kits: document.getElementById('kits'),
  weaponName: document.getElementById('weapon-name'),
  ammoMag: document.getElementById('ammo-mag'),
  ammoReserve: document.getElementById('ammo-reserve'),
  weaponSlots: document.getElementById('weapon-slots'),
  reloadHint: document.getElementById('reload-hint'),
  damageVignette: document.getElementById('damage-vignette'),
  ping: document.getElementById('ping'),
  touchControls: document.getElementById('touch-controls'),
  joystick: document.getElementById('joystick'),
  joystickKnob: document.getElementById('joystick-knob'),
  btnFire: document.getElementById('btn-fire'),
  btnReload: document.getElementById('btn-reload'),
  btnSwap: document.getElementById('btn-swap'),
  btnHeal: document.getElementById('btn-heal'),
  btnJump: document.getElementById('btn-jump'),
  btnAim: document.getElementById('btn-aim'),
  btnCrouch: document.getElementById('btn-crouch'),
  btnLoot: document.getElementById('btn-loot'),
  compass: document.getElementById('compass'),
  minimap: document.getElementById('minimap'),
  adsOverlay: document.getElementById('ads-overlay'),
  toast: document.getElementById('toast'),
  killBanner: document.getElementById('kill-banner'),
  killBannerText: document.getElementById('kill-banner-text'),
  damageNumbers: document.getElementById('damage-numbers'),
  soundToggle: document.getElementById('sound-toggle'),
  lootHint: document.getElementById('loot-hint'),
  stanceBadge: document.getElementById('stance-badge'),
};

const VIEW_DELAY_MS = 90; // 원격 플레이어 보간 지연
const MOUSE_SENSITIVITY = 0.0022;
const TOUCH_SENSITIVITY = 1.7;
/** PointerLock 요청 후 이 시간 안에 잠기지 않으면 드래그 시점 모드로 전환한다. */
const LOCK_TIMEOUT_MS = 900;
const PITCH_LIMIT = 1.45;
const MAX_FALL_SPEED = 42;

const state = {
  phase: 'menu', // menu | connecting | playing
  map: null,
  config: null,
  myId: null,
  roomCode: '',
  avatars: new Map(),
  me: {
    x: 0,
    y: 0,
    z: 0,
    vy: 0,
    grounded: true,
    yaw: 0,
    pitch: 0,
    hp: 100,
    alive: true,
    weapon: 1,
    mag: 0,
    reserve: 0,
    kills: 0,
    deaths: 0,
    kits: 2,
    spawnProtect: false,
    reloadMs: 0,
    /** 앉기/달리기/정조준 상태(서버에 같이 보내 탄퍼짐·속도·피격 박스에 반영) */
    crouch: false,
    sprint: false,
    ads: false,
    /** 현재 보간된 눈높이·화각 */
    eye: 1.62,
    fov: 78,
  },
  zone: null,
  round: null,
  aliveCount: 1,
  suppressPauseUntil: 0,
  resultShown: false,
  myName: '',
  needSnap: true,
  /** 이 브라우저에서 PointerLock을 쓸 수 없을 때(드래그 시점 대체 모드) */
  lockUnavailable: false,
  /** PointerLock 없이 마우스 드래그로 시점을 돌리는 중 */
  lookDrag: false,
  /** 나를 탈락시킨 상대(탈락 오버레이 표시용) */
  myKiller: null,
  lastDryAt: 0,
  keys: new Set(),
  touchMove: { x: 0, y: 0, active: false },
  look: { pointerId: null, lastX: 0, lastY: 0 },
  firing: false,
  nextShotAt: 0,
  reloadEndAt: 0,
  lastStepAt: 0,
  ignoreMoves: 0,
  hudWarnAt: 0,
  /** 마우스를 누른 채 끄는 시점 회전(PointerLock 없이도 동작) */
  dragLook: false,
  dragLastX: 0,
  dragLastY: 0,
  lockTimer: 0,
  /** 보급 상자 상태/힌트 */
  loot: [],
  lootOpen: false,
  /** 시점/카메라 연출 */
  bobT: 0,
  viewKick: 0,
  landDip: 0,
  /** 마지막으로 계산한 이동 속도 비율 */
  speedRatio: 0,
  muted: false,
  lastLootAt: 0,
  lastHitAt: 0,
  /** 이번 판 최근 킬 배너 타이머 */
  killBannerTimer: 0,
  /** 정조준 토글/홀드, 모바일 앉기 */
  adsToggle: false,
  adsHold: false,
  touchCrouch: false,
  /** 자동 줍기 옵션 */
  autoPickup: true,
  /** 보급 아이템 준비 상태(id → true/false) */
  items: new Map(),
  lootMeshes: null,
  /** 조준선 별어짐(px) */
  bloom: 4,
  /** 이번 프레임 이동 여부(걸음/봅) */
  movingNow: false,
  lastMinimapAt: 0,
};

/* ── Three.js 기본 ─────────────────────────────────────────── */
let renderer;
let scene;
let camera;
let zoneWall;
let zoneEdge;
let viewmodel;
let muzzleFlash;
let muzzleLight;
const tracers = [];
const impacts = [];

try {
  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
} catch (err) {
  console.error('[3dfp] WebGL 초기화 실패', err);
  dom.menuError.textContent = '이 브라우저에서 WebGL을 사용할 수 없습니다.';
  dom.menuError.classList.remove('hidden');
  window.showBootError?.('이 브라우저에서 WebGL을 사용할 수 없어 3D 화면을 열 수 없습니다.');
}

if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !isTouch;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1017);
  scene.fog = new THREE.Fog(0x0a1017, 70, 200);

  camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 400);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xa8d8ff, 0x1c2b26, 1.3);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xfff0d4, 1.5);
  dir.position.set(45, 80, 30);
  dir.castShadow = !isTouch;
  if (!isTouch) {
    dir.shadow.mapSize.set(2048, 2048);
    const d = 90;
    dir.shadow.camera.left = -d;
    dir.shadow.camera.right = d;
    dir.shadow.camera.top = d;
    dir.shadow.camera.bottom = -d;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 240;
    dir.shadow.bias = -0.0006;
  }
  scene.add(dir);

  const ambient = new THREE.AmbientLight(0x25333c, 0.7);
  scene.add(ambient);
}

/* ── 맵 로드 & 월드 구성 ───────────────────────────────────── */
const COVER_COLORS = {
  crate: 0x8a5a2b,
  container: 0x2f6c78,
  wall: 0x5c666f,
  barrier: 0xb08b2a,
  pillar: 0x707a84,
  block: 0x49545f,
};

async function loadMap() {
  const res = await fetch('/api/map', { cache: 'no-store' });
  if (!res.ok) throw new Error('맵을 불러오지 못했습니다.');
  return res.json();
}

function makeGroundTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1c2732';
  ctx.fillRect(0, 0, size, size);

  const tile = 64;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const shade = 0.02 + Math.random() * 0.06;
      ctx.fillStyle = `rgba(255,255,255,${shade.toFixed(3)})`;
      ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
    }
  }
  ctx.strokeStyle = 'rgba(80, 200, 170, 0.22)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= size; i += tile) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWorld(map) {
  const arena = map.arena;

  // 바닥
  const groundGeo = new THREE.PlaneGeometry(arena.size, arena.size);
  const groundMat = new THREE.MeshStandardMaterial({
    map: makeGroundTexture(),
    roughness: 0.95,
    metalness: 0.05,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = !isTouch;
  scene.add(ground);

  // 아레나 외곽 표시(경계선)
  const lineGeo = new THREE.RingGeometry(arena.half - 0.4, arena.half, 4, 1);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const border = new THREE.Mesh(lineGeo, lineMat);
  border.rotation.x = -Math.PI / 2;
  border.rotation.z = Math.PI / 4;
  border.position.y = 0.02;
  scene.add(border);

  // 외곽 벽
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3540, roughness: 0.85, metalness: 0.15 });
  const wallH = arena.wallHeight;
  const wallT = arena.wallThickness;
  const side = arena.size + wallT;
  const walls = [
    { w: side, d: wallT, x: 0, z: -(arena.half + wallT / 2) },
    { w: side, d: wallT, x: 0, z: arena.half + wallT / 2 },
    { w: wallT, d: side, x: -(arena.half + wallT / 2), z: 0 },
    { w: wallT, d: side, x: arena.half + wallT / 2, z: 0 },
  ];
  for (const spec of walls) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, wallH, spec.d), wallMat);
    mesh.position.set(spec.x, wallH / 2, spec.z);
    mesh.castShadow = !isTouch;
    mesh.receiveShadow = !isTouch;
    scene.add(mesh);
    addEdges(mesh, 0x4a5b68);
  }

  // 커버 오브젝트
  for (const cover of map.covers) {
    const color = COVER_COLORS[cover.type] ?? 0x6b7280;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: cover.type === 'container' ? 0.55 : 0.8,
      metalness: cover.type === 'container' ? 0.45 : 0.1,
    });
    const geo = new THREE.BoxGeometry(cover.w, cover.h, cover.d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cover.x, cover.h / 2, cover.z);
    mesh.castShadow = !isTouch;
    mesh.receiveShadow = !isTouch;
    scene.add(mesh);
    addEdges(mesh, 0x0b1218, 0.25);
  }

  // 존(축소되는 안전 구역)
  const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true);
  const wallMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  zoneWall = new THREE.Mesh(wallGeo, wallMaterial);
  zoneWall.position.y = 15;
  zoneWall.scale.set(arena.half, 30, arena.half);
  scene.add(zoneWall);

  const edgeGeo = new THREE.RingGeometry(0.965, 1.0, 128);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  zoneEdge = new THREE.Mesh(edgeGeo, edgeMat);
  zoneEdge.rotation.x = -Math.PI / 2;
  zoneEdge.position.y = 0.06;
  zoneEdge.scale.set(arena.half, arena.half, 1);
  scene.add(zoneEdge);
}

function addEdges(mesh, color, opacity = 0.6) {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  edges.position.copy(mesh.position);
  edges.rotation.copy(mesh.rotation);
  scene.add(edges);
}

/* ── 무기 뷰모델 ───────────────────────────────────────────── */
function buildViewmodel(weaponId) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.45, metalness: 0.65 });
  const body = new THREE.MeshStandardMaterial({ color: 0x2f3944, roughness: 0.55, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x34d399, roughness: 0.4, metalness: 0.3 });

  const add = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  let muzzleZ = -0.9;

  if (weaponId === 2) {
    // 권총
    add(new THREE.BoxGeometry(0.07, 0.09, 0.34), body, 0, 0, -0.18);
    add(new THREE.BoxGeometry(0.06, 0.16, 0.1), dark, 0, -0.11, 0.02);
    add(new THREE.BoxGeometry(0.02, 0.02, 0.12), dark, 0, 0.03, -0.34);
    add(new THREE.BoxGeometry(0.065, 0.02, 0.05), accent, 0, -0.05, -0.05);
    muzzleZ = -0.42;
  } else if (weaponId === 3) {
    // 샷건
    add(new THREE.BoxGeometry(0.1, 0.11, 0.62), body, 0, 0, -0.28);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.62, 10).rotateX(Math.PI / 2), dark, 0.032, 0.03, -0.6);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.62, 10).rotateX(Math.PI / 2), dark, -0.032, 0.03, -0.6);
    add(new THREE.BoxGeometry(0.085, 0.13, 0.16), dark, 0, -0.06, 0.18);
    add(new THREE.BoxGeometry(0.07, 0.025, 0.2), accent, 0, -0.1, -0.2);
    muzzleZ = -0.92;
  } else {
    // 라이플
    add(new THREE.BoxGeometry(0.09, 0.12, 0.68), body, 0, 0, -0.26);
    add(new THREE.CylinderGeometry(0.022, 0.022, 0.46, 10).rotateX(Math.PI / 2), dark, 0, 0.02, -0.75);
    add(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark, 0, -0.12, -0.06);
    add(new THREE.BoxGeometry(0.08, 0.1, 0.2), dark, 0, -0.02, 0.2);
    add(new THREE.BoxGeometry(0.02, 0.02, 0.22), accent, 0.05, 0.04, -0.36);
    add(new THREE.BoxGeometry(0.03, 0.03, 0.06), dark, 0, 0.08, -0.2);
    muzzleZ = -0.99;
  }

  // 손(간단한 표현)
  const hand = new THREE.MeshStandardMaterial({ color: 0xc38b62, roughness: 0.9 });
  add(new THREE.BoxGeometry(0.06, 0.09, 0.12), hand, -0.02, -0.11, 0.03);
  add(new THREE.BoxGeometry(0.06, 0.08, 0.14), hand, 0, -0.07, -0.42);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, muzzleZ);
  group.add(muzzle);

  group.position.set(0.26, -0.24, -0.42);
  group.rotation.set(0, 0.02, 0);
  group.renderOrder = 10;

  return { group, muzzle };
}

function setViewmodel(weaponId) {
  if (!camera) return;
  // 총구 이펙트는 뷰모델 교체와 무관하게 재사용한다.
  if (muzzleFlash && muzzleFlash.parent) muzzleFlash.parent.remove(muzzleFlash);
  if (muzzleLight && muzzleLight.parent) muzzleLight.parent.remove(muzzleLight);

  if (viewmodel) {
    camera.remove(viewmodel.group);
    viewmodel.group.traverse((obj) => {
      if (obj === muzzleFlash || obj === muzzleLight) return;
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && obj.material !== muzzleFlash?.material) obj.material.dispose?.();
    });
  }
  viewmodel = buildViewmodel(weaponId);
  camera.add(viewmodel.group);

  if (muzzleFlash) viewmodel.muzzle.add(muzzleFlash);
  if (muzzleLight) viewmodel.muzzle.add(muzzleLight);
}

function initMuzzleEffects() {
  const geo = new THREE.SphereGeometry(0.075, 8, 8);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe9a8,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  muzzleFlash = new THREE.Mesh(geo, mat);
  muzzleFlash.visible = false;

  muzzleLight = new THREE.PointLight(0xffd27f, 0, 6, 2);
  muzzleLight.position.set(0, 0, 0);
}

function flashMuzzle() {
  if (!muzzleFlash) return;
  muzzleFlash.visible = true;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  const s = 0.8 + Math.random() * 0.7;
  muzzleFlash.scale.set(s, s, s);
  if (muzzleLight) muzzleLight.intensity = 2.4;
  window.setTimeout(() => {
    if (muzzleFlash) muzzleFlash.visible = false;
    if (muzzleLight) muzzleLight.intensity = 0;
  }, 55);
  if (viewmodel) {
    viewmodel.group.position.z = -0.38; // 반동
    window.setTimeout(() => {
      if (viewmodel) viewmodel.group.position.z = -0.42;
    }, 70);
  }
}

/* ── 트레이서 / 임팩트 ─────────────────────────────────────── */
function spawnTracer(from, to, mine) {
  if (!scene) return;
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from[0], from[1], from[2]),
    new THREE.Vector3(to[0], to[1], to[2]),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: mine ? 0xfff2c0 : 0xffc46b,
    transparent: true,
    opacity: 0.85,
  });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  tracers.push({ line, born: performance.now() });
}

function spawnImpact(point, color = 0xffd27f) {
  if (!scene) return;
  const geo = new THREE.SphereGeometry(0.07, 6, 6);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(point[0], point[1], point[2]);
  scene.add(mesh);
  impacts.push({ mesh, born: performance.now() });
}

function updateEffects(now) {
  for (let i = tracers.length - 1; i >= 0; i -= 1) {
    const t = tracers[i];
    const age = now - t.born;
    if (age > 140) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      tracers.splice(i, 1);
    } else {
      t.line.material.opacity = 0.85 * (1 - age / 140);
    }
  }
  for (let i = impacts.length - 1; i >= 0; i -= 1) {
    const t = impacts[i];
    const age = now - t.born;
    if (age > 160) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      impacts.splice(i, 1);
    } else {
      t.mesh.material.opacity = 0.9 * (1 - age / 160);
      t.mesh.scale.setScalar(1 + age / 120);
    }
  }
}

/* ── 원격 플레이어 아바타 ──────────────────────────────────── */
function nameSprite(name, color = '#a7f3d0') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 닉네임이 길어도 잘리지 않도록 폭에 맞춰 글자 크기를 줄인다.
  const fontOf = (size) => `bold ${size}px "Pretendard", "Malgun Gothic", system-ui, sans-serif`;
  let fontSize = 30;
  ctx.font = fontOf(fontSize);
  while (fontSize > 14 && ctx.measureText(name).width > canvas.width - 20) {
    fontSize -= 2;
    ctx.font = fontOf(fontSize);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 34);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.25;
  sprite.material.depthTest = true;
  return sprite;
}

function hashColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return new THREE.Color().setHSL(h / 360, 0.55, 0.55);
}

function createAvatar(id, name, isBot = false) {
  const group = new THREE.Group();
  const color = hashColor(id);

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, emissive: 0x330000, emissiveIntensity: 0.35 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.85, 4, 12), bodyMat);
  body.position.y = 0.95;
  body.castShadow = !isTouch;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xe8d9c5, roughness: 0.8 }),
  );
  head.position.y = 1.62;
  head.castShadow = !isTouch;
  group.add(head);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.09, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: 0xf87171, emissiveIntensity: 0.7 }),
  );
  visor.position.set(0, 1.66, -0.22);
  group.add(visor);

  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.1, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1f2933, roughness: 0.5, metalness: 0.6 }),
  );
  gun.position.set(0.26, 1.2, -0.28);
  group.add(gun);

  // 적 이름표(적=붉은 톤) + 체력바(스프라이트라 항상 카메라를 향한다)
  const label = nameSprite(name, isBot ? '#fcd34d' : '#fda4af');
  group.add(label);

  const hpBg = new THREE.Sprite(
    new THREE.SpriteMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.8, depthTest: true }),
  );
  hpBg.scale.set(0.94, 0.12, 1);
  hpBg.position.y = 2.06;
  group.add(hpBg);

  const hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x34d399, depthTest: true }));
  hpFill.scale.set(0.9, 0.08, 1);
  hpFill.position.set(0, 2.06, 0.01);
  group.add(hpFill);

  scene.add(group);
  const avatar = { id, name, group, head, gun, label, hpBg, hpFill, weapon: 1, hp: 100, isBot, buffer: [], lastSeen: performance.now() };
  state.avatars.set(id, avatar);
  updateAvatarHealth(avatar, 100);
  return avatar;
}

/** 원격 플레이어 체력바 갱신(HP 비율만큼 줄이고 왼쪽 정렬) */
function updateAvatarHealth(avatar, hp) {
  if (!avatar.hpFill) return;
  const ratio = Math.max(0, Math.min(1, hp / 100));
  avatar.hpFill.scale.set(Math.max(0.001, 0.9 * ratio), 0.08, 1);
  avatar.hpFill.position.x = -0.45 * (1 - ratio);
  const color = ratio > 0.5 ? 0x34d399 : ratio > 0.25 ? 0xfbbf24 : 0xf87171;
  avatar.hpFill.material.color.setHex(color);
  avatar.hpBg.visible = ratio > 0;
  avatar.hpFill.visible = ratio > 0;
}

/** 원격 플레이어가 든 무기를 실루엣으로 구분할 수 있게 총 모델을 바꾼다. */
function applyRemoteWeapon(avatar, weaponId) {
  if (!avatar.gun) return;
  if (weaponId === 2) avatar.gun.scale.set(0.9, 0.85, 0.55); // 권총: 짧은 총열
  else if (weaponId === 3) avatar.gun.scale.set(1.22, 1.05, 1.2); // 샷건: 긴 총열
  else avatar.gun.scale.set(1, 1, 1); // 라이플
}

function removeAvatar(id) {
  const avatar = state.avatars.get(id);
  if (!avatar) return;
  scene.remove(avatar.group);
  avatar.group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose?.();
    }
  });
  state.avatars.delete(id);
}

function pushSample(avatar, x, y, z, yaw, pitch, now) {
  const buf = avatar.buffer;
  const last = buf[buf.length - 1];
  if (
    last &&
    Math.abs(last.x - x) < 0.01 &&
    Math.abs(last.y - y) < 0.01 &&
    Math.abs(last.z - z) < 0.01 &&
    Math.abs(last.yaw - yaw) < 0.01
  ) {
    return;
  }
  buf.push({ t: now, x, y, z, yaw, pitch });
  while (buf.length > 24) buf.shift();
}

function lerpAngle(a, b, k) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * k;
}

function sampleAvatar(avatar, renderTime) {
  const buf = avatar.buffer;
  if (!buf.length) return null;
  if (buf.length === 1 || renderTime <= buf[0].t) return buf[0];
  for (let i = 0; i < buf.length - 1; i += 1) {
    const a = buf[i];
    const b = buf[i + 1];
    if (renderTime >= a.t && renderTime <= b.t) {
      const k = (renderTime - a.t) / Math.max(1, b.t - a.t);
      return {
        x: a.x + (b.x - a.x) * k,
        y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * k,
        z: a.z + (b.z - a.z) * k,
        yaw: lerpAngle(a.yaw, b.yaw, k),
        pitch: a.pitch + (b.pitch - a.pitch) * k,
      };
    }
  }
  return buf[buf.length - 1];
}

/* ── 보급 아이템 3D 마커 ──────────────────────────────────── */
const LOOT_COLORS = { weapon: 0xfb923c, ammo: 0x38bdf8, kit: 0x34d399, medkit: 0xf87171 };

function buildLootMarkers() {
  if (!scene || !state.config?.loot) return;
  if (state.lootMeshes) {
    for (const group of state.lootMeshes.values()) scene.remove(group);
    state.lootMeshes.clear();
  } else {
    state.lootMeshes = new Map();
  }
  const geo = new THREE.BoxGeometry(0.52, 0.34, 0.52);
  for (const item of state.config.loot) {
    const color = LOOT_COLORS[item.kind] ?? 0x94a3b8;
    const group = new THREE.Group();
    const box = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.45, metalness: 0.35 }),
    );
    box.position.y = 0.2;
    group.add(box);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.8, 6, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    beam.position.y = 0.95;
    group.add(beam);
    group.position.set(item.x, 0, item.z);
    scene.add(group);
    state.lootMeshes.set(item.id, group);
  }
}

function updateLootSpinner(dt) {
  if (!state.lootMeshes) return;
  for (const group of state.lootMeshes.values()) {
    if (!group.visible) continue;
    group.rotation.y += dt * 1.4;
  }
}

/* ── 알림 · 배너 · 피해 숫자 ─────────────────────────────── */
function showToast(text) {
  if (!text || !dom.toast) return;
  dom.toast.textContent = text;
  dom.toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => dom.toast.classList.remove('show'), 2200);
}

function showKillBanner(win, headshot = false) {
  if (!dom.killBanner) return;
  dom.killBannerText.textContent = headshot ? '헤드샷 처치!' : '적 처치!';
  dom.killBanner.classList.remove('show');
  void dom.killBanner.offsetWidth;
  dom.killBanner.classList.add('show');
  audio.killConfirm(Boolean(headshot));
  window.clearTimeout(state.killBannerTimer);
  state.killBannerTimer = window.setTimeout(() => dom.killBanner.classList.remove('show'), 1400);
}

function spawnDamageNumber(dmg, head = false) {
  if (!dom.damageNumbers || !Number.isFinite(dmg)) return;
  const el = document.createElement('div');
  el.className = `dmg-num${head ? ' head' : ''}`;
  el.textContent = head ? `${dmg} 헤드` : String(dmg);
  el.style.left = `${50 + (Math.random() * 8 - 4)}%`;
  el.style.top = `${50 + (Math.random() * 8 - 3)}%`;
  dom.damageNumbers.appendChild(el);
  window.setTimeout(() => el.remove(), 780);
}

/* ── 캔버스 HUD(나침반 · 미니맵 · 조준선) ──────────────────── */
function ensureCanvasSize(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** yaw(라디안) → 나침반 방위각(도, 북=0, 동=90) */
function headingDegrees(yaw) {
  return ((-yaw * 180) / Math.PI + 360) % 360;
}

function drawCompass() {
  const canvas = dom.compass;
  if (!canvas) return;
  const sized = ensureCanvasSize(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;
  ctx.clearRect(0, 0, w, h);
  const heading = headingDegrees(state.me.yaw);
  const span = 140; // ±70도
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
  const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let deg = 0; deg < 360; deg += 15) {
    const rel = ((deg - heading + 540) % 360) - 180;
    if (Math.abs(rel) > span / 2) continue;
    const x = w / 2 + (rel / (span / 2)) * (w / 2 - 8);
    const major = deg % 90 === 0;
    ctx.strokeStyle = major ? 'rgba(226,255,247,0.9)' : 'rgba(226,255,247,0.28)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, h - 2);
    ctx.lineTo(x, h - (major ? 11 : 6));
    ctx.stroke();
    if (major) {
      ctx.fillStyle = deg === 0 ? '#f87171' : 'rgba(226,255,247,0.88)';
      ctx.fillText(labels[deg], x, h - 19);
    }
  }
  // 안전 구역 중심 방향
  if (state.zone) {
    const dx = state.zone.centerX - state.me.x;
    const dz = state.zone.centerZ - state.me.z;
    const targetHeading = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    const rel = ((targetHeading - heading + 540) % 360) - 180;
    const clamped = Math.max(-span / 2, Math.min(span / 2, rel));
    const x = w / 2 + (clamped / (span / 2)) * (w / 2 - 8);
    ctx.fillStyle = 'rgba(56,189,248,0.9)';
    ctx.beginPath();
    ctx.moveTo(x, h - 13);
    ctx.lineTo(x - 4, h - 21);
    ctx.lineTo(x + 4, h - 21);
    ctx.closePath();
    ctx.fill();
  }
  // 현재 방위 표시
  ctx.fillStyle = '#34d399';
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2 - 5, 9);
  ctx.lineTo(w / 2 + 5, 9);
  ctx.closePath();
  ctx.fill();
}

function drawMinimap(now) {
  const canvas = dom.minimap;
  if (!canvas || !state.map) return;
  // 20fps 면 충분하다.
  if (now - state.lastMinimapAt < 50) return;
  const sized = ensureCanvasSize(canvas);
  if (!sized) return;
  state.lastMinimapAt = now;
  const { ctx, w, h } = sized;
  const half = state.map.arena.size / 2;
  const scale = Math.min(w, h) / state.map.arena.size;
  const toX = (x) => w / 2 + x * scale;
  const toY = (z) => h / 2 + z * scale;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(8,14,20,0.74)';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(148,163,184,0.5)';
  for (const cover of state.map.covers) {
    ctx.fillRect(toX(cover.x - cover.w / 2), toY(cover.z - cover.d / 2), Math.max(1, cover.w * scale), Math.max(1, cover.d * scale));
  }

  if (state.zone) {
    ctx.strokeStyle = state.zone.shrinking ? 'rgba(251,191,36,0.9)' : 'rgba(56,189,248,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(toX(state.zone.centerX), toY(state.zone.centerZ), Math.max(2, state.zone.radius * scale), 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const item of state.config?.loot || []) {
    if (state.items.get(item.id) === false) continue;
    if (Math.hypot(item.x - state.me.x, item.z - state.me.z) > 42) continue;
    ctx.fillStyle = `#${(LOOT_COLORS[item.kind] ?? 0x94a3b8).toString(16).padStart(6, '0')}`;
    ctx.fillRect(toX(item.x) - 1.5, toY(item.z) - 1.5, 3, 3);
  }

  for (const avatar of state.avatars.values()) {
    if (!avatar.group.visible) continue;
    const p = avatar.group.position;
    if (Math.hypot(p.x - state.me.x, p.z - state.me.z) > 45) continue;
    ctx.fillStyle = avatar.isBot ? '#fcd34d' : '#f87171';
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.z), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 나(방향 삼각형)
  const sx = toX(state.me.x);
  const sy = toY(state.me.z);
  const angle = headingDegrees(state.me.yaw) * (Math.PI / 180);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.fillStyle = '#34d399';
  ctx.beginPath();
  ctx.moveTo(0, -5.5);
  ctx.lineTo(4, 4);
  ctx.lineTo(0, 2);
  ctx.lineTo(-4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(120,220,180,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  // 아레나 경계(160m) 밖 표시는 맵이 곧 경계라 생략.
  void half;
}

/** 이동/사격/정조준에 따라 조준선이 벌어지고 좁아진다. */
function updateCrosshair(dt) {
  const me = state.me;
  let target = 3;
  if (me.ads) target = -2.5;
  else {
    target = 3 + (state.movingNow ? 3.2 : 0) + (me.grounded ? 0 : 5) - (me.crouch ? 1.5 : 0);
  }
  state.bloom += (target - state.bloom) * Math.min(1, dt * 9);
  const gap = Math.max(0, state.bloom).toFixed(1);
  dom.crosshair.style.setProperty('--gap', `${gap}px`);
  dom.crosshair.style.setProperty('--ch-alpha', me.ads ? '0.55' : '0.85');
}

/* ── 사운드 토글 ─────────────────────────────────────────── */
function setupSoundToggle() {
  const saved = localStorage.getItem('3dfp.muted');
  state.muted = saved === '1';
  audio.setEnabled(!state.muted);
  if (dom.soundToggle) {
    dom.soundToggle.textContent = state.muted ? '🔇' : '🔊';
    dom.soundToggle.title = state.muted ? '소리 켜기' : '소리 끄기';
    dom.soundToggle.addEventListener('click', () => {
      state.muted = !state.muted;
      audio.setEnabled(!state.muted);
      localStorage.setItem('3dfp.muted', state.muted ? '1' : '0');
      dom.soundToggle.textContent = state.muted ? '🔇' : '🔊';
      dom.soundToggle.title = state.muted ? '소리 켜기' : '소리 끄기';
      if (!state.muted) audio.uiClick();
    });
  }
}

/* ── 입력 ─────────────────────────────────────────────────── */
function setupInput() {
  const PREVENT_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

  window.addEventListener('keydown', (e) => {
    if (PREVENT_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) {
      state.keys.add(e.code);
      return;
    }
    state.keys.add(e.code);
    if (state.phase !== 'playing' || isPaused()) return;
    switch (e.code) {
      case 'Space':
        requestJump();
        break;
      case 'KeyR':
        requestReload();
        break;
      case 'KeyE':
        requestSwap();
        break;
      case 'KeyF':
        requestLoot();
        break;
      case 'KeyQ':
        requestHeal();
        break;
      case 'KeyV':
        toggleAds();
        break;
      case 'Digit1':
        requestSwap(1);
        break;
      case 'Digit2':
        requestSwap(2);
        break;
      case 'Digit3':
        requestSwap(3);
        break;
      default:
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.code);
  });

  window.addEventListener('blur', () => {
    state.keys.clear();
    state.firing = false;
    state.dragLook = false;
  });

  // ── PC 시점 ──────────────────────────────────────────────
  // 1) PointerLock 이 잠겨 있으면 표준 FPS 방식(movementX/Y).
  // 2) 잠금이 없거나 실패해도 마우스를 누른 채 끌면 100% 시점이 돈다(드래그 모드).
  document.addEventListener('mousemove', (e) => {
    if (state.phase !== 'playing') return;
    if (isPaused()) return;
    const locked = document.pointerLockElement === dom.canvas;
    if (locked) {
      if (state.ignoreMoves > 0) {
        state.ignoreMoves -= 1;
        return;
      }
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return; // 잠금 직후 튀는 값 무시
      addLook(e.movementX, e.movementY);
      return;
    }
    if (!state.dragLook || e.buttons === 0) return;
    // 잠금이 없을 때는 movementX 가 0인 브라우저도 있어 좌표 차분을 함께 쓴다.
    let dx = e.movementX || 0;
    let dy = e.movementY || 0;
    if (dx === 0 && dy === 0 && Number.isFinite(e.clientX)) {
      dx = e.clientX - state.dragLastX;
      dy = e.clientY - state.dragLastY;
    }
    state.dragLastX = e.clientX;
    state.dragLastY = e.clientY;
    if (Math.abs(dx) > 300 || Math.abs(dy) > 300) return;
    if (dx || dy) addLook(dx, dy);
  });

  // 우클릭 정조준이 브라우저 메뉴를 열지 않게 한다.
  dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  dom.canvas.addEventListener('mousedown', (e) => {
    if (state.phase !== 'playing' || isTouch || isPaused()) return;
    if (e.button === 2) {
      e.preventDefault();
      state.adsHold = true;
      setAds(true);
      return;
    }
    if (e.button !== 0) return;
    audio.resume();
    state.dragLook = true;
    state.dragLastX = e.clientX;
    state.dragLastY = e.clientY;
    if (document.pointerLockElement !== dom.canvas) requestLock(true);
    state.firing = true;
    attemptShoot(performance.now());
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      state.firing = false;
      state.dragLook = false;
    }
    if (e.button === 2 && state.adsHold) {
      state.adsHold = false;
      if (!state.adsToggle) setAds(false);
    }
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === dom.canvas;
    if (locked) {
      window.clearTimeout(state.lockTimer);
      state.lockTimer = 0;
      state.ignoreMoves = 2;
      dom.pause.classList.add('hidden');
      state.firing = false;
    } else if (
      state.phase === 'playing' &&
      !isTouch &&
      state.me.alive &&
      !isResultOpen() &&
      performance.now() > state.suppressPauseUntil
    ) {
      showPause('일시정지', '마우스 고정이 풀렸습니다. 계속하려면 아래 버튼을 누르거나 화면을 클릭하세요.');
      state.firing = false;
    }
  });

  // 잠금 요청이 거절되면 즉시 드래그 시점 모드로 전환한다(조준이 죽지 않게).
  document.addEventListener('pointerlockerror', () => {
    if (state.phase === 'playing') onLockUnavailable();
  });

  dom.pause.addEventListener('click', () => resumeFromPause());
  dom.btnResume.addEventListener('click', () => resumeFromPause());

  // ── 모바일: 오른손 시점 드래그 ─────────────────────────
  // 캔버스가 아닌 조작 버튼은 각자 setPointerCapture 로 입력을 가져가므로,
  // 시점 드래그 포인터와 사격/점프 포인터가 섞이지 않는다.
  const lookPointers = new Map();

  const overControl = (x, y) => {
    for (const el of [dom.joystick, dom.btnFire, dom.btnReload, dom.btnSwap, dom.btnHeal, dom.btnJump, dom.btnAim, dom.btnCrouch, dom.btnLoot]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return true;
    }
    return false;
  };

  dom.canvas.addEventListener('pointerdown', (e) => {
    if (!isTouch || state.phase !== 'playing' || isPaused()) return;
    if (lookPointers.has(e.pointerId)) return;
    if (overControl(e.clientX, e.clientY)) return; // 조이스틱/버튼 위는 각자 처리
    if (e.clientX < window.innerWidth * 0.22) return; // 왼쪽 가장자리는 조이스틱 여유
    lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 캡처해서 버튼 위를 지나가도 시점 회전이 끊기지 않게 한다.
    try {
      dom.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 캡처 미지원 무시 */
    }
  });

  dom.canvas.addEventListener('pointermove', (e) => {
    if (!isTouch || state.phase !== 'playing') return;
    const last = lookPointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last.x = e.clientX;
    last.y = e.clientY;
    if (!dx && !dy) return;
    addLook(dx * TOUCH_SENSITIVITY, dy * TOUCH_SENSITIVITY);
  });

  const endLook = (e) => {
    lookPointers.delete(e.pointerId);
  };
  dom.canvas.addEventListener('pointerup', endLook);
  dom.canvas.addEventListener('pointercancel', endLook);
  dom.canvas.addEventListener('lostpointercapture', endLook);

  if (isTouch) {
    dom.touchControls.classList.remove('hidden');
  }

  // ── 모바일 조이스틱 ─────────────────────────────────────
  let joystickId = null;
  const joystickMax = 42;

  const updateJoystick = (clientX, clientY) => {
    const rect = dom.joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > joystickMax) {
      dx = (dx / dist) * joystickMax;
      dy = (dy / dist) * joystickMax;
    }
    dom.joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    state.touchMove.x = dx / joystickMax;
    state.touchMove.y = dy / joystickMax;
    state.touchMove.active = true;
  };

  const resetJoystick = () => {
    joystickId = null;
    dom.joystickKnob.style.transform = 'translate(0px, 0px)';
    state.touchMove.x = 0;
    state.touchMove.y = 0;
    state.touchMove.active = false;
  };

  dom.joystick.addEventListener('pointerdown', (e) => {
    joystickId = e.pointerId;
    try {
      dom.joystick.setPointerCapture(e.pointerId);
    } catch {
      /* 무시 */
    }
    updateJoystick(e.clientX, e.clientY);
    audio.resume();
  });
  dom.joystick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joystickId) return;
    updateJoystick(e.clientX, e.clientY);
  });
  dom.joystick.addEventListener('pointerup', resetJoystick);
  dom.joystick.addEventListener('pointercancel', resetJoystick);

  // ── 모바일 버튼(멀티터치: 버튼마다 독립 pointer) ─────────
  const bindHoldButton = (el, onDown, onUp) => {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('pressed');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 무시 */
      }
      audio.resume();
      onDown?.();
    });
    const up = (e) => {
      e.preventDefault();
      el.classList.remove('pressed');
      onUp?.();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', (e) => {
      if (e.buttons === 0) up(e);
    });
  };

  bindHoldButton(
    dom.btnFire,
    () => {
      state.firing = true;
      attemptShoot(performance.now());
    },
    () => {
      state.firing = false;
    },
  );
  bindHoldButton(dom.btnReload, () => requestReload());
  bindHoldButton(dom.btnSwap, () => requestSwap());
  bindHoldButton(dom.btnHeal, () => requestHeal());
  bindHoldButton(dom.btnJump, () => requestJump());
  bindHoldButton(dom.btnLoot, () => requestLoot());
  bindHoldButton(
    dom.btnCrouch,
    () => {
      state.touchCrouch = true;
    },
    () => {
      state.touchCrouch = false;
    },
  );
  bindHoldButton(dom.btnAim, () => toggleAds());

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120));

  // 첫 사용자 제스처에서 오디오 활성화
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
}

function addLook(dx, dy) {
  // 정조준 중에는 감도를 낮춰 정밀 조준이 가능하게 한다.
  const sens = MOUSE_SENSITIVITY * (state.me.ads ? state.config?.adsSensitivity || 0.55 : 1);
  state.me.yaw -= dx * sens;
  state.me.pitch -= dy * sens;
  state.me.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.me.pitch));
  if (state.me.yaw > Math.PI) state.me.yaw -= Math.PI * 2;
  if (state.me.yaw < -Math.PI) state.me.yaw += Math.PI * 2;
}

function isPaused() {
  return !isTouch && !dom.pause.classList.contains('hidden');
}

function requestLock(fromGesture = true) {
  if (isTouch || state.lockUnavailable) return;
  if (document.pointerLockElement === dom.canvas) return;
  let promise;
  try {
    promise = dom.canvas.requestPointerLock?.();
  } catch (err) {
    if (fromGesture) onLockUnavailable();
    return;
  }
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      // 참여 직후처럼 사용자 제스처가 없을 때의 자동 잠금은 실패해도 대체 모드로 단정하지 않는다.
      if (fromGesture) onLockUnavailable();
    });
  }
  // 잠금 요청이 아무 응답 없이 실패하는 브라우저도 있다 → 시간이 지나면 드래그 모드로 넘어간다.
  if (fromGesture) {
    window.clearTimeout(state.lockTimer);
    state.lockTimer = window.setTimeout(() => {
      state.lockTimer = 0;
      if (state.phase === 'playing' && !isTouch && document.pointerLockElement !== dom.canvas && state.me.alive) {
        onLockUnavailable();
      }
    }, LOCK_TIMEOUT_MS);
  }
}

/** 일시정지/조준 고정 화면을 띄운다(버튼 하나로 돌아올 수 있게). */
function showPause(title, text) {
  dom.pauseTitle.textContent = title;
  dom.pauseText.textContent = text;
  dom.pause.classList.remove('hidden');
}

/** 일시정지 화면에서 게임으로 돌아간다. */
function resumeFromPause() {
  dom.pause.classList.add('hidden');
  state.firing = false;
  if (state.lockUnavailable) return; // 드래그 시점 모드에서는 그대로 플레이
  requestLock();
  if (document.pointerLockElement !== dom.canvas) {
    // 브라우저가 잠금을 거절하면 다시 안내를 보여 준다(조용히 실패하지 않게).
    window.setTimeout(() => {
      if (!state.lockUnavailable && state.phase === 'playing' && !document.pointerLockElement) {
        showPause('조준 고정 실패', '브라우저가 마우스 고정을 거절했습니다. 화면을 드래그하면 조준이 되고, 다시 눌러 고정할 수도 있습니다.');
      }
    }, 500);
  }
}

/**
 * PointerLock을 쓸 수 없는 환경(헤드리스·일부 내장 브라우저·iframe) 대체 모드.
 * 마우스를 누른 채 드래그해 시점을 돌리고, 클릭으로 사격한다.
 */
function onLockUnavailable() {
  if (state.lockUnavailable) return;
  state.lockUnavailable = true;
  dom.pauseTitle.textContent = '조준 방식 안내';
  dom.pauseText.textContent = '이 브라우저에서는 마우스 고정을 쓸 수 없습니다. 화면을 누른 채 드래그해 시점을 돌리고, 클릭으로 사격하세요.';
  dom.btnResume.textContent = '계속하기';
  dom.pauseHint.textContent = '게임은 그대로 플레이할 수 있습니다.';
  dom.pause.classList.add('hidden');
  showToast('드래그 조준 모드 — 마우스를 누른 채 끌면 시점이 돌아갑니다.');
}

function onResize() {
  if (!renderer || !camera) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* ── 액션 ─────────────────────────────────────────────────── */
function canPlay() {
  return state.phase === 'playing' && state.me.alive && Boolean(state.config);
}

function currentWeapon() {
  if (!state.config) return null;
  return state.config.weapons[state.me.weapon] || null;
}

/** 정조준(ADS) 켜기/끄기. 무기별 화각·감도·탄퍼짐이 함께 바뀐다. */
function setAds(on) {
  const want = Boolean(on) && state.phase === 'playing' && state.me.alive && state.round && state.round.state === 'live';
  if (want === state.me.ads) return;
  state.me.ads = want;
  if (want) {
    state.firing = false;
    audio.adsIn();
  } else {
    audio.adsOut();
  }
  dom.adsOverlay.classList.toggle('active', want);
  dom.crosshair.classList.toggle('ads', want);
  dom.btnAim?.classList.toggle('active', state.adsToggle && want);
}

function toggleAds() {
  state.adsToggle = !state.adsToggle;
  setAds(state.adsToggle);
}

function attemptShoot(now) {
  if (!canPlay()) return;
  // 배틀로얄: 라운드가 진행 중일 때만 사격할 수 있다(대기/인터미션 중에는 워밍업).
  if (state.round && state.round.state !== 'live') return;
  const weapon = currentWeapon();
  if (!weapon) return;
  if (now < state.nextShotAt || now < state.reloadEndAt) return;
  if (state.me.mag <= 0) {
    requestReload();
    if (now - state.lastDryAt > 500) {
      state.lastDryAt = now;
      audio.dry();
    }
    return;
  }
  state.nextShotAt = now + weapon.fireDelay;
  flashMuzzle();
  audio.shoot(weapon.key);
  dom.crosshair.classList.add('firing');
  window.setTimeout(() => dom.crosshair.classList.remove('firing'), 90);

  // 반동: 위로 튀고 좌우로 조금 흔들린다(정조준·앉기 중에는 줄어든다).
  const kick = (weapon.recoilPitch ?? 0.008) * (state.me.ads ? 0.62 : 1) * (state.me.crouch ? 0.8 : 1);
  const sway = (weapon.recoilYaw ?? 0.002) * (Math.random() * 2 - 1);
  state.me.pitch = Math.min(PITCH_LIMIT, state.me.pitch + kick);
  state.me.yaw += sway;
  state.viewKick = Math.min(0.09, state.viewKick + kick * 6);
  state.bloom = Math.min(26, state.bloom + (weapon.bloom ?? 4) * (state.me.ads ? 0.4 : 1));

  net.send({ t: 'shoot', yaw: state.me.yaw, pitch: state.me.pitch, ads: state.me.ads });
}

function requestJump() {
  if (!canPlay() || isPaused()) return;
  if (!state.me.grounded) return;
  const air = state.config?.jumpVelocity ?? 9;
  state.me.vy = air;
  state.me.grounded = false;
  audio.jump();
  net.send({ t: 'jump' });
}

function requestLoot() {
  if (!canPlay() || isPaused()) return;
  const now = performance.now();
  if (now - state.lastLootAt < 400) return;
  state.lastLootAt = now;
  net.send({ t: 'loot' });
}

function requestReload() {
  if (!canPlay()) return;
  const weapon = currentWeapon();
  if (!weapon) return;
  if (state.me.mag >= weapon.mag) return;
  if (state.me.reserve <= 0) return;
  if (performance.now() < state.reloadEndAt) return;
  state.reloadEndAt = performance.now() + weapon.reloadMs;
  net.send({ t: 'reload' });
}

function requestSwap(weaponId) {
  if (!canPlay()) return;
  // 무기 교체 = 진행 중이던 재장전 취소. 서버도 reloadEnd를 0으로 만들고 reloadCancel을 보낸다.
  cancelLocalReload();
  net.send({ t: 'swap', w: weaponId });
  state.nextShotAt = performance.now() + 300;
}

/** 클라이언트 쪽 재장전 상태/타이머를 비운다(무기 교체·서버 취소 시). */
function cancelLocalReload() {
  state.reloadEndAt = 0;
  state.me.reloadMs = 0;
  dom.reloadHint.classList.add('hidden');
}

function requestHeal() {
  if (!canPlay()) return;
  net.send({ t: 'heal' });
}

/* ── 수직 물리(클라이언트 예측) ──────────────────────────── */
/** (x,z) 아래에서 발을 딛을 수 있는 높이(바닥 0, 엄폐물 윗면). 서버 supportAt 과 같은 규칙. */
function supportAtLocal(x, z, prevY) {
  let support = 0;
  if (!state.map) return 0;
  const margin = 0.225;
  for (const cover of state.map.covers) {
    if (cover.h > prevY + 0.32) continue;
    const halfW = cover.w / 2;
    const halfD = cover.d / 2;
    if (x < cover.x - halfW - margin || x > cover.x + halfW + margin) continue;
    if (z < cover.z - halfD - margin || z > cover.z + halfD + margin) continue;
    if (cover.h > support) support = cover.h;
  }
  return support;
}

function stepVertical(dt) {
  const me = state.me;
  const cfg = state.config;
  const gravity = cfg?.gravity ?? 20;
  const prevY = me.y;
  const wasGrounded = me.grounded;
  me.vy -= gravity * dt;
  if (me.vy < -MAX_FALL_SPEED) me.vy = -MAX_FALL_SPEED;
  let nextY = prevY + me.vy * dt;
  const support = supportAtLocal(me.x, me.z, prevY);
  if (nextY <= support && me.vy <= 0) {
    if (!wasGrounded && prevY - support > 0.15) {
      state.landDip = Math.min(0.18, Math.abs(me.vy) * 0.014);
      audio.land(Math.abs(me.vy));
    }
    nextY = support;
    me.vy = 0;
    me.grounded = true;
  } else {
    me.grounded = false;
  }
  me.y = nextY;
}

/** 줍기 힌트 + 자동 줍기 + 보급 상자 마커 표시 */
function updateLoot(now) {
  const cfg = state.config;
  if (!cfg || !Array.isArray(cfg.loot)) return;
  const me = state.me;
  const range = cfg.lootRange ?? 2.8;
  let best = null;
  let bestDist = range;
  for (const item of cfg.loot) {
    const ready = state.items.get(item.id) !== false;
    const mesh = state.lootMeshes?.get(item.id);
    if (mesh) mesh.visible = ready;
    if (!ready) continue;
    const d = Math.hypot(item.x - me.x, item.z - me.z);
    if (d <= bestDist) {
      best = item;
      bestDist = d;
    }
  }
  const show = Boolean(best) && state.phase === 'playing' && me.alive;
  dom.lootHint.classList.toggle('hidden', !show);
  if (best) {
    dom.lootHint.textContent = `${LOOT_HINTS[best.kind] || '아이템'} 줍기 — F`;
  }
  state.lootOpen = show;
  // 자동 줍기(옵션): 범위 안에 쓸 만한 아이템이 있으면 서버에 요청한다(서버가 효과/범위를 재판정).
  if (show && state.autoPickup && me.alive && now - state.lastLootAt > 700) {
    state.lastLootAt = now;
    net.send({ t: 'loot' });
  }
}

const LOOT_HINTS = {
  weapon: '샷건',
  ammo: '탄약',
  kit: '힐 키트',
  medkit: '구급상자',
};

/* ── 네트워크 처리 ────────────────────────────────────────── */
function setupNet() {
  net.on('welcome', onWelcome);
  net.on('s', onSnapshot);
  net.on('ev', onEvents);
  net.on('corr', (msg) => {
    state.me.x = msg.x;
    state.me.z = msg.z;
    if (Number.isFinite(msg.y)) {
      state.me.y = msg.y;
      state.me.vy = 0;
    }
  });
  net.on('reloadStart', (msg) => {
    if (msg && msg.weapon && msg.weapon !== state.me.weapon) return;
    audio.reload();
  });
  net.on('reloadCancel', () => {
    cancelLocalReload();
  });
  net.on('reloaded', (msg) => {
    // 무기가 바뀐 뒤 도착한 이전 무기의 완료 패킷은 버린다.
    if (msg && msg.weapon && msg.weapon !== state.me.weapon) return;
    audio.reloaded();
    state.reloadEndAt = 0;
    state.me.reloadMs = 0;
    if (msg) {
      if (Number.isFinite(msg.mag)) state.me.mag = msg.mag;
      if (Number.isFinite(msg.reserve)) state.me.reserve = msg.reserve;
    }
  });
  net.on('healed', (msg) => {
    audio.heal();
    state.me.hp = msg.hp;
    state.me.kits = msg.kits;
  });
  net.on('looted', (msg) => {
    audio.loot();
    if (msg.text) showToast(msg.text);
    if (Number.isFinite(msg.kits)) state.me.kits = msg.kits;
    if (Number.isFinite(msg.hp)) state.me.hp = msg.hp;
    if (Number.isFinite(msg.mag)) state.me.mag = msg.mag;
    if (msg.reserve) state.me.reserve = msg.reserve[state.me.weapon] ?? state.me.reserve;
    if (msg.owned) state.owned = msg.owned;
    if (Number.isFinite(msg.weapon) && msg.weapon !== state.me.weapon) {
      state.me.weapon = msg.weapon;
      setViewmodel(msg.weapon);
    }
    state.items.set(msg.itemId, false);
  });
  net.on('toast', (msg) => {
    if (msg && msg.text) showToast(msg.text);
  });
  net.on('noWeapon', (msg) => {
    showToast(`${state.config?.weapons?.[msg.weapon]?.name || '그 무기'}은(는) 아직 없습니다. 맵에서 주우세요.`);
  });
  net.on('dry', (msg) => {
    audio.dry();
    state.reloadEndAt = 0;
  });
  net.on('kick', (msg) => {
    showDisconnected(msg.message || '서버에서 연결이 종료되었습니다.');
  });
  net.on('error', (msg) => {
    if (!msg || typeof msg.t !== 'string') return; // WebSocket 자체 오류 이벤트
    if (state.phase === 'menu' || state.phase === 'connecting') {
      state.phase = 'menu';
      setLoading(false);
      showMenuError(msg.message || '오류가 발생했습니다.');
    }
  });
  net.on('left', () => {
    showDisconnected('방에서 나갔습니다.');
  });
  net.on('close', () => {
    if (state.phase === 'playing') showDisconnected('서버와의 연결이 종료되었습니다.');
  });
  net.on('pong', () => {});
}

function onWelcome(msg) {
  state.myId = msg.id;
  state.config = msg.config;
  state.roomCode = msg.code;
  state.phase = 'playing';
  dom.hud.classList.remove('hidden');
  dom.menu.classList.add('hidden');
  dom.roomCode.textContent = msg.code;
  if (!state.map && msg.map) {
    state.map = msg.map;
    if (scene) buildWorld(msg.map);
  }
  if (scene) buildLootMarkers();
  buildWeaponSlots();

  const spawn = msg.map?.spawns?.[0];
  // 위치는 첫 스냅샷(서버 권위)으로 확정한다.
  state.needSnap = true;
  state.me.y = 0;
  state.me.vy = 0;
  state.me.grounded = true;
  if (spawn) {
    state.me.x = spawn.x;
    state.me.z = spawn.z;
  }
  // 서버 스냅샷이 곧 위치를 확정한다.
  const weapon = currentWeapon();
  setViewmodel(state.me.weapon || 1);
  if (weapon) state.me.mag = weapon.mag;
  if (msg.config?.ownedAtStart) state.owned = { ...msg.config.ownedAtStart };

  setLoading(false);
  audio.resume();
  if (!isTouch) {
    requestLock(false); // 부트 직후 자동 시도 — 실패해도 일시정지 안내만 띄우고 대체 모드로 단정하지 않는다
    if (document.pointerLockElement !== dom.canvas) {
      dom.pause.classList.remove('hidden');
    }
  } else {
    showToast(isTouch ? '왼쪽 조이스틱 이동 · 오른쪽 화면 드래그 조준' : '');
  }
}

function onSnapshot(snap) {
  state.zone = snap.zone;
  state.round = snap.round;
  state.aliveCount = snap.alive;
  const now = performance.now();
  const seen = new Set();

  if (Array.isArray(snap.items)) {
    state.items.clear();
    for (const [id, readyFlag] of snap.items) state.items.set(id, readyFlag === 1);
  }

  for (const entry of snap.players) {
    const [id, name, x, y, z, yaw, pitch, hp, aliveFlag, weapon, mag, reserve, kills, deaths, protectFlag, reloadMs, kits, flagBits] = entry;
    seen.add(id);
    const alive = aliveFlag === 1;
    const flags = flagBits || 0;
    const isBot = (flags & 16) !== 0;

    if (id === state.myId) {
      const me = state.me;
      const wasAlive = me.alive;
      state.myName = name;
      me.hp = hp;
      me.alive = alive;
      me.kills = kills;
      me.deaths = deaths;
      me.kits = kits;
      me.spawnProtect = protectFlag === 1;
      me.reloadMs = reloadMs;
      if (me.weapon !== weapon) {
        me.weapon = weapon;
        setViewmodel(weapon);
      }
      me.mag = mag;
      me.reserve = reserve;

      if (state.needSnap) {
        state.needSnap = false;
        me.x = x;
        me.y = y;
        me.z = z;
        me.yaw = yaw;
        me.pitch = pitch;
        me.alive = alive;
        me.vy = 0;
      }

      if (!wasAlive && alive) {
        me.x = x;
        me.y = y;
        me.z = z;
        me.yaw = yaw;
        me.pitch = pitch;
        me.reloadMs = 0;
        me.vy = 0;
        me.grounded = true;
      }
      // 지상에서는 서버 높이를 기준으로 부드럽게 맞추고, 공중에서는 예측을 존중하되 크게 어긋나면 스냅한다.
      if (me.alive && !state.needSnap) {
        const dy = y - me.y;
        if (me.grounded && Math.abs(dy) < 0.6) me.y += dy * 0.5;
        else if (Math.abs(dy) > 1.2) {
          me.y = y;
          me.vy = 0;
        }
      }
      if (wasAlive && !alive) {
        state.firing = false;
        state.me.ads = false;
        dom.adsOverlay.classList.remove('active');
        cancelLocalReload();
      }
    } else {
      let avatar = state.avatars.get(id);
      if (!avatar) avatar = createAvatar(id, name, isBot);
      avatar.lastSeen = now;
      if (avatar.weapon !== weapon) {
        avatar.weapon = weapon;
        applyRemoteWeapon(avatar, weapon);
      }
      if (avatar.hp !== hp) {
        avatar.hp = hp;
        updateAvatarHealth(avatar, hp);
      }
      if (alive) {
        avatar.group.visible = true;
        pushSample(avatar, x, y, z, yaw, pitch, now);
      } else {
        avatar.group.visible = false;
        avatar.buffer.length = 0;
      }
    }
  }

  for (const id of [...state.avatars.keys()]) {
    if (!seen.has(id)) removeAvatar(id);
  }

  updateHud();
}

function onEvents(msg) {
  const events = msg.events || [];
  for (const ev of events) {
    switch (ev.k) {
      case 'shot': {
        const mine = ev.id === state.myId;
        const dist = mine ? 0 : distanceToMe(ev.from);
        spawnTracer(ev.from, ev.to, mine);
        if (Array.isArray(ev.impacts)) {
          for (const impact of ev.impacts.slice(0, 4)) spawnImpact(impact, mine ? 0xfff2c0 : 0xffc46b);
        }
        if (!mine && dist < 70) {
          const weapon = state.config?.weapons?.[ev.w];
          audio.shoot(weapon ? weapon.key : 'rifle');
        }
        break;
      }
      case 'hit': {
        if (ev.by === state.myId) {
          showHitmarker(Boolean(ev.head));
          spawnDamageNumber(ev.dmg, Boolean(ev.head));
          if (ev.head) audio.headshot();
          else audio.hitmarker();
        }
        if (ev.id === state.myId) {
          flashDamage();
          audio.hurt();
        }
        break;
      }
      case 'kill': {
        addKillFeed(ev);
        if (ev.killerId === state.myId) {
          showHitmarker(true);
          audio.kill();
          showKillBanner(false, ev.headshot);
        }
        if (ev.victimId === state.myId) {
          state.firing = false;
          state.myKiller = { name: ev.killer || null, weapon: ev.weapon || null };
          state.suppressPauseUntil = performance.now() + 1200;
        }
        break;
      }
      case 'jump':
        if (ev.id !== state.myId && distanceToMe({ 0: 0, 2: 0 }) >= 0) {
          // 다른 사람 점프: 가까우면 발소리 느낌만
          audio.footstep(1);
        }
        break;
      case 'land':
        if (ev.id === state.myId) break;
        break;
      case 'loot': {
        if (ev.by !== state.myId) addKillFeed({ k: 'loot', victim: ev.name });
        state.items.set(ev.id, false);
        break;
      }
      case 'join':
        if (ev.id !== state.myId) addKillFeed({ k: 'join', victim: ev.name, bot: ev.bot });
        break;
      case 'leave':
        addKillFeed({ k: 'leave', victim: ev.name });
        break;
      case 'zoneHit':
        if (ev.id === state.myId) {
          flashDamage();
          if (performance.now() - state.hudWarnAt > 900) {
            state.hudWarnAt = performance.now();
            audio.zoneAlarm();
          }
        }
        break;
      case 'heal':
        if (ev.id !== state.myId) break;
        break;
      case 'swap':
        // 서버가 무기를 바꿔줬으면 이전 무기의 재장전 상태는 즉시 비운다.
        if (ev.id === state.myId) cancelLocalReload();
        break;
      case 'round': {
        if (ev.phase === 'end') {
          audio.roundEnd(ev.winnerId ? ev.winnerId === state.myId : false);
          state.firing = false;
        } else if (ev.phase === 'start') {
          dom.result.classList.add('hidden');
          dom.dead.classList.add('hidden');
          state.firing = false;
          state.myKiller = null;
          cancelLocalReload();
        } else if (ev.phase === 'waiting') {
          dom.result.classList.add('hidden');
          state.myKiller = null;
          cancelLocalReload();
        }
        break;
      }
      default:
        break;
    }
  }
}


function distanceToMe(point) {
  if (!point) return 0;
  return Math.hypot(point[0] - state.me.x, point[2] - state.me.z);
}

/* ── HUD ──────────────────────────────────────────────────── */
function setLoading(active, text) {
  if (!active) {
    dom.menuLoading.classList.add('hidden');
    dom.btnJoin.disabled = false;
    dom.btnQuick.disabled = false;
    dom.btnCreate.disabled = false;
    return;
  }
  dom.menuLoadingText.textContent = text || '연결 중…';
  dom.menuLoading.classList.remove('hidden');
  dom.btnJoin.disabled = true;
  dom.btnQuick.disabled = true;
  dom.btnCreate.disabled = true;
}

function showMenuError(message) {
  dom.menuError.textContent = message;
  dom.menuError.classList.remove('hidden');
  // 입력값은 유지하고 포커스만 되돌려 준다.
  dom.codeInput.focus();
  dom.codeInput.select?.();
}

function hideMenuError() {
  dom.menuError.classList.add('hidden');
}

function buildWeaponSlots() {
  if (!state.config) return;
  dom.weaponSlots.innerHTML = '';
  for (const key of Object.keys(state.config.weapons)) {
    const weapon = state.config.weapons[key];
    const el = document.createElement('span');
    el.className = 'wslot';
    el.dataset.weapon = key;
    el.textContent = `${key} ${weapon.name}`;
    dom.weaponSlots.appendChild(el);
  }
}

function updateHud() {
  const me = state.me;
  const weapon = currentWeapon();

  // HP
  const hpPct = Math.max(0, Math.min(100, me.hp));
  dom.hpFill.style.width = `${hpPct}%`;
  dom.hpFill.classList.toggle('low', hpPct <= 35);
  dom.hpValue.textContent = Math.round(hpPct);
  dom.kits.textContent = `힐 ×${me.kits}`;

  // 무기
  if (weapon) {
    dom.weaponName.textContent = weapon.name;
    dom.ammoMag.textContent = me.mag;
    dom.ammoReserve.textContent = `/ ${me.reserve}`;
    dom.reloadHint.classList.toggle('hidden', !(me.reloadMs > 0));
  }
  for (const el of dom.weaponSlots.children) {
    el.classList.toggle('active', Number(el.dataset.weapon) === me.weapon);
  }

  // 자세 표시(정조준/앉기/달리기/공중)
  if (dom.stanceBadge) {
    const tags = [];
    if (me.ads) tags.push('정조준');
    if (!me.grounded) tags.push('공중');
    else if (me.crouch) tags.push('앉기');
    else if (me.sprint) tags.push('달리기');
    dom.stanceBadge.textContent = tags.join(' · ');
    dom.stanceBadge.classList.toggle('hidden', tags.length === 0);
  }

  // 생존 / 라운드 (배틀로얄: 킬 목표 없음, 생존자 수가 곧 규칙)
  const roundState = state.round ? state.round.state : 'waiting';
  if (state.round) {
    dom.aliveCount.textContent = state.aliveCount;
    if (roundState === 'live') {
      const t = state.round.timeLeft;
      dom.roundTime.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      dom.roundKills.textContent = `${me.kills}킬 · ${state.round.index}라운드`;
    } else if (roundState === 'ended') {
      dom.roundTime.textContent = '라운드 종료';
      dom.roundKills.textContent = `${me.kills}킬`;
    } else {
      dom.roundTime.textContent = '워밍업';
      dom.roundKills.textContent = `${me.kills}킬`;
    }
  }

  // 워밍업 배너: 혼자 있을 때는 라운드가 시작되지 않는다.
  const waiting = roundState === 'waiting';
  dom.waitBanner.classList.toggle('hidden', !(state.phase === 'playing' && waiting));
  if (waiting && state.round) {
    dom.waitCount.textContent = `${state.round.total} / ${state.round.need}`;
  }

  // 존: 1/3 ~ 3/3 단계로 표시한다(서버 stage 0 = 첫 단계 대기).
  if (state.zone) {
    const seconds = Math.max(0, Math.ceil(state.zone.nextIn / 1000));
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, '0');
    dom.zoneTimer.textContent = `${mm}:${ss}`;
    const stageNo = Math.min(3, Math.max(1, state.zone.stage || 0));
    if (state.zone.stage >= 3 && seconds === 0) dom.zoneLabel.textContent = '최종 구역';
    else if (state.zone.shrinking) dom.zoneLabel.textContent = `구역 축소 중 (${stageNo}/3)`;
    else dom.zoneLabel.textContent = `안전 구역 ${stageNo}/3`;
    dom.zoneBox.classList.toggle('shrinking', Boolean(state.zone.shrinking));
  }

  // 구역 밖 경고: 실제 피해가 들어가는 상태(라운드 진행 중)에만 띄운다.
  const zoneOutside =
    Boolean(state.zone) &&
    state.phase === 'playing' &&
    me.alive &&
    roundState === 'live' &&
    Math.hypot(me.x - state.zone.centerX, me.z - state.zone.centerZ) > state.zone.radius;
  dom.zoneWarning.classList.toggle('hidden', !zoneOutside);

  // 탈락(관전) 오버레이 — 배틀로얄은 라운드 중 리스폰이 없다.
  const roundEnded = Boolean(state.round && state.round.state === 'ended');
  const spectator = Boolean(state.phase === 'playing' && !me.alive && !roundEnded);
  dom.dead.classList.toggle('hidden', !spectator);
  if (spectator) {
    if (state.myKiller) {
      const weaponLabel = WEAPON_LABELS[state.myKiller.weapon] || '';
      dom.deadTitle.textContent = '탈락';
      dom.deadTimer.textContent = state.myKiller.name
        ? `${state.myKiller.name} 님에게${weaponLabel ? ` [${weaponLabel}]` : ''} 탈락했습니다`
        : '구역 밖에서 탈락했습니다';
      dom.deadHint.textContent = `남은 생존자 ${state.aliveCount}명 · 라운드가 끝날 때까지 리스폰되지 않습니다. 다음 라운드에서 다시 시작합니다.`;
    } else {
      // 진행 중인 라운드에 새로 들어온 플레이어는 다음 라운드부터 참여한다.
      dom.deadTitle.textContent = '관전';
      dom.deadTimer.textContent = '진행 중인 라운드에 입장했습니다';
      dom.deadHint.textContent = `남은 생존자 ${state.aliveCount}명 · 다음 라운드가 시작되면 함께 참여합니다.`;
    }
  }

  // 모바일 조작부는 살아 있을 때만 보인다(탈락·결과 화면에서 잘못 누르지 않게).
  if (isTouch) {
    dom.touchControls.classList.toggle('hidden', !(state.phase === 'playing' && me.alive && !roundEnded));
  }

  // 탈락 중에는 마우스 고정 안내가 관전 화면을 가리지 않도록 감춘다.
  if (!me.alive && !dom.pause.classList.contains('hidden')) dom.pause.classList.add('hidden');

  const resultOpen = Boolean(state.round && state.round.state === 'ended' && state.phase === 'playing');
  if (resultOpen && !state.resultShown) {
    // 결과 창이 처음 열릴 때 마우스 고정을 풀어 버튼을 누를 수 있게 한다.
    state.resultShown = true;
    state.suppressPauseUntil = performance.now() + 1500;
    if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
  }
  if (!resultOpen) state.resultShown = false;
  dom.result.classList.toggle('hidden', !resultOpen);
  if (resultOpen) {
    if (state.round.winner) {
      const mine = state.round.winnerId === state.myId;
      dom.resultTitle.textContent = mine ? '승리!' : me.alive ? '라운드 종료' : '패배';
      const how = state.round.reason === 'timeout' ? '시간 종료 · HP 우세로' : '마지막 생존자로';
      dom.resultDetail.textContent = `${state.round.winner} 님이 ${how} 승리했습니다. (${state.round.winnerKills}킬 · HP ${state.round.winnerHp})`;
    } else {
      dom.resultTitle.textContent = '무승부';
      dom.resultDetail.textContent = '이번 라운드는 승자가 없습니다.';
    }
    dom.resultCountdown.textContent = `${state.round.nextIn}초 후 자동으로 다음 라운드가 시작됩니다. 전원 부활·탄약·구역이 초기화됩니다. (${state.round.ready}/${state.round.total} 준비)`;
  }

  // 라운드가 진행 중인데 마우스 고정이 풀려 있으면(결과 창·ESC) 재고정 버튼을 띄운다.
  if (
    state.phase === 'playing' &&
    !isTouch &&
    !state.lockUnavailable &&
    me.alive &&
    roundState === 'live' &&
    !resultOpen &&
    document.pointerLockElement !== dom.canvas &&
    dom.pause.classList.contains('hidden') &&
    performance.now() > state.suppressPauseUntil
  ) {
    showPause('조준 다시 고정', '라운드가 진행 중입니다. 계속하려면 마우스를 다시 고정하세요.');
  }

  dom.ping.textContent = net.rtt ? `${net.rtt}ms` : '--ms';
}

function isResultOpen() {
  return state.round && state.round.state === 'ended';
}

function showHitmarker(kill) {
  dom.hitmarker.classList.remove('show', 'kill');
  // 리플로우를 강제해 애니메이션을 재시작한다.
  void dom.hitmarker.offsetWidth;
  dom.hitmarker.classList.add('show');
  if (kill) dom.hitmarker.classList.add('kill');
}

function flashDamage() {
  dom.damageVignette.style.opacity = '1';
  window.setTimeout(() => {
    dom.damageVignette.style.opacity = '0';
  }, 140);
}

const WEAPON_LABELS = { rifle: '라이플', pistol: '권총', shotgun: '샷건', zone: '구역' };

function addKillFeed(ev) {
  const item = document.createElement('div');
  item.className = 'kf-item';

  if (ev.k === 'join') {
    item.textContent = `${ev.victim} 님이 입장했습니다.${ev.bot ? ' (AI)' : ''}`;
  } else if (ev.k === 'leave') {
    item.textContent = `${ev.victim} 님이 퇴장했습니다.`;
  } else if (ev.k === 'loot') {
    item.textContent = `${ev.victim} 님이 보급을 획득했습니다.`;
    item.classList.add('loot');
  } else {
    const weaponLabel = WEAPON_LABELS[ev.weapon] || ev.weapon || '';
    if (ev.killer) {
      item.innerHTML = '';
      const killer = document.createElement('span');
      killer.className = 'kf-killer';
      killer.textContent = ev.killer;
      const w = document.createElement('span');
      w.className = 'kf-weapon';
      w.textContent = `[${weaponLabel}]${ev.headshot ? ' 헤드' : ''}`;
      const victim = document.createElement('span');
      victim.className = 'kf-victim';
      victim.textContent = ev.victim;
      item.append(killer, w, victim);
    } else {
      item.textContent = `${ev.victim} 님이 구역 밖에서 사망했습니다.`;
      item.classList.add('zone-kill');
    }
    if (ev.killerId === state.myId) item.classList.add('mine');
  }

  dom.killfeed.appendChild(item);
  while (dom.killfeed.children.length > 6) dom.killfeed.removeChild(dom.killfeed.firstChild);
  window.setTimeout(() => {
    if (item.parentElement) item.parentElement.removeChild(item);
  }, 5200);
}

function showDisconnected(reason) {
  state.phase = 'disconnected';
  dom.disconnectedReason.textContent = reason;
  dom.disconnected.classList.remove('hidden');
  dom.hud.classList.add('hidden');
  dom.pause.classList.add('hidden');
  dom.result.classList.add('hidden');
  dom.dead.classList.add('hidden');
}

/* ── 메뉴 & 접속 ──────────────────────────────────────────── */
function setupMenu() {
  const savedName = localStorage.getItem('3dfp.name') || '';
  if (savedName) dom.nameInput.value = savedName;

  // 자동 줍기 옵션(기본 켜짐) — 서버가 범위/효과를 다시 판정하므로 안전하다.
  const savedAuto = localStorage.getItem('3dfp.autoPickup');
  state.autoPickup = savedAuto === null ? true : savedAuto === '1';
  if (dom.autoPickup) {
    dom.autoPickup.checked = state.autoPickup;
    dom.autoPickup.addEventListener('change', () => {
      state.autoPickup = dom.autoPickup.checked;
      localStorage.setItem('3dfp.autoPickup', state.autoPickup ? '1' : '0');
    });
  }

  const botSetup = () => ({
    bots: Math.max(0, Math.min(7, Number(dom.botCount?.value) || 0)),
    fillBots: Boolean(dom.botFill?.checked),
    difficulty: dom.botDifficulty?.value || 'normal',
  });

  const tryJoin = async ({ create = false, code = null, bots = 0, fillBots = false, difficulty = 'normal' } = {}) => {
    hideMenuError();
    if (!net.connected) {
      setLoading(true, '서버에 연결 중…');
      try {
        await net.connect();
      } catch (err) {
        setLoading(false);
        showMenuError('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
    }
    const name = dom.nameInput.value.trim();
    if (name) localStorage.setItem('3dfp.name', name);
    setLoading(true, create ? '방을 만드는 중…' : '방에 참여하는 중…');
    state.phase = 'connecting';
    const payload = { t: 'join', name, create, code };
    if (create) {
      payload.bots = bots;
      payload.fillBots = fillBots;
      payload.difficulty = difficulty;
    }
    net.send(payload);
    // 응답이 없으면 8초 뒤 되돌린다.
    window.setTimeout(() => {
      if (state.phase === 'connecting') {
        setLoading(false);
        state.phase = 'menu';
        showMenuError('응답이 없습니다. 다시 시도해 주세요.');
      }
    }, 8000);
  };

  dom.btnJoin.addEventListener('click', () => {
    audio.uiClick();
    const code = dom.codeInput.value.trim().toUpperCase();
    tryJoin({ code: code || null });
  });

  dom.btnQuick.addEventListener('click', () => {
    audio.uiClick();
    dom.codeInput.value = '';
    tryJoin({});
  });

  dom.btnCreate.addEventListener('click', () => {
    audio.uiClick();
    tryJoin({ create: true, ...botSetup() });
  });

  // AI 연습: 봇 3명(보통)과 바로 시작하는 방을 만든다.
  dom.btnAi.addEventListener('click', () => {
    audio.uiClick();
    tryJoin({ create: true, bots: 3, fillBots: false, difficulty: 'normal' });
  });

  dom.codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dom.btnJoin.click();
    }
  });

  dom.codeInput.addEventListener('input', () => {
    dom.codeInput.value = dom.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });

  dom.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dom.btnJoin.click();
    }
  });

  dom.btnReady.addEventListener('click', () => {
    net.send({ t: 'ready' });
    dom.btnReady.disabled = true;
    window.setTimeout(() => {
      dom.btnReady.disabled = false;
    }, 3000);
  });

  dom.btnReconnect.addEventListener('click', () => window.location.reload());
}

/* ── 프레임 루프 ──────────────────────────────────────────── */
const clock = new THREE.Clock();
let lastMoveSend = 0;

function moveLocal(dt) {
  const me = state.me;
  const cfg = state.config;
  let mx = 0;
  let mz = 0;

  if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) mz += 1;
  if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) mz -= 1;
  if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) mx += 1;
  if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) mx -= 1;

  if (state.touchMove.active) {
    mx += state.touchMove.x;
    mz -= state.touchMove.y;
  }

  // 자세/달리기 상태를 입력에서 계산한다(서버에 함께 보내 탄퍼짐·속도·피격 박스에 쓰인다).
  me.crouch = Boolean(state.keys.has('KeyC') || state.keys.has('ControlLeft') || state.touchCrouch);
  const shiftHeld = state.keys.has('ShiftLeft') || state.keys.has('ShiftRight');

  const len = Math.hypot(mx, mz);
  me.sprint = Boolean(shiftHeld && !me.crouch && !me.ads && len > 0.1);
  if (len < 0.02) return false;
  if (len > 1) {
    mx /= len;
    mz /= len;
  }

  const base = cfg ? cfg.maxSpeed : 6;
  let speed = base;
  if (me.sprint) speed *= cfg?.sprintMultiplier ?? 1.28;
  if (me.crouch) speed *= cfg?.crouchMultiplier ?? 0.55;
  if (me.ads) speed *= cfg?.adsMultiplier ?? 0.72;
  state.speedRatio = speed / base;

  const sin = Math.sin(me.yaw);
  const cos = Math.cos(me.yaw);
  // 전방 = (-sin, -cos), 오른쪽 = (cos, -sin)
  const dirX = -sin * mz + cos * mx;
  const dirZ = -cos * mz - sin * mx;

  let nx = me.x + dirX * speed * dt;
  let nz = me.z + dirZ * speed * dt;

  if (state.map) {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const cover of state.map.covers) {
        // 엄폐물 위(발이 윗면 이상)에 있으면 측면 충돌을 무시한다(위로 올라서거나 지나갈 수 있다).
        if (me.y >= cover.h - 0.05) continue;
        const halfW = cover.w / 2;
        const halfD = cover.d / 2;
        const minX = cover.x - halfW;
        const maxX = cover.x + halfW;
        const minZ = cover.z - halfD;
        const maxZ = cover.z + halfD;
        const cx = Math.max(minX, Math.min(nx, maxX));
        const cz = Math.max(minZ, Math.min(nz, maxZ));
        const dx = nx - cx;
        const dz = nz - cz;
        const distSq = dx * dx + dz * dz;
        const r = 0.45;
        if (distSq < r * r && distSq > 1e-9) {
          const dist = Math.sqrt(distSq);
          nx += (dx / dist) * (r - dist);
          nz += (dz / dist) * (r - dist);
        }
      }
    }
    const limit = state.map.arena.half - 0.45;
    nx = Math.max(-limit, Math.min(limit, nx));
    nz = Math.max(-limit, Math.min(limit, nz));
  }

  me.x = nx;
  me.z = nz;
  return true;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  if (!renderer || !scene || !camera) return;

  if (state.phase === 'playing') {
    const paused = isPaused();
    const me = state.me;
    state.movingNow = false;

    if (me.alive && !paused && !state.needSnap) {
      const moving = moveLocal(dt);
      state.movingNow = moving;
      stepVertical(dt);
      if (moving && me.grounded && now - state.lastStepAt > (me.sprint ? 300 : 420)) {
        state.lastStepAt = now;
        audio.footstep(Math.floor(now / (me.sprint ? 300 : 420)));
      }
    } else if (!me.alive && !state.needSnap) {
      me.y = 0;
      me.vy = 0;
      me.grounded = true;
    }

    // 정조준은 라운드 중·생존 상태에서만 유지된다.
    if (me.ads && !canPlay()) setAds(false);
    // 달리기/앉기 중에는 정조준을 풀지 않고, 정조준 중 달리기는 입력에서 막혔다.

    // ── 카메라(눈높이·봅·착지 딥·화각) ──
    const eyeTarget = me.crouch ? (state.config?.crouchEyeHeight ?? 1.02) : (state.config?.eyeHeight ?? 1.62);
    me.eye += (eyeTarget - me.eye) * Math.min(1, dt * 14);
    state.landDip += (0 - state.landDip) * Math.min(1, dt * 9);
    state.viewKick += (0 - state.viewKick) * Math.min(1, dt * 15);

    const bobSpeed = 8.2 * (me.sprint ? 1.35 : 1);
    if (state.movingNow && me.grounded) state.bobT += dt * bobSpeed;
    const bobAmp = (me.ads ? 0.3 : 1) * (state.movingNow && me.grounded ? 1 : 0);
    const bobY = Math.sin(state.bobT * 2) * 0.013 * bobAmp;
    const bobX = Math.cos(state.bobT) * 0.011 * bobAmp;

    camera.position.set(me.x + bobX, me.y + me.eye + bobY - state.landDip, me.z);
    camera.rotation.y = me.yaw;
    camera.rotation.x = me.pitch;

    const weapon = currentWeapon();
    const targetFov = me.ads ? (weapon?.adsFov ?? 60) : (state.config?.baseFov ?? 78);
    if (Math.abs(camera.fov - targetFov) > 0.04) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 13);
      camera.updateProjectionMatrix();
    }
    me.fov = camera.fov;

    // ── 1인칭 무기(정조준 중앙 정렬 · 봅 · 반동) ──
    if (viewmodel) {
      const g = viewmodel.group;
      const k = Math.min(1, dt * 15);
      const tx = me.ads ? 0 : 0.26;
      const ty = (me.ads ? -0.125 : -0.24) + bobY * 2.2 - state.landDip * 0.4;
      const tz = (me.ads ? -0.3 : -0.42) + state.viewKick;
      g.position.x += (tx - g.position.x) * k;
      g.position.y += (ty - g.position.y) * k;
      g.position.z += (tz - g.position.z) * k;
      g.rotation.x = state.viewKick * 2.2 + (me.sprint ? 0.06 : 0);
      g.rotation.y = me.ads ? 0 : 0.02;
      g.visible = me.alive;
    }

    // 자동 사격
    if (state.firing && me.alive && !paused) {
      const autoWeapon = currentWeapon();
      if (autoWeapon && autoWeapon.auto) attemptShoot(now);
    }

    // 이동 패킷 (20Hz) — 서버가 위치를 확정하기 전, 그리고 살아 있을 때만 보낸다.
    if (me.alive && !state.needSnap && now - lastMoveSend >= 50) {
      lastMoveSend = now;
      net.send({
        t: 'm',
        x: state.me.x,
        y: state.me.y,
        z: state.me.z,
        yaw: state.me.yaw,
        pitch: state.me.pitch,
        crouch: state.me.crouch,
    keys: [...state.keys],
        sprint: state.me.sprint,
        ads: state.me.ads,
      });
    }

    // 원격 플레이어 보간(y 포함 — 점프/엄폐물 위 이동이 그대로 보인다)
    const renderTime = now - VIEW_DELAY_MS;
    for (const avatar of state.avatars.values()) {
      if (!avatar.group.visible) continue;
      const sample = sampleAvatar(avatar, renderTime);
      if (!sample) continue;
      avatar.group.position.set(sample.x, sample.y || 0, sample.z);
      avatar.group.rotation.y = sample.yaw;
      avatar.head.rotation.x = -sample.pitch;
      avatar.gun.rotation.x = -sample.pitch;
    }

    updateLootSpinner(dt);
    updateLoot(now);
    updateCrosshair(dt);
    drawCompass();
    drawMinimap(now);

    // 존 시각화: 안·밖 어디서나 보이도록 벽을 은은하게 띄우고, 축소 중에는 색을 바꾼다.
    if (state.zone && zoneWall && zoneEdge) {
      const target = state.zone.radius;
      const current = zoneWall.scale.x;
      const next = current + (target - current) * 0.18;
      zoneWall.scale.set(next, 30, next);
      zoneWall.position.set(state.zone.centerX, 15, state.zone.centerZ);
      zoneEdge.scale.set(next, next, 1);
      zoneEdge.position.set(state.zone.centerX, 0.06, state.zone.centerZ);
      const outside = Math.hypot(state.me.x - state.zone.centerX, state.me.z - state.zone.centerZ) > target;
      zoneWall.material.opacity = outside ? 0.24 : 0.12;
      const shrinking = Boolean(state.zone.shrinking);
      zoneWall.material.color.setHex(shrinking ? 0xfbbf24 : 0x38bdf8);
      zoneEdge.material.color.setHex(shrinking ? 0xfbbf24 : outside ? 0xf87171 : 0x7dd3fc);
      zoneEdge.material.opacity = outside ? 0.95 : 0.8;
    }
  }

  updateEffects(now);
  renderer.render(scene, camera);
}

/* ── 부트스트랩 ───────────────────────────────────────────── */
async function boot() {
  setupMenu();
  setupInput();
  setupNet();
  setupSoundToggle();

  if (renderer) {
    try {
      const map = await loadMap();
      state.map = map;
      buildWorld(map);
      initMuzzleEffects();
      setViewmodel(1);
      animate();
    } catch (err) {
      console.error('[3dfp] 월드 구성 실패', err);
      showMenuError('맵을 불러오지 못했습니다. 새로 고침해 주세요.');
      window.showBootError?.('맵 데이터를 불러오지 못했습니다. 서버 상태를 확인하고 새로 고침해 주세요.');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.keys.clear();
      state.firing = false;
      state.dragLook = false;
    }
  });

  // 테스트/디버그용 읽기 전용 훅(값을 바꾸지 않는다).
  window.__3dfpDebug = () => ({
    phase: state.phase,
    y: state.me.y,
    vy: state.me.vy,
    grounded: state.me.grounded,
    ads: state.me.ads,
    crouch: state.me.crouch,
    keys: [...state.keys],
    sprint: state.me.sprint,
    fov: camera ? camera.fov : 0,
    eye: state.me.eye,
    yaw: state.me.yaw,
    pitch: state.me.pitch,
    weapon: state.me.weapon,
    owned: state.owned,
    kits: state.me.kits,
    hp: state.me.hp,
    lootOpen: state.lootOpen,
    loot: state.config ? state.config.loot : [],
    lootRange: state.config ? state.config.lootRange : 0,
    muted: state.muted,
    lockUnavailable: state.lockUnavailable,
    locked: document.pointerLockElement === dom.canvas,
    bots: state.round ? state.round.bots : 0,
    total: state.round ? state.round.total : 0,
  });
  window.__3dfpLockMode = () => (state.lockUnavailable ? 'drag' : document.pointerLockElement ? 'locked' : 'idle');

  // 부트스트랩이 끝났음은 index.html의 대기 경보(importmap/모듈 로드 실패 배너)에 알린다.
  window.__3dfpBooted = true;
}

boot();
