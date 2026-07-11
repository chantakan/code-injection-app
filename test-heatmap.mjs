/**
 * test-heatmap.mjs — P6 ミス箇所ヒートマップ(§7「回路基板風」)集計の単体テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-heatmap.mjs
 */
import assert from 'node:assert/strict';
import { buildCharModel, buildHeatmap } from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };

console.log('buildHeatmap(§7):');

ok('ミスなしは全ノード count=0・maxCount=0', () => {
  const m = buildCharModel('const x = 1;\n');
  const d = buildHeatmap(m, []);
  assert.equal(d.totalMisses, 0);
  assert.equal(d.maxCount, 0);
  assert.ok(d.nodes.length > 0);
  assert.ok(d.nodes.every((nd) => nd.count === 0 && nd.intensity === 0));
});

ok('totalMisses は missIndices の件数(重複込み=同一箇所の繰り返しミス)', () => {
  const m = buildCharModel('a'.repeat(100));
  const d = buildHeatmap(m, [5, 5, 5, 90]);
  assert.equal(d.totalMisses, 4);
});

ok('先頭寄りのミスと末尾寄りのミスは別バケットに入る', () => {
  const m = buildCharModel('a'.repeat(200));
  const d = buildHeatmap(m, [0, 199]);
  const hit = d.nodes.filter((nd) => nd.count > 0);
  assert.equal(hit.length, 2);
  assert.notDeepEqual([hit[0].row, hit[0].col], [hit[1].row, hit[1].col]);
});

ok('intensity は maxCount で正規化される(最頻バケットが 1)', () => {
  const m = buildCharModel('a'.repeat(200));
  const d = buildHeatmap(m, [0, 0, 0, 199]); // 先頭バケット3件・末尾バケット1件
  const top = d.nodes.reduce((a, b) => (b.count > a.count ? b : a));
  assert.equal(top.intensity, 1);
  assert.equal(top.count, 3);
});

ok('範囲外・非整数の添字は無視する(壊れたリプレイへの耐性)', () => {
  const m = buildCharModel('abc');
  const d = buildHeatmap(m, [-1, 3, 999, 1.5, 1]);
  assert.equal(d.totalMisses, 5); // 件数自体はそのまま(表示用の生数)
  assert.equal(d.maxCount, 1); // 集計に効いたのは index=1 の 1 件だけ
});

ok('スネーク配列: 偶数行は左→右・奇数行は右→左でノードが隣接する', () => {
  const m = buildCharModel('a'.repeat(64)); // 8列×8行にきっちり収まる
  const d = buildHeatmap(m, [], 8);
  assert.equal(d.cols, 8);
  assert.equal(d.nodes[0].row, 0);
  assert.equal(d.nodes[0].col, 0); // row0 は左端から
  assert.equal(d.nodes[7].row, 0);
  assert.equal(d.nodes[7].col, 7); // row0 の右端
  assert.equal(d.nodes[8].row, 1);
  assert.equal(d.nodes[8].col, 7); // row1 はここから始まる(折り返し=隣接)
  assert.equal(d.nodes[15].row, 1);
  assert.equal(d.nodes[15].col, 0); // row1 の左端で終わる
});

ok('短いファイルはバケット数が縮む(空バケットで埋めない)', () => {
  const m = buildCharModel('abc'); // 3 セル
  const d = buildHeatmap(m, [], 8);
  assert.equal(d.cols, 3);
  assert.equal(d.rows, 1);
  assert.equal(d.nodes.length, 3);
});

ok('cells.length=0 は空グリッド(例外にしない)', () => {
  const m = buildCharModel('');
  const d = buildHeatmap(m, [0, 1]);
  assert.deepEqual(d.nodes, []);
  assert.equal(d.cols, 0);
  assert.equal(d.totalMisses, 2); // 表示用の生数はそのまま返す
});

console.log(`\n全 ${n} 項目パス`);
