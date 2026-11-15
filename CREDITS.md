# CREDITS

## 코드 / 엔진

- **Three.js** — MIT License · <https://threejs.org>
  - 클라이언트 3D 렌더링. ES 모듈로 CDN에서 불러옵니다 (`three@0.170.0`, unpkg).
- **ws** — MIT License · <https://github.com/websockets/ws>
  - Node.js WebSocket 서버.
- **Node.js** — MIT License · <https://nodejs.org>

## 그래픽 / 사운드 (현재 상태)

v0.1 골격은 **외부 에셋 없이** 동작합니다.

- 3D 오브젝트: Three.js 기본 지오메트리(Box, Capsule, Sphere, Cylinder)로 절차 구성
- 텍스처: `<canvas>`로 코드에서 생성한 격자 바닥 텍스처
- 효과음: Web Audio API 실시간 합성 (사격·명중·킬·재장전·발소리·구역 경보)
- 폰트: 시스템 폰트 (Pretendard → Apple SD Gothic Neo → Malgun Gothic → system-ui)

## 향후 시각 개선에 사용할 예정인 에셋

아래 팩은 모두 **CC0 1.0 (퍼블릭 도메인)** 이라 출처 표기가 필수는 아니지만,
프로젝트 원칙상 아래에 명시합니다. (아직 저장소에 포함되어 있지 않습니다.)

| 팩 | 용도 | 라이선스 | 링크 |
| --- | --- | --- | --- |
| Kenney — Blaster Kit | 1인칭 무기 뷰모델, 총구 화염 | CC0 1.0 | <https://kenney.nl/assets/blaster-kit> |
| Kenney — Mini Arena | 아레나 프롭, 컨테이너, 방벽 | CC0 1.0 | <https://kenney.nl/assets/mini-arena> |
| Kenney — Sci-Fi Sounds | 사격·재장전·피격 효과음 | CC0 1.0 | <https://kenney.nl/assets/sci-fi-sounds> |
| Kenney — Impact Sounds | 타격·발소리 | CC0 1.0 | <https://kenney.nl/assets/impact-sounds> |
| Kenney — Interface Sounds | HUD·버튼 UI 사운드 | CC0 1.0 | <https://kenney.nl/assets/interface-sounds> |

> 에셋을 추가할 때는 파일별 라이선스를 이 문서에 함께 적고, `public/assets/` 아래에만 둡니다.
> (CC0가 아닌 에셋은 프로젝트 규칙상 사용 전에 별도 확인)
