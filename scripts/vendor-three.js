'use strict';

/**
 * Three.js 로컬 번들 스크립트.
 *
 * - `node_modules/three`(devDependency, 버전 고정)의 ES 모듈 빌드를
 *   `public/vendor/three/`로 복사한다.
 * - 클라이언트는 importmap으로 이 로컬 파일만 불러온다(CDN 의존 없음 → 오프라인/사내망/차단 환경에서도 동작).
 * - three 버전을 올릴 때: `npm i -D --save-exact three@<버전>` 후 `node scripts/vendor-three.js` 실행.
 *
 * 실행: node scripts/vendor-three.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'node_modules', 'three');
const outDir = path.join(root, 'public', 'vendor', 'three');

function fail(message) {
  console.error(`[vendor-three] ${message}`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
} catch {
  fail('node_modules/three 가 없습니다. 먼저 `npm install`을 실행하세요.');
}

const buildFile = path.join(srcDir, 'build', 'three.module.min.js');
if (!fs.existsSync(buildFile)) fail(`번들 파일을 찾을 수 없습니다: ${buildFile}`);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(buildFile, path.join(outDir, 'three.module.min.js'));

const license = path.join(srcDir, 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(outDir, 'LICENSE'));

fs.writeFileSync(
  path.join(outDir, 'VERSION'),
  `three ${pkg.version} (build/three.module.min.js)\nMIT License — https://threejs.org\n복사: npm run vendor:three\n`,
);

const bytes = fs.statSync(path.join(outDir, 'three.module.min.js')).size;
console.log(`[vendor-three] three ${pkg.version} → public/vendor/three/three.module.min.js (${(bytes / 1024).toFixed(0)}KB)`);
