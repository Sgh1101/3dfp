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
  pause: document.getElementById('pause'),
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
};

const VIEW_DELAY_MS = 90; // 원격 플레이어 보간 지연
const MOUSE_SENSITIVITY = 0.0022;

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
  },
  zone: null,
  round: null,
  aliveCount: 1,
  suppressPauseUntil: 0,
  resultShown: false,
  myName: '',
  needSnap: true,
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

  const hemi = new THREE.HemisphereLight(0xa8d8ff, 0x1c2b26, 1.05);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xfff0d4, 1.25);
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

  const ambient = new THREE.AmbientLight(0x25333c, 0.55);
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
  ctx.fillStyle = '#161e25';
  ctx.fillRect(0, 0, size, size);

  const tile = 64;
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const shade = 0.02 + Math.random() * 0.06;
      ctx.fillStyle = `rgba(255,255,255,${shade.toFixed(3)})`;
      ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);
    }
  }
  ctx.strokeStyle = 'rgba(80, 200, 170, 0.18)';
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

  const edgeGeo = new THREE.RingGeometry(0.985, 1.0, 128);
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
function nameSprite(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 30px "Pretendard", "Malgun Gothic", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 34);
  ctx.fillStyle = '#a7f3d0';
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

function createAvatar(id, name) {
  const group = new THREE.Group();
  const color = hashColor(id);

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
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
    new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: 0x34d399, emissiveIntensity: 0.6 }),
  );
  visor.position.set(0, 1.66, -0.22);
  group.add(visor);

  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.1, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1f2933, roughness: 0.5, metalness: 0.6 }),
  );
  gun.position.set(0.26, 1.2, -0.28);
  group.add(gun);

  const label = nameSprite(name);
  group.add(label);

  scene.add(group);
  const avatar = { id, name, group, head, gun, label, buffer: [], lastSeen: performance.now() };
  state.avatars.set(id, avatar);
  return avatar;
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

function pushSample(avatar, x, z, yaw, pitch, now) {
  const buf = avatar.buffer;
  const last = buf[buf.length - 1];
  if (last && Math.abs(last.x - x) < 0.01 && Math.abs(last.z - z) < 0.01 && Math.abs(last.yaw - yaw) < 0.01) {
    return;
  }
  buf.push({ t: now, x, z, yaw, pitch });
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
        z: a.z + (b.z - a.z) * k,
        yaw: lerpAngle(a.yaw, b.yaw, k),
        pitch: a.pitch + (b.pitch - a.pitch) * k,
      };
    }
  }
  return buf[buf.length - 1];
}

/* ── 입력 ─────────────────────────────────────────────────── */
function setupInput() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) {
      state.keys.add(e.code);
      return;
    }
    state.keys.add(e.code);

    if (state.phase !== 'playing') return;
    switch (e.code) {
      case 'KeyR':
        requestReload();
        break;
      case 'KeyE':
        requestSwap();
        break;
      case 'KeyQ':
        requestHeal();
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
  });

  // 마우스 시점
  document.addEventListener('mousemove', (e) => {
    if (state.phase !== 'playing') return;
    if (document.pointerLockElement !== dom.canvas) return;
    if (state.ignoreMoves > 0) {
      state.ignoreMoves -= 1;
      return;
    }
    if (Math.abs(e.movementX) > 260 || Math.abs(e.movementY) > 260) return; // 잠금 직후 튀는 값 무시
    addLook(e.movementX, e.movementY);
  });

  // PC: 잠금 상태에서 클릭 = 사격 / 잠금 전 클릭 = 잠금
  dom.canvas.addEventListener('mousedown', (e) => {
    if (state.phase !== 'playing' || isTouch) return;
    if (e.button !== 0) return;
    if (document.pointerLockElement !== dom.canvas) {
      requestLock();
      return;
    }
    audio.resume();
    state.firing = true;
    attemptShoot(performance.now());
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firing = false;
  });

  dom.canvas.addEventListener('click', () => {
    if (state.phase === 'playing' && !isTouch && document.pointerLockElement !== dom.canvas) requestLock();
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === dom.canvas;
    if (locked) {
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
      dom.pause.classList.remove('hidden');
      state.firing = false;
    }
  });

  dom.pause.addEventListener('click', () => requestLock());

  // 모바일: 오른쪽 화면 드래그로 시점 회전
  dom.canvas.addEventListener('pointerdown', (e) => {
    if (!isTouch || state.phase !== 'playing') return;
    if (e.clientX < window.innerWidth * 0.35) return;
    state.look.pointerId = e.pointerId;
    state.look.lastX = e.clientX;
    state.look.lastY = e.clientY;
  });

  dom.canvas.addEventListener('pointermove', (e) => {
    if (!isTouch || state.phase !== 'playing') return;
    if (state.look.pointerId !== e.pointerId) return;
    const dx = e.clientX - state.look.lastX;
    const dy = e.clientY - state.look.lastY;
    state.look.lastX = e.clientX;
    state.look.lastY = e.clientY;
    addLook(dx * 1.7, dy * 1.7);
  });

  const endLook = (e) => {
    if (state.look.pointerId === e.pointerId) state.look.pointerId = null;
  };
  dom.canvas.addEventListener('pointerup', endLook);
  dom.canvas.addEventListener('pointercancel', endLook);

  // 모바일 조이스틱
  if (isTouch) {
    dom.touchControls.classList.remove('hidden');
  }

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
    dom.joystick.setPointerCapture?.(e.pointerId);
    updateJoystick(e.clientX, e.clientY);
    audio.resume();
  });
  dom.joystick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joystickId) return;
    updateJoystick(e.clientX, e.clientY);
  });
  dom.joystick.addEventListener('pointerup', resetJoystick);
  dom.joystick.addEventListener('pointercancel', resetJoystick);

  // 모바일 버튼 (동시 멀티터치 지원: 각 버튼이 독립적으로 pointer 이벤트 처리)
  const bindHoldButton = (el, onDown, onUp) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('pressed');
      el.setPointerCapture?.(e.pointerId);
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

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120));

  // 첫 사용자 제스처에서 오디오 활성화
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
}

function addLook(dx, dy) {
  state.me.yaw -= dx * MOUSE_SENSITIVITY;
  state.me.pitch -= dy * MOUSE_SENSITIVITY;
  state.me.pitch = Math.max(-1.45, Math.min(1.45, state.me.pitch));
  if (state.me.yaw > Math.PI) state.me.yaw -= Math.PI * 2;
  if (state.me.yaw < -Math.PI) state.me.yaw += Math.PI * 2;
}

function requestLock() {
  if (isTouch) return;
  if (document.pointerLockElement === dom.canvas) return;
  const promise = dom.canvas.requestPointerLock?.();
  if (promise && typeof promise.catch === 'function') promise.catch(() => {});
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
  net.send({ t: 'shoot', yaw: state.me.yaw, pitch: state.me.pitch });
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

/* ── 네트워크 처리 ────────────────────────────────────────── */
function setupNet() {
  net.on('welcome', onWelcome);
  net.on('s', onSnapshot);
  net.on('ev', onEvents);
  net.on('corr', (msg) => {
    state.me.x = msg.x;
    state.me.z = msg.z;
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
  buildWeaponSlots();

  const spawn = msg.map?.spawns?.[0];
  // 위치는 첫 스냅샷(서버 권위)으로 확정한다.
  state.needSnap = true;
  if (spawn) {
    state.me.x = spawn.x;
    state.me.z = spawn.z;
  }
  // 서버 스냅샷이 곧 위치를 확정한다.
  const weapon = currentWeapon();
  setViewmodel(state.me.weapon || 1);
  if (weapon) state.me.mag = weapon.mag;

  setLoading(false);
  audio.resume();
  if (!isTouch) {
    requestLock();
    if (document.pointerLockElement !== dom.canvas) {
      dom.pause.classList.remove('hidden');
    }
  }
}

function onSnapshot(snap) {
  state.zone = snap.zone;
  state.round = snap.round;
  state.aliveCount = snap.alive;
  const now = performance.now();
  const seen = new Set();

  for (const entry of snap.players) {
    const [id, name, x, , z, yaw, pitch, hp, aliveFlag, weapon, mag, reserve, kills, deaths, protectFlag, reloadMs, kits] = entry;
    seen.add(id);
    const alive = aliveFlag === 1;

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
        me.z = z;
        me.yaw = yaw;
        me.pitch = pitch;
        me.alive = alive;
      }

      if (!wasAlive && alive) {
        me.x = x;
        me.z = z;
        me.yaw = yaw;
        me.pitch = pitch;
        me.reloadMs = 0;
      }
      if (wasAlive && !alive) {
        state.firing = false;
        cancelLocalReload();
      }
    } else {
      let avatar = state.avatars.get(id);
      if (!avatar) avatar = createAvatar(id, name);
      avatar.lastSeen = now;
      if (alive) {
        avatar.group.visible = true;
        pushSample(avatar, x, z, yaw, pitch, now);
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
          showHitmarker(false);
          audio.hitmarker();
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
        }
        if (ev.victimId === state.myId) {
          state.firing = false;
          state.suppressPauseUntil = performance.now() + 1200;
        }
        break;
      }
      case 'join':
        if (ev.id !== state.myId) addKillFeed({ k: 'join', victim: ev.name });
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
          cancelLocalReload();
        } else if (ev.phase === 'waiting') {
          dom.result.classList.add('hidden');
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

  // 존
  if (state.zone) {
    const seconds = Math.ceil(state.zone.nextIn / 1000);
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, '0');
    dom.zoneTimer.textContent = `${mm}:${ss}`;
    dom.zoneLabel.textContent = state.zone.shrinking ? '구역 축소 중' : `안전 구역 ${state.zone.stage}/3`;
    dom.zoneBox.classList.toggle('shrinking', Boolean(state.zone.shrinking));
  }

  // 탈락(관전) 오버레이 — 배틀로얄은 라운드 중 리스폰이 없다.
  const roundEnded = Boolean(state.round && state.round.state === 'ended');
  const spectator = Boolean(state.phase === 'playing' && !me.alive && !roundEnded);
  dom.dead.classList.toggle('hidden', !spectator);
  if (spectator) {
    dom.deadTitle.textContent = '탈락';
    dom.deadTimer.textContent = '생존자 관전 중';
    dom.deadHint.textContent = `남은 생존자 ${state.aliveCount}명 · 라운드가 끝날 때까지 리스폰되지 않습니다. 다음 라운드에서 다시 시작합니다.`;
  }

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
      dom.resultTitle.textContent = mine ? '승리!' : '라운드 종료';
      const how = state.round.reason === 'timeout' ? '시간 종료 · HP 우세로' : '마지막 생존자로';
      dom.resultDetail.textContent = `${state.round.winner} 님이 ${how} 승리했습니다. (${state.round.winnerKills}킬 · HP ${state.round.winnerHp})`;
    } else {
      dom.resultTitle.textContent = '무승부';
      dom.resultDetail.textContent = '이번 라운드는 승자가 없습니다.';
    }
    dom.resultCountdown.textContent = `${state.round.nextIn}초 후 자동으로 다음 라운드가 시작됩니다. 전원 부활·탄약·구역이 초기화됩니다. (${state.round.ready}/${state.round.total} 준비)`;
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
    item.textContent = `${ev.victim} 님이 입장했습니다.`;
  } else if (ev.k === 'leave') {
    item.textContent = `${ev.victim} 님이 퇴장했습니다.`;
  } else {
    const weaponLabel = WEAPON_LABELS[ev.weapon] || ev.weapon || '';
    if (ev.killer) {
      item.innerHTML = '';
      const killer = document.createElement('span');
      killer.className = 'kf-killer';
      killer.textContent = ev.killer;
      const w = document.createElement('span');
      w.className = 'kf-weapon';
      w.textContent = `[${weaponLabel}]`;
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

  const tryJoin = async ({ create = false, code = null } = {}) => {
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
    net.send({ t: 'join', name, create, code });
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
    tryJoin({ create: true });
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

  const len = Math.hypot(mx, mz);
  if (len < 0.02) return false;
  if (len > 1) {
    mx /= len;
    mz /= len;
  }

  const speed = state.config ? state.config.maxSpeed : 6;
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
    const paused = !isTouch && !dom.pause.classList.contains('hidden');
    if (state.me.alive && !paused && !state.needSnap) {
      const moving = moveLocal(dt);
      if (moving && now - state.lastStepAt > 420) {
        state.lastStepAt = now;
        audio.footstep(Math.floor(now / 420));
      }
    }

    camera.position.set(state.me.x, state.me.y + (state.config ? state.config.eyeHeight : 1.62), state.me.z);
    camera.rotation.y = state.me.yaw;
    camera.rotation.x = state.me.pitch;

    // 자동 사격
    if (state.firing && state.me.alive && !paused) {
      const weapon = currentWeapon();
      if (weapon && weapon.auto) attemptShoot(now);
    }

    // 이동 패킷 (20Hz) — 서버가 위치를 확정하기 전, 그리고 살아 있을 때만 보낸다.
    if (state.me.alive && !state.needSnap && now - lastMoveSend >= 50) {
      lastMoveSend = now;
      net.send({ t: 'm', x: state.me.x, z: state.me.z, yaw: state.me.yaw, pitch: state.me.pitch });
    }

    // 원격 플레이어 보간
    const renderTime = now - VIEW_DELAY_MS;
    for (const avatar of state.avatars.values()) {
      if (!avatar.group.visible) continue;
      const sample = sampleAvatar(avatar, renderTime);
      if (!sample) continue;
      avatar.group.position.set(sample.x, 0, sample.z);
      avatar.group.rotation.y = sample.yaw;
      avatar.head.rotation.x = -sample.pitch;
      avatar.gun.rotation.x = -sample.pitch;
    }

    // 존 시각화
    if (state.zone && zoneWall && zoneEdge) {
      const target = state.zone.radius;
      const current = zoneWall.scale.x;
      const next = current + (target - current) * 0.18;
      zoneWall.scale.set(next, 30, next);
      zoneWall.position.set(state.zone.centerX, 15, state.zone.centerZ);
      zoneEdge.scale.set(next, next, 1);
      zoneEdge.position.set(state.zone.centerX, 0.06, state.zone.centerZ);
      const outside = Math.hypot(state.me.x - state.zone.centerX, state.me.z - state.zone.centerZ) > target;
      zoneWall.material.opacity = outside ? 0.16 : 0.07;
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
    }
  });

  // 부트스트랩이 끝났음은 index.html의 대기 감시(importmap/모듈 로드 실패 배너)에 알린다.
  window.__3dfpBooted = true;
}

boot();
