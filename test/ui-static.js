'use strict';

/**
 * 정적 UI/온보딩/모바일 레이아웃 무결성 검사 (브라우저 없이 소스만 검사).
 *
 * 실제 브라우저를 띄우지 못하는 환경에서도 다음을 보장한다.
 *  - index.html · main.js · style.css 사이의 id/선택자 계약이 어긋나지 않는다.
 *  - 온보딩(닉네임/방 코드/조작법)과 HUD·오버레이 요소가 모두 존재한다.
 *  - 모바일 안전 영역(env(safe-area-inset-*))과 터치 조작(독립 pointer id)이 갖춰져 있다.
 *  - Three.js는 로컬 번들만 쓰고 외부 CDN 의존이 0이다(오프라인 실행 보장).
 *  - README/CREDITS에 실행 방법·조작법·라이선스가 빠짐없이 적혀 있다.
 *
 * 실행: node test/ui-static.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('public/index.html');
const css = read('public/css/style.css');
const js = read('public/js/main.js');
const net = read('public/js/net.js');
const readme = read('README.md');
const credits = read('CREDITS.md');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const section = (title) => console.log(`[ui-static] ${title}`);

/** index.html 의 id 목록 */
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(htmlIds);

/** main.js 의 dom 객체 키 */
const domBlock = js.slice(js.indexOf('const dom = {'), js.indexOf('};', js.indexOf('const dom = {')));
const domKeys = [...domBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
const domById = new Map(
  [...domBlock.matchAll(/^\s{2}(\w+): document\.getElementById\('([^']+)'\)/gm)].map((m) => [m[1], m[2]]),
);

// ───────────────────────────────────────────────────────────────────────────
section('문서 기본 구조');
test('한국어 문서 + 모바일 viewport(viewport-fit=cover)', () => {
  assert(/<html lang="ko">/.test(html), 'lang="ko" 가 없다');
  const viewport = html.match(/<meta name="viewport"[^>]*>/);
  assert(viewport, 'viewport 메타 태그가 없다');
  assert(viewport[0].includes('viewport-fit=cover'), 'viewport-fit=cover 가 없다(노치 대응)');
  assert(viewport[0].includes('user-scalable=no'), '게임 화면에서 확대가 막혀 있지 않다');
});

test('title/description/theme-color/favicon 이 있다', () => {
  assert(/<title>[^<]*3DFP/.test(html), 'title 이 없다');
  assert(/name="description"/.test(html), 'description 이 없다');
  assert(/name="theme-color"/.test(html), 'theme-color 가 없다');
  assert(/rel="icon"/.test(html), 'favicon 이 없다');
});

test('id 는 중복되지 않는다', () => {
  const dup = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
  assert(dup.length === 0, `중복 id: ${[...new Set(dup)].join(', ')}`);
});

test('label for 대상이 모두 존재한다', () => {
  for (const m of html.matchAll(/<label for="([^"]+)"/g)) {
    assert(idSet.has(m[1]), `label for="${m[1]}" 대상이 없다`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
section('온보딩 · 로비');
test('닉네임/방 코드 입력과 참여·빠른 참여·방 만들기 버튼이 있다', () => {
  assert(/id="name-input"[^>]*maxlength="16"/.test(html), '닉네임 입력(maxlength 16)이 없다');
  assert(/id="code-input"[^>]*maxlength="6"/.test(html), '방 코드 입력(maxlength 6)이 없다');
  for (const id of ['btn-join', 'btn-quick', 'btn-create']) {
    assert(new RegExp(`id="${id}"[^>]*type="button"`).test(html), `${id} 버튼이 없다`);
  }
  assert(/id="menu-error"[^>]*role="alert"/.test(html), '오류 표시 영역(role=alert)이 없다');
  assert(/id="menu-loading"/.test(html), '연결 중 표시가 없다');
});

test('한 페이지 조작법 안내(PC 7동작 + 모바일 안내)가 있다', () => {
  const guide = html.slice(html.indexOf('controls-guide'), html.indexOf('</section>', html.indexOf('controls-guide')));
  const items = [...guide.matchAll(/<li>/g)].length;
  assert(items >= 7, `조작법 항목이 ${items}개뿐이다`);
  for (const key of ['W A S D', '마우스', 'R', 'E', 'Q', 'ESC']) {
    assert(guide.includes(key), `조작법에 ${key} 항목이 없다`);
  }
  assert(guide.includes('모바일'), '모바일 조작 안내가 없다');
  assert(guide.includes('배틀로얄'), '배틀로얄 규칙 요약이 없다');
});

test('오류가 나도 입력값을 지우지 않는다(닉네임/방 코드 유지)', () => {
  const fn = js.slice(js.indexOf('function showMenuError'), js.indexOf('function hideMenuError'));
  assert(fn.includes('textContent'), '오류 메시지를 textContent 로 넣지 않는다');
  assert(!/nameInput\.value\s*=\s*''/.test(js), '오류 처리에서 닉네임을 지운다');
  assert(!/codeInput\.value\s*=\s*''/.test(fn), '오류 처리에서 방 코드를 지운다');
});

test('서버 오류 코드별 안내 문구가 사용자 말로 되어 있다', () => {
  const rooms = read('server/rooms.js');
  for (const code of ['ROOM_NOT_FOUND', 'ROOM_FULL', 'TOO_MANY_ROOMS']) {
    assert(rooms.includes(`${code}:`), `${code} 오류 정의가 없다`);
  }
  assert(/ROOM_NOT_FOUND: \{[^}]*코드/.test(rooms), 'ROOM_NOT_FOUND 안내에 방 코드 확인 문구가 없다');
  assert(/ROOM_FULL: \{[^}]*8명/.test(rooms), 'ROOM_FULL 안내에 정원(8명) 정보가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('HUD · 라운드 상태');
test('HUD 필수 요소가 모두 있다', () => {
  const ids = [
    'hud', 'zone-label', 'zone-timer', 'zone-warning',
    'round-time', 'round-kills', 'alive-count', 'room-code',
    'killfeed', 'wait-banner', 'wait-count',
    'crosshair', 'hitmarker',
    'hp-fill', 'hp-value', 'kits',
    'weapon-name', 'ammo-mag', 'ammo-reserve', 'weapon-slots',
    'reload-hint', 'damage-vignette', 'ping',
  ];
  for (const id of ids) assert(idSet.has(id), `HUD 요소 #${id} 가 없다`);
});

test('워밍업(waiting) 배너는 혼자일 때만 뜨도록 구현돼 있다', () => {
  assert(/waitBanner\.classList\.toggle\('hidden', !\(state\.phase === 'playing' && waiting\)\)/.test(js), 'waiting 상태에서만 배너를 켜지 않는다');
  assert(/roundState === 'waiting'/.test(js), 'waiting 상태 판정이 없다');
});

test('라운드 결과(intermission) 화면: 승자·킬·HP·준비 버튼·카운트다운', () => {
  for (const id of ['result', 'result-title', 'result-detail', 'result-countdown', 'btn-ready']) {
    assert(idSet.has(id), `결과 화면 요소 #${id} 가 없다`);
  }
  assert(/winnerKills/.test(js) && /winnerHp/.test(js), '승자 킬/HP 표시가 없다');
  assert(/nextIn\]초 후|nextIn}초 후/.test(js), '다음 라운드 카운트다운이 없다');
  assert(/btnReady/.test(js), '준비 버튼 처리가 없다');
});

test('탈락(관전) 화면은 화면을 가리지 않고 킬러·생존자 수를 보여 준다', () => {
  assert(/#dead \{[^}]*pointer-events: none/.test(css), '#dead 오버레이가 클릭을 막는다(관전 불가)');
  assert(/\.panel-small \{[^}]*pointer-events: auto/.test(css), '탈락 패널이 다시 클릭을 받지 못한다');
  const block = js.slice(js.indexOf('// 탈락(관전) 오버레이'), js.indexOf('// 모바일 조작부는'));
  assert(/myKiller/.test(block), '탈락 화면에 킬러 정보가 없다');
  assert(/남은 생존자 \$\{state\.aliveCount\}명/.test(block), '남은 생존자 수 표시가 없다');
});

test('존 단계(1/3~3/3)와 구역 밖 경고가 표시된다', () => {
  assert(/최종 구역/.test(js), '최종 구역 표시가 없다');
  assert(/안전 구역 \$\{stageNo\}\/3/.test(js), '1/3 형식 단계 표시가 없다');
  assert(/zoneWarning\.classList\.toggle\('hidden', !zoneOutside\)/.test(js), '구역 밖 경고 토글이 없다');
  assert(/\.zone-warning \{/.test(css), '구역 밖 경고 스타일이 없다');
});

test('재장전·탄약·힐 키트·무기 슬롯이 HUD에 반영된다', () => {
  assert(/dom\.reloadHint\.classList\.toggle\('hidden', !\(me\.reloadMs > 0\)\)/.test(js), '재장전 표시가 없다');
  assert(/ammoReserve\.textContent/.test(js), '예비 탄약 표시가 없다');
  assert(/힐 ×\$\{me\.kits\}/.test(js), '힐 키트 수 표시가 없다');
  assert(/buildWeaponSlots/.test(js), '무기 슬롯 표시가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('PointerLock · 일시정지');
test('ESC로 풀린 뒤 명확한 재고정 버튼으로 돌아온다', () => {
  assert(/id="btn-resume"/.test(html), '재고정 버튼(#btn-resume)이 없다');
  assert(/pointerlockchange/.test(js), 'pointerlockchange 처리이 없다');
  assert(/dom\.btnResume\.addEventListener\('click'/.test(js), '재고정 버튼 클릭 처리가 없다');
  assert(/function showPause\(/.test(js) && /function resumeFromPause\(/.test(js), '일시정지 표시/재개 함수가 없다');
});

test('잠금 직후 마우스 값이 튀지 않도록 보정한다', () => {
  assert(/state\.ignoreMoves = 2/.test(js), '잠금 직후 이동값 무시가 없다');
  assert(/Math\.abs\(e\.movementX\) > 300/.test(js), '비정상 movementX 필터가 없다');
});

test('PointerLock을 쓸 수 없는 환경에서는 드래그 시점으로 대체한다', () => {
  assert(/lockUnavailable/.test(js), '대체 모드 상태가 없다');
  assert(/onLockUnavailable/.test(js), '잠금 실패 처리 함수가 없다');
  assert(/state\.dragLook/.test(js), '드래그 시점 상태가 없다');
  // 잠금이 아예 안 되는 브라우저에서도 조준이 죽지 않도록 error/timeout 두 경로를 모두 둔다.
  assert(/pointerlockerror/.test(js), 'pointerlockerror 처리이 없다');
  assert(/LOCK_TIMEOUT_MS/.test(js), '잠금 실패 타임아웃이 없다');
  assert(/addLook\(dx, dy\)/.test(js), '드래그 시점 회전 경로가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('모바일 터치 · 안전 영역');
test('안전 영역(--safe-*, env(safe-area-inset-*))을 4방향 모두 반영한다', () => {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    assert(new RegExp(`env\\(safe-area-inset-${side}`).test(css), `safe-area-inset-${side} 가 없다`);
    assert(new RegExp(`--safe-${side[0]}:`).test(css), `--safe-${side[0]} 변수가 없다`);
  }
  assert(/\.hud-top \{[^}]*var\(--safe-t\)/.test(css), '상단 HUD가 안전 영역을 반영하지 않는다');
  assert(/\.hud-bottom \{[^}]*var\(--safe-b\)/.test(css), '하단 HUD가 안전 영역을 반영하지 않는다');
});

test('가상 조이스틱 + 사격/재장전/무기/힐 버튼이 있다', () => {
  for (const id of ['touch-controls', 'joystick', 'joystick-knob', 'btn-fire', 'btn-reload', 'btn-swap', 'btn-heal']) {
    assert(idSet.has(id), `터치 요소 #${id} 가 없다`);
  }
  assert(/\.joystick \{[^}]*pointer-events: auto/.test(css), '조이스틱이 터치를 받지 못한다');
  assert(/\.touch-btn \{[^}]*touch-action: none/.test(css), '버튼에 touch-action: none 이 없다');
});

test('멀티터치를 독립 pointer id 로 처리한다(조이스틱+시점+사격+점프 동시 입력)', () => {
  assert(/e\.pointerId/.test(js), 'pointerId 기반 처리가 없다');
  assert(/e\.pointerId !== joystickId/.test(js), '조이스틱 pointer id 추적이 없다');
  assert(/lookPointers/.test(js) && /lookPointers\.get\(e\.pointerId\)/.test(js), '시점 드래그 pointer id 추적이 없다');
  assert(/setPointerCapture/.test(js), 'pointer capture 로 동시 입력을 분리하지 않는다');
  assert(/pointercancel/.test(js), 'pointercancel 정리가 없다');
  assert(/lostpointercapture/.test(js), '포인터 캡처 해제 정리가 없다');
});

test('오른쪽 화면 드래그로 시점을 돌리고 왼쪽은 조이스틱 영역이다', () => {
  assert(/e\.clientX < window\.innerWidth \* 0\.22/.test(js), '시점 드래그 시작 영역 제한이 없다');
  assert(/addLook\(dx \* TOUCH_SENSITIVITY, dy \* TOUCH_SENSITIVITY\)/.test(js), '터치 시점 감도 처리가 없다');
  // 버튼/조이스틱 위에서 시작한 터치는 시점 드래그로 먹히지 않는다.
  assert(/overControl\(e\.clientX, e\.clientY\)/.test(js), '조작 버튼 위 터치를 시점으로 빼앗는다');
  assert(/pointermove/.test(js) && /last\.x = e\.clientX/.test(js), '터치 이동 델타 처리가 없다');
});

test('세로/가로(작은 높이) 레이아웃 대응이 있다', () => {
  assert(/@media \(max-width: 720px\)/.test(css), '좁은 화면 브레이크포인트가 없다');
  assert(/@media \(max-height: 520px\)/.test(css), '낮은 높이(가로 모드) 브레이크포인트가 없다');
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(css), '모션 감소 설정 대응이 없다');
  assert(/\.hidden \{[^}]*display: none !important/.test(css), '.hidden 규칙이 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('점프 · 정조준 · 보급(루팅) · AI 대전');
test('조작법 안내에 점프/정조준/앉기/달리기/줍기가 있다', () => {
  const guide = html.slice(html.indexOf('controls-guide'), html.indexOf('</section>', html.indexOf('controls-guide')));
  for (const key of ['Space', '우클릭', 'C / Ctrl', 'Shift', 'F']) {
    assert(guide.includes(key), `조작법에 ${key} 항목이 없다`);
  }
  assert(/점프/.test(guide) && /정조준/.test(guide) && /앉기/.test(guide), '점프/정조준/앉기 설명이 없다');
  assert(guide.includes('AI') || html.includes('AI와 바로 시작'), 'AI 대전 안내가 없다');
});

test('점프·정조준·앉기·달리기·줍기 입력이 서버 메시지로 연결된다', () => {
  assert(/function requestJump\(/.test(js) && /t: 'jump'/.test(js), '점프 요청이 없다');
  assert(/function setAds\(/.test(js) && /function toggleAds\(/.test(js), '정조준 함수가 없다');
  assert(/e\.button === 2/.test(js), '우클릭 정조준 처리가 없다');
  assert(/t: 'loot'/.test(js) && /function requestLoot\(/.test(js), '줍기 요청이 없다');
  assert(/state\.me\.sprint/.test(js) && /ShiftLeft/.test(js), '달리기 입력이 없다');
  assert(/KeyC|ControlLeft/.test(js), '앉기 입력이 없다');
  // 이동 패킷에 자세가 함께 실려 서버가 탄퍼짐/피격 박스를 판정한다.
  assert(/crouch: state\.me\.crouch/.test(js) && /sprint: state\.me\.sprint/.test(js) && /ads: state\.me\.ads/.test(js), '이동 패킷에 자세 정보가 없다');
});

test('수직 물리(중력·착지·엄폐물 위)를 클라이언트가 예측한다', () => {
  assert(/function stepVertical\(/.test(js), '클라이언트 수직 예측이 없다');
  assert(/function supportAtLocal\(/.test(js), '엄폐물 윗면 판정이 없다');
  assert(/gravity/.test(js) && /jumpVelocity/.test(js), '물리 상수를 서버 설정에서 받지 않는다');
  assert(/me\.y >= cover\.h - 0\.05/.test(js), '엄폐물 위에서 측면 충돌을 무시하지 않는다');
});

test('정조준은 화각 줌·감도 보정·화면 피드백을 준다', () => {
  assert(/adsFov/.test(js), '무기별 정조준 화각이 없다');
  assert(/adsSensitivity/.test(js), '정조준 감도 보정이 없다');
  assert(/id="ads-overlay"/.test(html), '정조준 오버레이가 없다');
  assert(/\.ads-overlay\.active \{[^}]*opacity: 1/.test(css), '정조준 오버레이 활성 스타일이 없다');
  assert(/camera\.fov \+= \(targetFov - camera\.fov\)/.test(js), '화각 보간이 없다');
});

test('HUD 신규 요소(나침반·미니맵·피해숫자·킬배너·토스트·자세·소리)', () => {
  for (const id of ['compass', 'minimap', 'ads-overlay', 'toast', 'kill-banner', 'kill-banner-text', 'damage-numbers', 'loot-hint', 'stance-badge', 'sound-toggle']) {
    assert(idSet.has(id), `HUD 요소 #${id} 가 없다`);
  }
  assert(/function drawCompass\(/.test(js) && /function drawMinimap\(/.test(js), '나침반/미니맵 렌더가 없다');
  assert(/function spawnDamageNumber\(/.test(js), '피해 숫자 표시가 없다');
  assert(/function showKillBanner\(/.test(js), '킬 배너가 없다');
  assert(/function showToast\(/.test(js), '획득 토스트가 없다');
  assert(/sound-toggle/.test(css), '소리 토글 스타일이 없다');
  assert(/localStorage\.getItem\('3dfp\.muted'\)/.test(js), '음소거 설정이 저장되지 않는다');
});

test('적 시인성: 네임태그·체력바·적 색 구분', () => {
  assert(/function updateAvatarHealth\(/.test(js), '원격 체력바 갱신이 없다');
  assert(/hpFill/.test(js) && /hpBg/.test(js), '체력바 스프라이트가 없다');
  assert(/nameSprite\(name, isBot \? '#fcd34d' : '#fda4af'\)/.test(js), '적/AI 이름표 색 구분이 없다');
});

test('보급 아이템은 서버 권위(획득/체력/무기 판정)', () => {
  assert(/net\.on\('looted'/.test(js), 'looted 패킷 처리가 없다');
  assert(/net\.on\('noWeapon'/.test(js), '미보유 무기 거절 처리이 없다');
  assert(/ownedAtStart/.test(js), '초기 보유 무기를 서버 설정에서 받지 않는다');
  assert(/function updateLoot\(/.test(js) && /autoPickup/.test(js), '줍기/자동 줍기 처리가 없다');
  // 클라이언트가 스스로 체력을 올리지 않는다(서버 패킷의 값만 반영).
  assert(!/state\.me\.hp\s*\+=/.test(js), '클라이언트가 체력을 직접 올린다');
  assert(!/state\.me\.owned\[[^\]]+\]\s*=\s*true/.test(js), '클라이언트가 무기 보유를 직접 바꾼다');
});

test('로비에서 AI 봇 수/난이도/빈자리 채우기를 고를 수 있다', () => {
  for (const id of ['bot-count', 'bot-difficulty', 'bot-fill', 'auto-pickup', 'btn-ai']) {
    assert(idSet.has(id), `로비 요소 #${id} 가 없다`);
  }
  assert(/payload\.bots = bots/.test(js) && /payload\.fillBots = fillBots/.test(js) && /payload\.difficulty = difficulty/.test(js), '봇 설정이 join 패킷에 실리지 않는다');
  assert(/id="btn-quick"/.test(html) && /id="btn-create"/.test(html), '기존 사람 멀티플레이 진입 버튼이 남아 있지 않다');
});

test('모바일 버튼에 점프/조준/앉기/줍기가 있고 3열 격자로 겹치지 않는다', () => {
  for (const id of ['btn-jump', 'btn-aim', 'btn-crouch', 'btn-loot']) {
    assert(idSet.has(id), `터치 버튼 #${id} 가 없다`);
  }
  assert(/grid-template-columns: repeat\(3, 1fr\)/.test(css), '터치 버튼이 3열 격자가 아니다');
  assert(/#btn-loot \{[^}]*grid-column: span 3/.test(css), '줍기 버튼 배치가 없다');
  assert(/bindHoldButton\(dom\.btnJump/.test(js) && /bindHoldButton\(dom\.btnAim/.test(js), '점프/조준 버튼 핸들러가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('DOM 계약(main.js ↔ index.html)');
test('main.js 가 참조하는 모든 id 가 index.html 에 있다', () => {
  const missing = [];
  for (const [key, id] of domById.entries()) {
    if (!idSet.has(id)) missing.push(`dom.${key} → #${id}`);
  }
  assert(missing.length === 0, `없는 요소 참조: ${missing.join(', ')}`);
});

test('dom 객체의 모든 속성이 main.js 에서 정의돼 있다', () => {
  const used = [...js.matchAll(/dom\.(\w+)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((key) => !domKeys.includes(key) && !['classList'].includes(key));
  assert(unknown.length === 0, `정의되지 않은 dom 속성: ${unknown.join(', ')}`);
});

test('index.html 의 버튼은 모두 JS 핸들러와 연결돼 있다', () => {
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert(buttons.length >= 10, `버튼이 ${buttons.length}개뿐이다`);
  for (const id of buttons) {
    const bindByName = js.includes(`getElementById('${id}')`);
    const bindByDom = [...domById.entries()].some(([k, v]) => v === id && js.includes(`dom.${k}.addEventListener`));
    assert(bindByDom || bindByName, `#${id} 버튼에 클릭 핸들러가 없다`);
  }
});

test('닉네임 등 사용자 입력은 textContent 로만 출력한다(XSS 방지)', () => {
  const injections = [...js.matchAll(/innerHTML\s*=\s*(.+);/g)].map((m) => m[1].trim());
  for (const value of injections) {
    assert(value === "''" || value === '""', `innerHTML 에 동적 값을 넣는다: ${value}`);
  }
  assert(/killer\.textContent/.test(js) && /victim\.textContent/.test(js), '킬피드가 textContent 를 쓰지 않는다');
});

// ───────────────────────────────────────────────────────────────────────────
section('3D 표현 · 무기');
test('1인칭 뷰모델이 라이플/권총/샷건으로 구분된다', () => {
  const build = js.slice(js.indexOf('function buildViewmodel'), js.indexOf('function setViewmodel'));
  assert(/weaponId === 2/.test(build) && /weaponId === 3/.test(build), '권총/샷건 분기가 없다');
  assert((build.match(/add\(new THREE\./g) || []).length >= 12, '뷰모델 파츠가 너무 적다');
  assert(/권총/.test(build) && /샷건/.test(build) && /라이플/.test(build), '무기별 주석/구분이 없다');
});

test('원격 플레이어는 실루엣·네임태그·무기 모델을 가진다', () => {
  const create = js.slice(js.indexOf('function createAvatar'), js.indexOf('function removeAvatar'));
  assert(/CapsuleGeometry/.test(create), '몸통 실루엣이 없다');
  assert(/SphereGeometry/.test(create), '머리가 없다');
  assert(/nameSprite/.test(create), '네임태그가 없다');
  assert(/new THREE\.Mesh\(\s*new THREE\.BoxGeometry\(0\.09, 0\.1, 0\.6\)/.test(create), '원격 무기 모델이 없다');
  assert(/applyRemoteWeapon/.test(js), '원격 무기 종류 반영이 없다');
  assert(/measureText/.test(js), '긴 닉네임 크기 보정이 없다');
});

test('안전 구역 원기둥/링이 안·밖에서 보이도록 그려진다', () => {
  assert(/new THREE\.CylinderGeometry/.test(js), '존 원기둥이 없다');
  assert(/new THREE\.RingGeometry/.test(js), '존 바닥 링이 없다');
  assert(/zoneWall\.material\.opacity = outside \? 0\.24 : 0\.12/.test(js), '존 벽 불투명도(안/밖) 처리가 없다');
  assert(/zoneWall\.material\.color\.setHex/.test(js), '축소 중 색 변화가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('의존성 · 오프라인 실행');
test('Three.js는 로컬 번들 + importmap 으로만 불러온다', () => {
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert(map, 'importmap 이 없다');
  const json = JSON.parse(map[1]);
  assert(json.imports && json.imports.three, 'importmap 에 three 매핑이 없다');
  assert(json.imports.three.startsWith('/vendor/three/'), `three 경로가 로컬이 아니다: ${json.imports.three}`);
  const vendor = path.join(ROOT, 'public/vendor/three/three.module.min.js');
  assert(fs.existsSync(vendor), '로컬 three 번들이 없다');
  const stat = fs.statSync(vendor);
  assert(stat.size > 300 * 1024, `three 번들이 너무 작다(${stat.size}B)`);
  assert(fs.existsSync(path.join(ROOT, 'public/vendor/three/LICENSE')), 'three LICENSE 가 없다');
  assert(/0\.170\.0/.test(read('public/vendor/three/VERSION')), 'three VERSION 이 맞지 않는다');
});

test('외부 CDN/원격 리소스 참조가 0건이다', () => {
  const files = ['public/index.html', 'public/css/style.css', 'public/js/main.js', 'public/js/net.js', 'public/js/audio.js'];
  const offenders = [];
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) offenders.push(`${rel}: ${m[1]}`);
    for (const m of src.matchAll(/url\((https?:\/\/[^)]+)\)/g)) offenders.push(`${rel}: url(${m[1]})`);
    for (const m of src.matchAll(/@import\s+(?:url\()?["']?https?:/g)) offenders.push(`${rel}: @import`);
    for (const m of src.matchAll(/fetch\(\s*['"`]https?:/g)) offenders.push(`${rel}: fetch(remote)`);
  }
  assert(offenders.length === 0, `원격 리소스 참조: ${offenders.join(', ')}`);
});

test('클라이언트 모듈은 상대 경로 로컬 모듈만 import 한다', () => {
  const imports = [...js.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert(imports.includes('three'), "import 'three' 가 없다");
  for (const spec of imports) {
    if (spec === 'three') continue;
    assert(spec.startsWith('./'), `원격/절대 모듈 import: ${spec}`);
    assert(fs.existsSync(path.join(ROOT, 'public/js', spec)), `모듈 파일이 없다: ${spec}`);
  }
  assert(!/^import .*https?:/m.test(net), 'net.js 가 원격 모듈을 import 한다');
});

test('부트 실패 안내(모듈/WebGL)가 있다', () => {
  assert(/id="boot-error"/.test(html), '부트 실패 배너가 없다');
  assert(/showBootError/.test(html) && /showBootError/.test(js), '부트 실패 안내 함수가 연결되지 않았다');
  assert(/WebGL/.test(js), 'WebGL 미지원 안내가 없다');
  assert(/__3dfpBooted/.test(js) && /__3dfpBooted/.test(html), '부트 완료 감시가 없다');
});

// ───────────────────────────────────────────────────────────────────────────
section('문서(README/CREDITS)');
test('README: 실행 방법·접속 주소·Node 버전·테스트 명령', () => {
  for (const needle of ['npm install', 'npm start', 'localhost:3000', 'Node.js 18', 'npm run check', 'test/unit.js', 'test/smoke.js', 'test/soak.js']) {
    assert(readme.includes(needle), `README 에 "${needle}" 안내가 없다`);
  }
  assert(/PORT=8080/.test(readme), '포트 변경 방법이 없다');
});

test('README: 조작법 표에 PC/모바일이 모두 있다', () => {
  const table = readme.slice(readme.indexOf('| 동작 |'), readme.indexOf('### 무기'));
  for (const key of ['W A S D', 'ESC', '조이스틱', '발사', '재장전']) {
    assert(table.includes(key), `조작법 표에 ${key} 가 없다`);
  }
});

test('README: 배틀로얄 규칙과 미확인(검증) 항목이 구분돼 있다', () => {
  assert(/노리스폰/.test(readme), '노리스폰 규칙이 없다');
  assert(/마지막 생존자/.test(readme), '마지막 생존자 승리 규칙이 없다');
  assert(/공개 배포/.test(readme), '공개 배포 보류 안내가 없다');
});

test('CREDITS: Three.js/ws 라이선스와 에셋 출처가 적혀 있다', () => {
  assert(/Three\.js/.test(credits) && /MIT/.test(credits), 'Three.js 라이선스 표기가 없다');
  assert(/\bws\b/.test(credits), 'ws 라이선스 표기가 없다');
  assert(/CC0/.test(credits), '에셋 라이선스(CC0) 표기가 없다');
  assert(/public\/vendor\/three\/LICENSE/.test(credits), '번들 라이선스 경로 안내가 없다');
});

console.log(`\n[ui-static] 통과 ${passed} · 실패 ${failed}`);
if (failed > 0) process.exit(1);
