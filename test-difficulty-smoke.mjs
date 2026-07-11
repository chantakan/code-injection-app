/**
 * P3 難易度エンジン — wasm-pack ビルド後の Node スモークテスト(ブラウザ不要)
 * 実行: node test-difficulty-smoke.mjs
 * 前提: BUILD.md の手順で src/wasm/difficulty/ に生成物があること
 *
 * 期待値は difficulty-engine の cargo test(13項目)と同一値。
 * wasm 経由でも bit 単位に同じ結果になることの確認を兼ねる(決定性 §6)
 */
import { readFile } from 'node:fs/promises';
import init, {
  scoreVersion,
  computeDifficulty,
  lengthFactor,
} from './src/wasm/difficulty/difficulty_engine.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// TokenClass コード(types.ts TOKEN_CLASS_CODE と同値)
const I = 1; // identifier
const NUM = 5;
const OP = 7;
const PUNC = 8;
const PL = 9; // plain

/** 全セル打鍵対象・depth 0 の簡易呼び出し */
const calc = (text, cls, depth = null) => {
  const n = [...text].length;
  return computeDifficulty(
    text,
    new Uint8Array(cls),
    new Uint16Array(depth ?? n),
    new Uint8Array(n).fill(1),
  );
};

const bytes = await readFile(
  new URL('./src/wasm/difficulty/difficulty_engine_bg.wasm', import.meta.url),
);
await init({ module_or_path: bytes });

eq('scoreVersion() === 1', scoreVersion(), 1);

// ---- 長さ係数: min(1, √(n/2000))
eq('lengthFactor(300)(投稿下限)', lengthFactor(300), 0.3873);
eq('lengthFactor(500)', lengthFactor(500), 0.5);
eq('lengthFactor(1000)', lengthFactor(1000), 0.7071);
eq('lengthFactor(2000)', lengthFactor(2000), 1);
eq('lengthFactor(200000)', lengthFactor(200000), 1);

// ---- 基本: 'ab\n' 全部 1.0、同指なし、識別子 "ab"×1 → value 1.0/1.42
eq('基本文字のみ(1.0/1.42 正規化)', calc('ab\n', [I, I, PL]), {
  value: 0.7042,
  scoreVersion: 1,
  avgKeystrokeCost: 1,
  symbolDensity: 0,
  nestDepthNorm: 0,
  identRepetition: 0,
});

// ---- 同指連続: 'de'(左中指×2)→ e に ×1.2 → avg 1.1
eq('同指連続 ×1.2', calc('de', [I, I]).avgKeystrokeCost, 1.1);
// スペースで連鎖リセット
eq('スペースで連鎖リセット', calc('d e', [I, PL, I]).avgKeystrokeCost, 1);

// ---- 記号密度+数字段: 'x=1;' avg=1.15、密度('=' ';')0.5 → 1.15×1.75/1.42=1.4173
eq('記号密度・数字段', calc('x=1;', [I, OP, NUM, PUNC]), {
  value: 1.4173,
  scoreVersion: 1,
  avgKeystrokeCost: 1.15,
  symbolDensity: 0.5,
  nestDepthNorm: 0,
  identRepetition: 0,
});

// ---- 識別子反復率: 'aa aa' → 反復 0.5(=クリップ上限)、1.08×0.9/1.42=0.6845
eq('識別子反復率(クリップ0.5と同値)', calc('aa aa', [I, I, PL, I, I]), {
  value: 0.6845,
  scoreVersion: 1,
  avgKeystrokeCost: 1.08,
  symbolDensity: 0,
  nestDepthNorm: 0,
  identRepetition: 0.5,
});

// ---- ネスト深度: depth=4 → 0.5 → 1.1/1.42=0.7746 / depth=20 → クリップ 8 → 1.2/1.42=0.8451
eq('ネスト深度 4/8', calc('ab', [I, I], [4, 4]).value, 0.7746);
eq('ネスト深度クリップ(20→8)', calc('ab', [I, I], [20, 20]).value, 0.8451);

// ---- 遠い記号: '\`' avg 1.8、密度 1.0 → 1.8×2.5/1.42=3.169
eq('遠い記号(記号密度1.0)', calc('\\`', [OP, OP]).value, 3.169);

// ---- サロゲートペア 1 セル(表外文字 = 1.8)
eq('サロゲートペア 1 セル・表外 1.8', calc('𝒳', [I]).value, 1.2676);

// ---- スキップセルは母数外+隣接を詰めて同指判定('d[x skip]e' → 1.1)
{
  const bd = computeDifficulty(
    'dxe',
    new Uint8Array([I, I, I]),
    new Uint16Array(3),
    new Uint8Array([1, 0, 1]),
  );
  eq('スキップ除外+隣接詰め', bd.avgKeystrokeCost, 1.1);
}

// ---- 決定性: 同一入力 2 回で完全一致
{
  const text = 'def fib(n):\n    return fib(n-1) + fib(n-2)\n';
  const n = [...text].length;
  const args = [
    text,
    new Uint8Array(n).fill(PL),
    new Uint16Array(n).fill(1),
    new Uint8Array(n).fill(1),
  ];
  eq(
    '決定性(同一入力 2 回)',
    computeDifficulty(...args),
    computeDifficulty(...args),
  );
}

// ---- 契約違反 → 例外
let threw = false;
try {
  computeDifficulty('ab', new Uint8Array([1]), new Uint16Array(2), new Uint8Array(2));
} catch {
  threw = true;
}
eq('配列長不一致で例外', threw, true);

threw = false;
try {
  computeDifficulty('a', new Uint8Array([1]), new Uint16Array(1), new Uint8Array([0]));
} catch {
  threw = true;
}
eq('打鍵対象 0 文字で例外', threw, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);