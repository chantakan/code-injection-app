/**
 * test-rhythm.mjs — P6 リズムグラフ(§7, §10)集計の単体テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-rhythm.mjs
 */
import assert from 'node:assert/strict';
import { buildRhythmSeries } from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };

const ev = (dt, ok_ = true) => ({ key: 'x', dt, ok: ok_, passed: 0 });

console.log('buildRhythmSeries(§7, §10):');

ok('空イベントは空系列', () => {
  assert.deepEqual(buildRhythmSeries([]), { points: [], misses: [] });
});

ok('正解イベントのみ points、ミスは misses に分離される', () => {
  const s = buildRhythmSeries([ev(100), ev(100, false), ev(100)]);
  assert.equal(s.points.length, 2);
  assert.equal(s.misses.length, 1);
});

ok('t は経過時間の割合(0〜1、単調増加)', () => {
  const s = buildRhythmSeries([ev(100), ev(100), ev(200)]); // 合計400ms
  assert.equal(s.points[0].t, 100 / 400);
  assert.equal(s.points[1].t, 200 / 400);
  assert.equal(s.points[2].t, 1); // 最終イベント = 完走時点
  assert.ok(s.points[0].t < s.points[1].t);
  assert.ok(s.points[1].t < s.points[2].t);
});

ok('v は速いほど1に近く、遅いほど0に近い(打鍵間隔の逆写像)', () => {
  const s = buildRhythmSeries([ev(40), ev(900)]); // 最速端 / 最遅端
  assert.equal(s.points[0].v, 1);
  assert.equal(s.points[1].v, 0);
});

ok('v は範囲外でもクランプされる(0〜1を超えない)', () => {
  const s = buildRhythmSeries([ev(1), ev(5000)]);
  assert.equal(s.points[0].v, 1);
  assert.equal(s.points[1].v, 0);
});

ok('totalMs=0(全 dt=0)でも例外にならず t=0 に揃う', () => {
  const s = buildRhythmSeries([ev(0), ev(0, false)]);
  assert.equal(s.points[0].t, 0);
  assert.equal(s.misses[0], 0);
});

ok('ミスの t も累積時間から計算される(グラフ上の位置合わせ)', () => {
  const s = buildRhythmSeries([ev(100), ev(300, false)]); // 合計400ms、ミスは400ms地点
  assert.equal(s.misses[0], 1);
});

console.log(`\n全 ${n} 項目パス`);
