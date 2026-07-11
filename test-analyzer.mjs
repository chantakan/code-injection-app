/**
 * test-analyzer.mjs — analyzer.ts の Node 実挙動テスト(P2)
 * 実行: npx esbuild src/analyzer.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/analyzer.bundle.mjs && node test-analyzer.mjs
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { initAnalyzer, detectLanguage, analyze } from './.test/analyzer.bundle.mjs';

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});

const cp = (s) => [...s]; // コードポイント配列(cells と同じ数え方)
const sliceCells = (src, start, end) => cp(src).slice(start, end).join('');

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };

// ---------------------------------------------------------------- 言語判定
console.log('detectLanguage:');
ok('拡張子 .py', () => assert.deepEqual(detectLanguage('a.py', ''), { language: 'python', via: 'extension' }));
ok('拡張子 .tsx → typescript', () => assert.equal(detectLanguage('App.tsx', '').language, 'typescript'));
ok('拡張子 .lean → lean4', () => assert.equal(detectLanguage('Basic.lean', '').language, 'lean4'));
ok('ペースト: Python', () => {
  const d = detectLanguage(null, 'import os\n\ndef main(argv):\n    if argv:\n        return 1\n');
  assert.deepEqual(d, { language: 'python', via: 'heuristic' });
});
ok('ペースト: TypeScript', () => {
  const d = detectLanguage(null, 'export type A = { readonly x: number };\ninterface B { y: string }\n');
  assert.equal(d.language, 'typescript');
});
ok('ペースト: JavaScript(TS 語彙なし)', () => {
  const d = detectLanguage(null, 'const f = (x) => x * 2;\nfunction g() { return f(1); }\nconsole.log(g());\n');
  assert.equal(d.language, 'javascript');
});
ok('ペースト: Rust', () => {
  assert.equal(detectLanguage(null, 'pub fn main() {\n    let mut x = 0;\n}\n').language, 'rust');
});
ok('散文 → plain', () => {
  const d = detectLanguage(null, 'これはただの日本語の文章です。コードではありません。\n今日はいい天気。\n');
  assert.deepEqual(d, { language: 'plain', via: 'fallback' });
});

// ---------------------------------------------------------------- JavaScript
console.log('analyze(javascript):');
const js = [
  '// フィボナッチ 😀 絵文字入りコメント',            // 行コメント(絵文字=サロゲートペア)
  'function fib(n, memo = {}) {',
  '  if (n <= 1) return n; // 行内コメント',
  '  /* ブロック',
  '     コメント */',
  '  return `fib = ${fib(n - 1, memo)}`;',
  '}',
].join('\n');
const ja = await analyze(js, 'javascript');

ok('engine=tree-sitter / errorRatio=0', () => {
  assert.equal(ja.engine, 'tree-sitter');
  assert.equal(ja.errorRatio, 0);
});
ok('コメント3つ(行頭・行内・ブロック)', () => {
  assert.equal(ja.comments.length, 3);
  assert.deepEqual(ja.comments.map((c) => c.kind), ['line', 'line', 'block']);
});
ok('絵文字コメントでも span がセル単位で一致', () => {
  const c = ja.comments[0];
  assert.equal(sliceCells(js, c.start, c.end), '// フィボナッチ 😀 絵文字入りコメント');
});
ok('行内コメントの span 一致', () => {
  const c = ja.comments[1];
  assert.equal(sliceCells(js, c.start, c.end), '// 行内コメント');
});
ok('テンプレート文字列: openEnd/closeStart がバッククォート', () => {
  const s = ja.strings.find((x) => sliceCells(js, x.start, x.end).startsWith('`'));
  assert.ok(s);
  assert.equal(sliceCells(js, s.start, s.openEnd), '`');
  assert.equal(sliceCells(js, s.closeStart, s.end), '`');
});
ok('スコープ: fib() › if', () => {
  assert.equal(ja.scopes[0].label, 'fib()');
  assert.ok(ja.scopes[0].children.some((c) => c.label === 'if'));
});
ok('トークンが昇順・非重複', () => {
  for (let i = 1; i < ja.tokens.length; i++) assert.ok(ja.tokens[i].start >= ja.tokens[i - 1].end);
});
ok('function/keyword 分類', () => {
  const at = (cls) => ja.tokens.filter((t) => t.cls === cls).map((t) => sliceCells(js, t.start, t.end));
  assert.ok(at('keyword').includes('function'));
  assert.ok(at('function').includes('fib'));
});

// ---------------------------------------------------------------- Python
console.log('analyze(python):');
const py = [
  'class Foo:',
  '    """docstring です"""',
  '    def bar(self, x):',
  '        # コメント',
  "        s = f'x = {x}'",
  "        return '''",
  '        複数行',
  "        '''",
].join('\n');
const pa = await analyze(py, 'python');

ok('engine=tree-sitter / errorRatio=0', () => {
  assert.equal(pa.engine, 'tree-sitter');
  assert.equal(pa.errorRatio, 0);
});
ok("三連クォートの openEnd/closeStart(''' 文字列)", () => {
  // class docstring は確定事項 #8 でコメント化されたので、return の ''' で検証する
  const s = pa.strings.find((x) => sliceCells(py, x.start, x.end).startsWith("'''"));
  assert.ok(s);
  assert.equal(sliceCells(py, s.start, s.openEnd), "'''");
  assert.equal(sliceCells(py, s.closeStart, s.end), "'''");
});
ok('class docstring は block コメント扱い・strings に入らない(確定事項 #8)', () => {
  const c = pa.comments.find((x) => sliceCells(py, x.start, x.end).startsWith('"""docstring'));
  assert.ok(c);
  assert.equal(c.kind, 'block');
  assert.ok(!pa.strings.some((x) => sliceCells(py, x.start, x.end).startsWith('"""')));
});
ok("f-string: f' が開き・' が閉じ", () => {
  const s = pa.strings.find((x) => sliceCells(py, x.start, x.end).startsWith("f'"));
  assert.ok(s);
  assert.equal(sliceCells(py, s.start, s.openEnd), "f'");
  assert.equal(sliceCells(py, s.closeStart, s.end), "'");
});
ok('スコープ: class Foo › bar()', () => {
  assert.equal(pa.scopes[0].label, 'class Foo');
  assert.equal(pa.scopes[0].children[0].label, 'bar()');
});

// ------------------------------------------- docstring → コメント扱い(確定事項 #8)
console.log('docstring(python):');
const pyDoc = [
  '# ライセンスヘッダ',
  '"""モジュール docstring(日本語)"""',
  'def f():',
  "    '''関数 docstring'''",
  '    x = "not docstring"',
  '    return x',
].join('\n');
const pd = await analyze(pyDoc, 'python');
ok('モジュール/関数 docstring がコメント化(先頭の # は読み飛ばして判定)', () => {
  const texts = pd.comments.map((c) => sliceCells(pyDoc, c.start, c.end));
  assert.ok(texts.some((t) => t.startsWith('"""モジュール')));
  assert.ok(texts.some((t) => t.startsWith("'''関数")));
});
ok('先頭以外・代入右辺の文字列は通常どおり strings に残る', () => {
  const texts = pd.strings.map((s2) => sliceCells(pyDoc, s2.start, s2.end));
  assert.deepEqual(texts, ['"not docstring"']);
});
ok('docstring は tokens 上も comment 色(薄字ハイライト §9)', () => {
  const tok = pd.tokens.find((t) =>
    sliceCells(pyDoc, t.start, t.end).startsWith('"""モジュール'),
  );
  assert.ok(tok);
  assert.equal(tok.cls, 'comment');
});

// ---------------------------------------------------------------- TypeScript
console.log('analyze(typescript):');
const ts = 'interface P { x: number }\nconst f = (p: P): string => `v=${p.x}`;\n';
const ta = await analyze(ts, 'typescript');
ok('errorRatio=0 / interface スコープ', () => {
  assert.equal(ta.errorRatio, 0);
  assert.equal(ta.scopes[0].label, 'interface P');
});
ok('無名 arrow が代入先の名前を借りる: f()', () => {
  assert.ok(ta.scopes.some((s) => s.label === 'f()'));
});

// ---------------------------------------------------------------- ERROR 率と縮退
console.log('エラー処理:');
// 空白区切りの散文(英語等)は「識別子の連続」が構文エラーになり ERROR が大きく育つ
const prose = 'This is definitely not code. Just a plain sentence with words and punctuation!\n'.repeat(3);
const ga = await analyze(prose, 'javascript');
ok('散文(空白区切り)で errorRatio > 0.5 → 拒否対象(§4)', () =>
  assert.ok(ga.errorRatio > 0.5, `errorRatio=${ga.errorRatio}`));

// 既知の限界: CJK 散文は空白がなく巨大な 1 識別子として合法パースされ、率が上がらない。
// ただし CJK 散文は detectLanguage が 'plain' に落とすため実運用では §4 の網の手前で止まる
const cjk = await analyze('これはコードではない日本語の長文。}{)(;;\nまったく構文になっていない。\n', 'javascript');
ok('CJK 散文は率が育たない(既知の限界の記録)', () =>
  assert.ok(cjk.errorRatio > 0 && cjk.errorRatio < 0.5, `errorRatio=${cjk.errorRatio}`));

// 局所的なエラー(式の欠落)は小さな ERROR に留まる → 警告のみ(§4)
const ba = await analyze('const a = 1;\nconst b = ;\nconst c = 3;\n', 'javascript');
ok('局所エラーは 0 < ratio < 0.5 → 警告のみ(§4)', () =>
  assert.ok(ba.errorRatio > 0 && ba.errorRatio < 0.5, `errorRatio=${ba.errorRatio}`));

// 既知の性質: 閉じ忘れ括弧は復帰不能でファイル残り全部が ERROR に巻き込まれ、率が跳ね上がる。
// 「1 タイポの実コード」でも 50% 超 → §4 拒否になりうる(実測の記録。運用で問題になれば §13 で再検討)
const swallowed = await analyze('function f( {\n  return 1;\n}\nconst ok = 1;\n', 'javascript');
ok('閉じ忘れは残り全部を巻き込み高率になる(既知の性質の記録)', () =>
  assert.ok(swallowed.errorRatio > 0.5, `errorRatio=${swallowed.errorRatio}`));

{
  const a = await analyze('const s = "abc\n', 'javascript');
  const s = a.strings[0];
  ok('未終端文字列: closeStart === end(閉じ側なし)', () => {
    if (s !== undefined) assert.equal(s.closeStart, s.end); // ERROR 化して strings 空でも可
  });
}

// ---------------------------------------------------------------- 簡易フォールバック
console.log('簡易フォールバック:');
// ※ lean4 は RULES 登録済みになったため、未登録言語の代表は haskell(行コメント --)
const sa = await analyze('-- Haskell のコメント\nmain = putStrLn "hi"\n', 'haskell');
ok('wasm 未登録言語 → simple / -- コメント検出', () => {
  assert.equal(sa.engine, 'simple');
  assert.equal(sa.comments.length, 1);
  assert.equal(sa.errorRatio, 0);
});
// lean4: wasm があれば tree-sitter、無ければ簡易へ縮退(どちらでもコメントは拾える)
const la = await analyze('-- コメント\ntheorem t : 1 = 1 := rfl\n', 'lean4');
ok('lean4: wasm 有無に応じて tree-sitter / simple(コメント検出は共通)', () => {
  assert.ok(la.engine === 'tree-sitter' || la.engine === 'simple');
  assert.ok(la.comments.length >= 1);
});
const pl = await analyze('# メモ\nただのテキスト // これも\n', 'plain');
ok('plain: P1 互換(行頭 // と # のみ)', () => {
  assert.equal(pl.comments.length, 1); // 行内 // は拾わない
});

console.log(`\n全 ${n} 項目パス`);