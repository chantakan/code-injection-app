/**
 * test-charmodel.mjs — charModel P2(SourceAnalysis 消費)+ InputEngine 統合テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-charmodel.mjs
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  buildCharModel, InputEngine, initAnalyzer, analyze,
} from './.test/entry.bundle.mjs';

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };
/** source 上の部分文字列 → cells インデックス(コードポイント単位) */
const at = (model, sub, nth = 0) => {
  let idx = -1;
  for (let k = 0; k <= nth; k++) idx = model.source.indexOf(sub, idx + 1);
  assert.ok(idx >= 0, `"${sub}" が見つからない`);
  return [...model.source.slice(0, idx)].length;
};

// ---------------------------------------------------------------- P1 互換(analysis なし)
console.log('P1 互換(analysis 未指定 = simpleAnalyze):');
ok('CRLF/CR → LF 正規化', () => {
  const m = buildCharModel('a\r\nb\rc');
  assert.equal(m.source, 'a\nb\nc');
  assert.equal(m.lineCount, 3);
});
ok('行頭 // コメント行は改行ごとスキップ(確定事項 #3)', () => {
  const m = buildCharModel('// c\nx');
  const line0 = m.cells.filter((c) => c.line === 0);
  assert.ok(line0.every((c) => c.skip !== null));
  assert.equal(m.cells[m.cells.length - 1].skip, null); // 'x' は打鍵対象
});
ok('文中タブは skip:tab(確定事項 #2)', () => {
  const m = buildCharModel('a\tb');
  assert.equal(m.cells[1].skip, 'tab');
});
ok('括弧ペア + pair 役割(スタック方式)', () => {
  const m = buildCharModel('f(a[b])');
  const o = at(m, '('), c = at(m, ')'), so = at(m, '['), sc = at(m, ']');
  assert.equal(m.cells[o].match, c);
  assert.equal(m.cells[c].match, o);
  assert.equal(m.cells[so].match, sc);
  assert.equal(m.cells[o].pair, 'open');
  assert.equal(m.cells[c].pair, 'close');
});
ok('typableCount がインデント・コメントを除外', () => {
  const m = buildCharModel('  ab\n// c\n');
  // 打鍵対象: 'a','b',改行(0行目),改行(1行目はコメント行なのでスキップ)
  assert.equal(m.typableCount, 3);
});

// ---------------------------------------------------------------- Tree-sitter 統合
console.log('Tree-sitter 統合(javascript):');
const js = [
  'const s = "a(b";',
  'let x = arr[0];  // 行内コメント',
  '/* ブロック',
  '   コメント */',
  'const t = `x${y}z`;',
].join('\n');
const ja = await analyze(js, 'javascript');
const jm = buildCharModel(js, 'javascript', ja);

ok('文字列内の括弧はペアにならない(§3)', () => {
  const i = at(jm, '(', 0); // "a(b" の中の (
  assert.equal(jm.cells[i].match, -1);
  assert.equal(jm.cells[i].pair, null);
});
ok('文字列外の括弧はペアになる', () => {
  const o = at(jm, '['), c = at(jm, ']');
  assert.equal(jm.cells[o].match, c);
});
ok('クォート " が open/close で match', () => {
  const o = at(jm, '"', 0), c = at(jm, '"', 1);
  assert.equal(jm.cells[o].pair, 'open');
  assert.equal(jm.cells[c].pair, 'close');
  assert.equal(jm.cells[o].match, c);
  assert.equal(jm.cells[c].match, o);
});
ok('バッククォートも同様(§3)', () => {
  const o = at(jm, '`', 0), c = at(jm, '`', 1);
  assert.equal(jm.cells[o].pair, 'open');
  assert.equal(jm.cells[c].pair, 'close');
});
ok('行内コメント: 本体+直前空白がスキップ、行の改行は打つ(§3 Enter)', () => {
  const ci = at(jm, '// 行内コメント');
  assert.equal(jm.cells[ci].skip, 'comment');
  assert.equal(jm.cells[ci - 1].skip, 'comment'); // ; と // の間の空白(候補 #7)
  assert.equal(jm.cells[ci - 2].skip, 'comment');
  const semi = at(jm, ';', 1);
  assert.equal(jm.cells[semi].skip, null); // コードは打鍵対象のまま
  const nl = at(jm, '\n', 1); // 行内コメント行の改行
  assert.equal(jm.cells[nl].skip, null); // コードがある行の Enter はユーザーが打つ
});
ok('ブロックコメント: 内側の改行ごとスキップ', () => {
  const bi = at(jm, '/* ブロック');
  assert.equal(jm.cells[bi].skip, 'comment');
  const innerNl = at(jm, '\n', 2); // 「/* ブロック」行末の改行(コメントノード内)
  assert.equal(jm.cells[innerNl].skip, 'comment');
  const closeNl = at(jm, '\n', 3); // 「コメント */」行末(行に打鍵対象なし)
  assert.equal(jm.cells[closeNl].skip, 'comment');
});

console.log('Tree-sitter 統合(python):');
// ※ 先頭の """ を代入右辺にしてある: docstring は確定事項 #8 でコメント化され
//   ペア対象外になるため、三連クォートのペア検証は通常の文字列で行う
const py = 'def f():\n    s = """doc"""\n    return (1)\n';
const pa = await analyze(py, 'python');
const pm = buildCharModel(py, 'python', pa);
ok('三連クォート """ の3文字全てが open/close 役、先頭同士が match', () => {
  const o = at(pm, '"""', 0), c = at(pm, '"""', 1);
  for (let k = 0; k < 3; k++) {
    assert.equal(pm.cells[o + k].pair, 'open');
    assert.equal(pm.cells[c + k].pair, 'close');
  }
  assert.equal(pm.cells[o].match, c);
});
{
  const src = 'x = "abc\n';
  const m = buildCharModel(src, 'python', await analyze(src, 'python'));
  ok('未終端文字列はペア化されない', () => {
    const q = at(m, '"');
    assert.equal(m.cells[q].match, -1);
    assert.equal(m.cells[q].pair, null);
  });
}

// ------------------------------------- 打鍵不能文字の自動スキップ(確定事項 #9)
console.log('打鍵不能文字(非ASCII等)の自動スキップ:');
{
  const m = buildCharModel('x = "あい u"\n', 'plain');
  ok('非ASCII は skip:nonascii、同じ行の ASCII は打鍵対象のまま', () => {
    assert.equal(m.cells[at(m, 'あ')].skip, 'nonascii');
    assert.equal(m.cells[at(m, 'い')].skip, 'nonascii');
    assert.equal(m.cells[at(m, 'u')].skip, null);
    assert.equal(m.cells[at(m, '"')].skip, null);
    assert.equal(m.cells[at(m, '\n')].skip, null); // 打鍵対象がある行の Enter は打つ
  });
  ok('typableCount から nonascii が除外される', () => {
    // x, ' ', =, ' ', ", ' '(い の後), u, ", \n の 9 文字が打鍵対象
    assert.equal(m.typableCount, 9);
  });
}
{
  const m = buildCharModel('code()\nこの行は日本語だけ\n\nend\n', 'plain');
  ok('非ASCIIだけの行は改行ごとスキップ(Enter 不要)', () => {
    assert.equal(m.cells[at(m, '\n', 1)].skip, 'nonascii');
  });
  ok('コード行と空行の Enter は従来どおり打つ', () => {
    assert.equal(m.cells[at(m, '\n', 0)].skip, null); // code() 行
    assert.equal(m.cells[at(m, '\n', 2)].skip, null); // 空行
  });
  ok('制御文字(垂直タブ等)も nonascii', () => {
    const m2 = buildCharModel('a\u000bb\n', 'plain'); // a + 垂直タブ + b
    assert.equal(m2.cells[1].skip, 'nonascii');
    assert.equal(m2.typableCount, 3); // a, b, \n
  });
}

// ---------------------------------------------------------------- InputEngine 統合(§3)
console.log('InputEngine 統合(クォート type-over):');
const play = (model, keys) => {
  const e = new InputEngine(model);
  e.start(0);
  const results = [];
  let t = 0;
  for (const k of keys) results.push(e.handleKey(k, (t += 100)));
  return { e, results };
};

{
  const src = 'f("x");';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  ok('閉じクォート+閉じ括弧を ; で貪欲通過(§3)', () => {
    const { e, results } = play(m, ['f', '(', '"', 'x', ';']);
    const last = results[4];
    assert.equal(last.kind, 'pass');
    assert.deepEqual(last.passed, [at(m, '"', 1), at(m, ')')]);
    assert.equal(last.hitIndex, at(m, ';'));
    assert.equal(e.stats(500).passedCount, 2);
  });
  ok('中間の閉じ役(閉じ括弧)を直接ヒットも正解(確定事項 #4)', () => {
    const { results } = play(m, ['f', '(', '"', 'x', ')']);
    const last = results[4];
    assert.equal(last.kind, 'pass');
    assert.deepEqual(last.passed, [at(m, '"', 1)]);
    assert.equal(last.hitIndex, at(m, ')'));
  });
  ok('閉じクォートをそのまま打つのも正解', () => {
    const { results } = play(m, ['f', '(', '"', 'x', '"']);
    assert.equal(results[4].kind, 'hit');
  });
}
{
  const src = 'g("y")\nz';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  ok('閉じ役直後が改行なら Enter も通過トリガー(§3)', () => {
    const { results } = play(m, ['g', '(', '"', 'y', '\n']);
    const last = results[4];
    assert.equal(last.kind, 'pass');
    assert.deepEqual(last.passed, [at(m, '"', 1), at(m, ')')]);
    assert.equal(m.cells[last.hitIndex].ch, '\n');
  });
}
{
  // 文字列内の括弧が run を汚染しないこと: "a)b" の ) は pair なし
  const src = 'h("a)b");';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  ok('文字列内の閉じ括弧は type-over に関与しない', () => {
    const { results } = play(m, ['h', '(', '"', 'a', ')']);
    // カーソルは文字列内の ) 上 → pair なし → 通常ヒット
    assert.equal(results[4].kind, 'hit');
  });
}

console.log(`\n全 ${n} 項目パス`);