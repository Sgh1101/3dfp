# 3DFP — 3D 1인칭 멀티플레이어 브라우저 FPS

Three.js 클라이언트 + Node.js 권위 서버(WebSocket)로 만든 **배틀로얄(노리스폰) 골격 v0.2** 입니다.
브라우저만 있으면 설치 없이 접속하고, `npm install && npm start` 한 번으로 서버와 게임이 같이 뜹니다.

> ⚠️ 이 저장소는 아직 **공개 배포용이 아닙니다.** 3D 게임이 완성되고 배포 여부를 정하기 전까지
> 어떤 공개 호스팅에도 올리지 않습니다. (프로젝트 규칙)

---

## 1. 실행 방법

```bash
git clone https://github.com/Sgh1101/3dfp.git
cd 3dfp
npm install
npm start
```

- 접속: <http://localhost:3000>
- 포트 변경: `PORT=8080 npm start`
- 요구 사항: **Node.js 18 이상** (개발/검증은 Node 22에서 진행)

서버 하나가 정적 파일(`public/`)과 WebSocket을 **같은 포트**에서 함께 서비스합니다.
별도 빌드 단계나 번들러는 없습니다.

Three.js는 **저장소에 들어 있는 로컬 번들**(`public/vendor/three/three.module.min.js`, three 0.170.0)을
importmap으로 불러옵니다. CDN에 의존하지 않으므로 오프라인·사내망·CDN 차단 환경에서도 그대로 동작합니다.
번들을 다시 만들 때만:

```bash
npm install                 # devDependency three@0.170.0 설치
npm run vendor:three        # node_modules/three → public/vendor/three 복사
```

### 테스트

```bash
npm run check      # 서버(CJS)·클라이언트(ESM)·스크립트 문법 검사
npm test           # 단위 테스트 + E2E 스모크 테스트(실서버 + 다중 클라이언트)
npm run test:soak  # 봇 소크 테스트(여러 라운드를 실제로 돌려 배틀로얄 흐름 검증)
npm run test:all   # 위 셋을 한 번에
```

- `test/unit.js` — 게임 로직만 검사(네트워크 없음): 이동 검증, 히트스캔, 재장전/무기 교체, 존,
  **배틀로얄 라운드 규칙(노리스폰·마지막 생존자 승리·시간 종료·인터미션 부활)**, 연결/방 한도,
  레이트리밋, 백프레셔 판정.
- `test/smoke.js` — 임시 포트에 서버를 띄워 검증: 정적 자원 MIME, 로컬 three 번들 서빙,
  **API 경로 정확 일치(404)**, 워밍업/라운드 시작, 참여·핑 레이트리밋,
  **전역 연결 상한(`SERVER_FULL`)·방 상한(`TOO_MANY_ROOMS`)**, 이동·사격·재장전,
  **무기 교체 시 재장전 취소**, NaN/속도 위반, 종료 처리.
- `test/soak.js` — 봇 4개가 실제로 참여해 1~3라운드를 돌며 **탈락자가 리스폰하지 않는지**,
  마지막 생존자가 승리하는지, 인터미션 뒤 전원이 부활하는지 확인합니다(약 30~60초).

---

## 2. 조작법

| 동작 | PC | 모바일 |
| --- | --- | --- |
| 이동 | `W A S D` | 왼쪽 가상 조이스틱 |
| 시점 | 마우스 (클릭으로 PointerLock) | 오른쪽 화면 드래그 |
| 사격 | 마우스 왼쪽 버튼 | `발사` 버튼 |
| 재장전 | `R` | `재장전` 버튼 |
| 무기 교체 | `E` (또는 `1` `2` `3`) | `무기` 버튼 |
| 힐 키트 | `Q` | `힐` 버튼 |
| 마우스 고정 해제 | `ESC` | — |

- PC에서 화면을 클릭하면 마우스가 고정되고, `ESC`로 풀립니다. 다시 클릭하면 **카메라 각도가 튀지 않고** 이어집니다.
- 모바일은 안전 영역(`env(safe-area-inset-*)`)을 반영해 노치·홈바에 HUD가 가리지 않습니다.

### 무기

| 슬롯 | 무기 | 피해 | 연사 | 탄창 | 예비 | 특징 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 라이플 | 24 | 110ms 자동 | 30 | 150 | 기본 주무기, 사거리 140m |
| 2 | 권총 | 32 | 220ms 단발 | 12 | 72 | 정확·가벼움 |
| 3 | 샷건 | 11 × 8펠릿 | 800ms | 6 | 36 | 근거리 42m, 탄퍼짐 큼 |

- 재장전 중에 무기를 바꾸면 **재장전은 즉시 취소**됩니다(이전 무기의 재장전이 새 무기에 얹히지 않음).

### 규칙 — 배틀로얄 (노리스폰)

- 아레나: **160m × 160m**, 서버가 아는 AABB 커버(컨테이너·상자·방벽·기둥) 배치.
- **라운드 중 사망 = 탈락.** 라운드가 끝날 때까지 리스폰되지 않고(`탈락 · 생존자 관전`) 관전합니다.
- **라운드 종료 조건**
  1. 2명 이상으로 시작한 라운드에서 **생존자가 1명**이 되면 → 그 플레이어가 **마지막 생존자 승리**.
  2. 라운드 시간(3분)이 끝나면 → 남은 생존자 중 **HP가 가장 높은 플레이어** 승리(동률이면 킬 수).
  3. 전멸(0명 생존)이면 무승부.
- **인터미션 8초** 뒤 다음 라운드가 자동 시작하고, 그 전에 **전원이 `준비`를 누르면 즉시** 시작합니다.
  새 라운드에서 전원은 `alive: true`, 만HP, 탄약/힐 키트 풀충전, 새 스폰 위치, **구역 3단계 초기화**로 되살아납니다.
- **혼자면 워밍업**: 방에 1명뿐이면 라운드를 시작하지 않고 `워밍업` 상태로 기다립니다(사격 불가, 이동 가능).
  두 번째 플레이어가 들어오는 순간 라운드가 시작됩니다.
- **진행 중 라운드에 입장**한 플레이어는 그 라운드를 관전하고 **다음 라운드부터** 합류합니다.
- 안전 구역이 **3단계**로 축소(20s 대기 → 40s 축소 등), 구역 밖에서는 초당 12 피해.
- 리스폰 직후 **10초 스폰 보호**(사격하면 즉시 해제) — 라운드 시작 스폰에도 적용됩니다.
- 방: 기본 공개방 `LOBBY0` + 6자리 코드로 생성/참여, 방당 최대 **8명**.

---

## 3. 서버 보호 (연결·방·레이트리밋·백프레셔)

`server/limits.js`에 모아 두고, 환경 변수로 조정할 수 있습니다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MAX_TOTAL_CONNECTIONS` | `128` | 동시 웹소켓 연결 상한. 초과 시 `SERVER_FULL` 후 소켓 종료(4013) |
| `MAX_ROOMS` | `32` | 동시 방 수 상한(기본 공개방 포함). 초과 시 `TOO_MANY_ROOMS` |
| `MAX_BUFFERED_BYTES` | `262144` (256KB) | 소켓 전송 버퍼 상한 |
| `SLOW_SOCKET_STRIKES` | `60` | 버퍼가 계속 차 있을 때 스냅샷을 건너뛴 횟수(20Hz 기준 약 3초) → 소켓 종료(4014) |
| `JOIN_RATE_MAX` | `5` | 참여 요청 허용 횟수 / 10초 (소켓당) |
| `PING_RATE_MAX` | `5` | 핑 허용 횟수 / 1초 (소켓당, 초과분은 응답하지 않음) |

- **느린 소켓 보호**: 20Hz 스냅샷을 방송할 때 `ws.bufferedAmount > MAX_BUFFERED_BYTES`면 그 틱은 건너뛰고,
  계속 막혀 있으면 그 소켓만 끊습니다. 느린 클라이언트 하나가 서버 큐/메모리를 잡아먹지 못합니다.
- **API 경로는 정확 일치**로만 매칭합니다(`/api/map`, `/api/config`, `/api/health`).
  알 수 없는 `/api/*`는 `404 {error:"NOT_FOUND"}`를 돌려줍니다.

---

## 4. 구조

```
3dfp/
├─ server/
│  ├─ index.js     # HTTP 정적 서비스 + WebSocket + 연결/레이트리밋 + 20Hz 틱 루프 + 하트비트
│  ├─ rooms.js     # 방 생성/참여/정원/방 상한/코드 발급/빈 방 정리
│  ├─ game.js      # 게임 상태·이동 검증·히트스캔·존·배틀로얄 라운드·스냅샷
│  ├─ limits.js    # 전역 한도·레이트리밋·백프레셔 가드
│  └─ map.js       # 아레나/커버 AABB/스폰 정의 (클라이언트와 공유하는 단일 소스)
├─ public/
│  ├─ index.html   # HUD·오버레이·importmap(로컬 three)·모듈 로드 실패 안내
│  ├─ css/style.css
│  ├─ vendor/three/three.module.min.js   # three 0.170.0 로컬 번들(+ LICENSE, VERSION)
│  └─ js/
│     ├─ main.js   # Three.js 씬·입력·보간·HUD·탈락/워밍업 표시
│     ├─ net.js    # WebSocket 래퍼 + RTT
│     └─ audio.js  # Web Audio 절차적 효과음 (음원 파일 0개)
├─ scripts/
│  ├─ check.js          # 문법 검사
│  └─ vendor-three.js   # three 로컬 번들 복사
└─ test/{unit.js, smoke.js, soak.js}
```

### 권위 서버 원칙

- **이동**: 클라이언트 예측 + 서버 검증. 좌표가 `[-80, 80]` 밖이거나 `NaN`/`Infinity`면 패킷 폐기,
  한 틱 허용 거리(`6.6m/s × dt + 0.07m`)를 넘으면 **되돌리고 보정 패킷**(`corr`)을 보냅니다.
- **사격·피해·존·라운드**: 전부 서버 계산. 클라이언트가 보낸 피해량/명중은 신뢰하지 않습니다.
- **히트스캔**: 커버 AABB를 먼저 통과시킨 뒤 그보다 가까운 플레이어 AABB만 명중 처리.
- **요청 제한**: 이동 40/초, 사격 25/초, 그 외 액션 15/초 (슬라이딩 윈도) + 위 연결/참여/핑 한도.
- **닉네임**: HTML 태그 제거 + 특수문자 이스케이프 + 16자 제한. 클라이언트도 `textContent`로만 출력.

### 네트워크 프로토콜 (JSON)

클라이언트 → 서버

| `t` | 내용 |
| --- | --- |
| `join` | `{name, code?, create?}` — `code` 없으면 기본방, `create:true`면 새 방 |
| `m` | `{x, z, yaw, pitch}` 이동/시점 (20Hz) |
| `shoot` | `{yaw?, pitch?}` |
| `reload` / `swap` | `{w?}` 무기 지정 또는 순환 |
| `heal` / `ready` / `ping` | 힐 키트 / 다음 라운드 준비 / RTT 측정 |

서버 → 클라이언트

| `t` | 내용 |
| --- | --- |
| `welcome` | `{id, code, isDefault, map, config}` — 맵·무기표·상수 포함 |
| `s` | 20Hz 스냅샷: `players:[[id,name,x,y,z,yaw,pitch,hp,alive,weapon,ammo,reserve,kills,deaths,spawnProtect,reloadMs,kits]]`, `zone:{stage,radius,centerX,centerZ,shrinking,nextIn}`, `round:{mode,index,state,reason,timeLeft,winner,winnerId,winnerKills,winnerHp,ready,total,alive,need,nextIn}`, `alive` |
| `ev` | 이벤트 묶음: `shot`(트레이서 좌표) · `hit` · `kill` · `join` · `leave` · `heal` · `swap` · `round`(start/end/waiting) · `zoneHit` |
| `reloadStart` / `reloaded` / `reloadCancel` | 재장전 시작·완료·취소(무기 교체·사망 시) |
| `corr` | 서버가 되돌린 위치(클라이언트 보정) |
| `error` | `{code, message}` — `ROOM_NOT_FOUND`, `ROOM_FULL`, `TOO_MANY_ROOMS`, `SERVER_FULL`, `RATE_LIMIT`, `SLOW_CLIENT` 등 |

### 렌더링 / 표현

- 원격 플레이어는 **90ms 지연 보간**(스냅샷 버퍼 사이 선형 보간, yaw는 최단 각도)으로 부드럽게 표시됩니다.
- 존은 반지름을 부드럽게 따라가는 원기둥 + 바닥 링으로 표시.
- 탈락 오버레이는 화면을 가리지 않아 남은 플레이어를 계속 볼 수 있고, 혼자일 때는 상단에 `워밍업` 배너가 뜹니다.
- 효과음은 Web Audio로 합성(사격·명중·킬·재장전·발소리·구역 경보)하므로 **누락될 음원 파일이 없습니다.**

---

## 5. 설정 값 바꾸기

| 값 | 위치 |
| --- | --- |
| 무기 성능(피해·연사·탄창·재장전) | `server/game.js`의 `WEAPONS` (클라이언트는 `welcome.config`로 자동 반영) |
| 이동 속도·틱·라운드 길이·인터미션·최소 인원 | `server/game.js` 상단 상수(`ROUND_MS`, `INTERMISSION_MS`, `MIN_PLAYERS_TO_START`) |
| 존 축소 단계 | `server/game.js`의 `ZONE_PHASES` |
| 맵(커버/스폰) | `server/map.js` — 고치면 클라이언트 화면과 서버 판정이 함께 바뀝니다 |
| 방 정원·코드 길이 | `server/rooms.js` |
| 연결/방 상한·레이트리밋·백프레셔 | `server/limits.js` 또는 환경 변수(위 표) |

---

## 6. 로드맵

- [ ] 실제 3D 모델/텍스처(아래 `CREDITS.md` 참고)
- [ ] 팀전·점수판·본격 관전 카메라
- [ ] 사운드 볼륨/감도 설정 화면
- [ ] 모바일 성능 옵션(해상도 스케일)
- [ ] 완성 후 배포 여부 결정 (그 전까지 공개 배포 금지)

## 라이선스
