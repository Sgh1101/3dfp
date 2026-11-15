'use strict';

/**
 * 문법 검사 스크립트.
 * - 서버(CommonJS): node --check
 * - 클라이언트(ESM): .mjs로 복사해 node --check (importmap/브라우저 없이 구문만 검증)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

const serverFiles = [
  'server/index.js',
  'server/game.js',
  'server/rooms.js',
  'server/map.js',
  'server/limits.js',
  'scripts/vendor-three.js',
  'test/unit.js',
  'test/smoke.js',
  'test/soak.js',
];
const clientFiles = ['public/js/main.js', 'public/js/net.js', 'public/js/audio.js'];

let failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dfp-check-'));

function check(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ✓ ${path.relative(root, file)}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${path.relative(root, file)}`);
    console.error(String(err.stderr || err.message));
  }
}

console.log('[check] 서버 파일');
for (const file of serverFiles) check(path.join(root, file));

console.log('[check] 클라이언트 모듈(ESM)');
for (const file of clientFiles) {
  const src = path.join(root, file);
  const dst = path.join(tmpDir, path.basename(file).replace(/\.js$/, '.mjs'));
  fs.copyFileSync(src, dst);
  check(dst);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n[check] 실패 ${failed}건`);
  process.exit(1);
}
console.log('\n[check] 문법 검사 통과');
