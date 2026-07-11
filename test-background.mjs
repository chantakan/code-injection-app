/**
 * test-background.mjs — P6 背景アニメの純ロジック(§7)単体テスト
 * frameParams() のみ(canvas 描画そのものは e2e で確認 §7)
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-background.mjs
 */
import assert from 'node:assert/strict';
import { frameParams } from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };

console.log('frameParams(§7 演出強度 × prefers-reduced-motion):');

ok('OFF は reduced-motion に関わらず非表示', () => {
  assert.deepEqual(frameParams('off', false), { visible: false, speed: 0, opacity: 0 });
  assert.deepEqual(frameParams('off', true), { visible: false, speed: 0, opacity: 0 });
});

ok('標準(reduced-motion なし)はフル速度・フル不透明度', () => {
  const p = frameParams('normal', false);
  assert.equal(p.visible, true);
  assert.equal(p.speed, 1);
  assert.equal(p.opacity, 1);
});

ok('弱(reduced-motion なし)は速度・不透明度とも標準未満', () => {
  const p = frameParams('low', false);
  assert.equal(p.visible, true);
  assert.ok(p.speed > 0 && p.speed < 1);
  assert.ok(p.opacity > 0 && p.opacity < 1);
});

ok('prefers-reduced-motion は演出強度に関わらず速度を止める(§7 尊重)', () => {
  assert.equal(frameParams('normal', true).speed, 0);
  assert.equal(frameParams('low', true).speed, 0);
  // OFF 以外は reduced-motion でも表示自体はする(静止フレーム)
  assert.equal(frameParams('normal', true).visible, true);
  assert.equal(frameParams('low', true).visible, true);
});

console.log(`\n全 ${n} 項目パス`);
