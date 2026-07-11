/**
 * test-difficulty.mjs — difficulty.ts の Node 実挙動テスト(P3)
 * 実行:
 *   npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *     --outfile=.test/entry.bundle.mjs
 *   npx esbuild src/difficulty.ts --bundle --format=esm \
 *     --external:./wasm/difficulty/difficulty_engine.js \
 *     --outfile=.test/difficulty.bundle.mjs
 *   node test-difficulty.mjs
 * 前提: BUILD.md の手順で src/wasm/difficulty/ に wasm-pack 生成物があること
 *       (test-difficulty-smoke.mjs が通っていること)
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { initAnalyzer, analyze, buildCharModel } from './.test/entry.bundle.mjs';
import {
  initDifficulty,
  preloadDifficulty,
  computeDifficulty,
  buildDifficultyInput,
  lengthFactor,
  rankingScore,
} from './.test/difficulty.bundle.mjs';

let n = 0;
const ok = (name, fn) => Promise.resolve(fn()).then(() => console.log(`  ok ${++n}: ${name}`));

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});

// ---------------------------------------------------- ロード前の同期 API は明示エラー
console.log('初期化まわり:');
await ok('lengthFactor はロード前に呼ぶと throw', () => {
  assert.throws(() => lengthFactor(300), /未ロード/);
});

initDifficulty({
  wasmUrl: new URL('./src/wasm/difficulty/difficulty_engine_bg.wasm', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
  loadGlue: () => import('./src/wasm/difficulty/difficulty_engine.js'),
});
await preloadDifficulty();

await ok('lengthFactor: 300→0.3873 / 500→0.5 / 2000→1 / 200000→1', () => {
  assert.equal(lengthFactor(300), 0.3873);
  assert.equal(lengthFactor(500), 0.5);
  assert.equal(lengthFactor(2000), 1);
  assert.equal(lengthFactor(200000), 1);
});

// ---------------------------------------------------- buildDifficultyInput(手組み解析)
console.log('buildDifficultyInput:');
// 'a(b) {\n  c;\n}\n' = 14 セル。トークン・スコープを手組みして写像を固定検証する
const srcA = 'a(b) {\n  c;\n}\n';
const tk = (start, end, cls) => ({ start, end, cls });
const analysisA = {
  language: 'javascript',
  engine: 'tree-sitter',
  errorRatio: 0,
  comments: [],
  strings: [],
  tokens: [
    tk(0, 1, 'function'),
    tk(1, 2, 'punctuation'),
    tk(2, 3, 'identifier'),
    tk(3, 4, 'punctuation'),
    tk(5, 6, 'punctuation'),
    tk(9, 10, 'identifier'),
    tk(10, 11, 'punctuation'),
    tk(12, 13, 'punctuation'),
  ],
  scopes: [
    {
      start: 0,
      end: 13,
      label: 'a()',
      kind: 'function_definition',
      children: [{ start: 5, end: 13, label: '{}', kind: 'block', children: [] }],
    },
  ],
};
const modelA = buildCharModel(srcA, 'javascript', analysisA);

await ok('cls: トークン写像+未カバーは plain(9)', () => {
  const { cls } = buildDifficultyInput(modelA);
  assert.deepEqual([...cls], [2, 8, 1, 8, 9, 8, 9, 9, 9, 1, 8, 9, 8, 9]);
});
await ok('depth: スコープ包含数(子が上書き、範囲外 0)', () => {
  const { depth } = buildDifficultyInput(modelA);
  assert.deepEqual([...depth], [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0]);
});
await ok('typable: skip===null(行頭インデント 2 セルのみ 0)', () => {
  const { typable, text } = buildDifficultyInput(modelA);
  assert.deepEqual([...typable], [1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1]);
  assert.equal(text, srcA);
});

// ---------------------------------------------------- computeDifficulty(値は Rust テストと相互検証済み)
console.log('computeDifficulty:');
await ok('手組みケース: 期待値どおり(cargo test 側とクロスチェック済みの値)', async () => {
  const bd = await computeDifficulty(modelA);
  assert.deepEqual(bd, {
    value: 1.4032,
    scoreVersion: 1,
    avgKeystrokeCost: 1.2,
    symbolDensity: 0.4167,
    nestDepthNorm: 0.1771,
    identRepetition: 0,
  });
});
await ok('plain(simple エンジン)は null(§2: 難易度算出不可)', async () => {
  const model = buildCharModel('hello world\n', 'plain');
  assert.equal(model.analysis.engine, 'simple');
  assert.equal(await computeDifficulty(model), null);
});

// ---------------------------------------------------- 実解析との統合(Tree-sitter 経由)
console.log('実解析統合(python):');
const py = [
  'import re',
  '',
  'def count_words(text):',
  '    # 単語を数える',
  '    words = re.findall(r"\\w+", text)',
  '    return len(words)',
  '',
].join('\n');
const analysisPy = await analyze(py, 'python');
const modelPy = buildCharModel(py, 'python', analysisPy);

await ok('difficulty が算出でき、各因子が定義域内', async () => {
  const bd = await computeDifficulty(modelPy);
  assert.notEqual(bd, null);
  assert.equal(bd.scoreVersion, 1);
  assert.ok(bd.value > 0.8 && bd.value < 1.8, `value=${bd.value}`);
  assert.ok(bd.avgKeystrokeCost >= 1.0, `avg=${bd.avgKeystrokeCost}`);
  for (const k of ['symbolDensity', 'nestDepthNorm', 'identRepetition']) {
    assert.ok(bd[k] >= 0 && bd[k] <= 1, `${k}=${bd[k]}`);
  }
});
await ok('決定的: 同一ソースの再解析でも完全一致(§6)', async () => {
  const model2 = buildCharModel(py, 'python', await analyze(py, 'python'));
  assert.deepEqual(await computeDifficulty(model2), await computeDifficulty(modelPy));
});
await ok('typable 配列が CharModel.typableCount と一致(コメント・インデントは母数外)', async () => {
  const { typable } = buildDifficultyInput(modelPy);
  const typableCount = [...typable].filter((t) => t === 1).length;
  assert.equal(typableCount, modelPy.typableCount);
});

// ---------------------------------------------------- ランキングスコア(§6)
console.log('rankingScore:');
await ok('補正スコア = WPM × 難易度 × 長さ係数', () => {
  assert.equal(rankingScore(40, { value: 1.25, scoreVersion: 1 }, 0.5), 25);
  assert.equal(rankingScore(60, { value: 1.3713, scoreVersion: 1 }, 1), 82.278);
  assert.equal(rankingScore(0, { value: 1.5, scoreVersion: 1 }, 1), 0);
});

console.log(`\n${n} 項目 全パス`);