/**
 * measure-difficulty.mjs — 難易度の実測一覧(P3 ステップ5、§13 係数チューニング用)
 *
 * 実行(entry / difficulty バンドルが生成済みであること):
 *   npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *     --outfile=.test/entry.bundle.mjs
 *   npx esbuild src/difficulty.ts --bundle --format=esm \
 *     --external:./wasm/difficulty/difficulty_engine.js \
 *     --outfile=.test/difficulty.bundle.mjs
 *   node measure-difficulty.mjs <file> [file...]
 *
 * 出力列: TYPABLE=打鍵対象文字数 / ERR%=構文ERROR率 / AVGCOST=平均打鍵コスト /
 *         SYM=記号密度 / NEST=正規化ネスト深度 / IDREP=識別子反復率 /
 *         VALUE=難易度 / LENF=長さ係数
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  initAnalyzer,
  detectLanguage,
  analyze,
  buildCharModel,
  normalizeNewlines,
} from './.test/entry.bundle.mjs';
import {
  initDifficulty,
  computeDifficulty,
  lengthFactor,
  preloadDifficulty,
} from './.test/difficulty.bundle.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node measure-difficulty.mjs <file> [file...]');
  process.exit(1);
}

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});
initDifficulty({
  wasmUrl: new URL('./src/wasm/difficulty/difficulty_engine_bg.wasm', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
  loadGlue: () => import('./src/wasm/difficulty/difficulty_engine.js'),
});
await preloadDifficulty();

const rows = [];
for (const f of files) {
  const source = normalizeNewlines(await readFile(f, 'utf-8'));
  const det = detectLanguage(basename(f), source);
  const analysis = await analyze(source, det.language, basename(f));
  const model = buildCharModel(source, det.language, analysis);
  const bd = await computeDifficulty(model);
  rows.push({
    file: basename(f),
    lang: det.language,
    engine: analysis.engine,
    err: analysis.errorRatio,
    typable: model.typableCount,
    bd,
    lf: bd === null ? null : lengthFactor(model.typableCount),
  });
}

const pad = (v, w) => String(v).padStart(w);
console.log(
  [
    'FILE'.padEnd(26),
    'LANG'.padEnd(10),
    pad('TYPABLE', 7),
    pad('ERR%', 5),
    pad('AVGCOST', 7),
    pad('SYM', 6),
    pad('NEST', 6),
    pad('IDREP', 6),
    pad('VALUE', 7),
    pad('LENF', 6),
  ].join('  '),
);
for (const r of rows) {
  const head = `${r.file.padEnd(26)}  ${r.lang.padEnd(10)}  ${pad(r.typable, 7)}  ${pad((r.err * 100).toFixed(1), 5)}`;
  if (r.bd === null) {
    console.log(`${head}  --- 難易度算出不可(engine=${r.engine} §2)`);
    continue;
  }
  console.log(
    [
      head,
      pad(r.bd.avgKeystrokeCost.toFixed(4), 7),
      pad(r.bd.symbolDensity.toFixed(4), 6),
      pad(r.bd.nestDepthNorm.toFixed(4), 6),
      pad(r.bd.identRepetition.toFixed(4), 6),
      pad(r.bd.value.toFixed(4), 7),
      pad(r.lf.toFixed(4), 6),
    ].join('  '),
  );
}
console.log('\n調整目標(§6): Python 入門 ≒ 1.0 / 正規表現まみれ ≒ 1.5');
console.log('(公開前なので係数調整は scoreVersion 1 のまま行う)');