/**
 * test-hud.mjs — hud P2(薄字ハイライト §9 / ブレッドクラム §9 / クォート pair-lit §3)
 * 実行: npm i -D jsdom してから
 *   npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *     --outfile=.test/entry.bundle.mjs && node test-hud.mjs
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  buildCharModel, InputEngine, initAnalyzer, analyze, Hud,
} from './.test/entry.bundle.mjs';

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});

const dom = new JSDOM(`<!DOCTYPE html><body>
  <span id="crumb"></span><span id="wpm"></span><span id="acc"></span>
  <span id="combo"></span><div id="comboFill"></div>
  <div id="code" tabindex="0"></div><div id="result" class="hidden"></div>
</body>`);
const doc = dom.window.document;
// jsdom 未実装 API のスタブ
dom.window.Element.prototype.scrollIntoView ??= () => {};
dom.window.matchMedia ??= () => ({ matches: false });

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };
const at = (model, sub, nth = 0) => {
  let idx = -1;
  for (let k = 0; k <= nth; k++) idx = model.source.indexOf(sub, idx + 1);
  assert.ok(idx >= 0, `"${sub}" が見つからない`);
  return [...model.source.slice(0, idx)].length;
};
const spans = () => [...doc.querySelectorAll('#code .ch')];

/** カーソル位置の正解キーを count 回自動打鍵して hud に反映 */
const autoType = (engine, hud, model, count) => {
  let t = 0;
  for (let k = 0; k < count && !engine.done; k++) {
    const cell = model.cells[engine.cursor];
    const res = engine.handleKey(cell.ch, (t += 50));
    hud.apply(res, engine.cursor, engine.hintActive);
  }
};

// ---------------------------------------------------------------- 薄字ハイライト
console.log('薄字シンタックスハイライト(§9):');
const js = [
  'function fib(n) {',
  '  if (n <= 1) return n; // メモ',
  '  return `f${n}`;',
  '}',
].join('\n');
const jm = buildCharModel(js, 'javascript', await analyze(js, 'javascript'));
const hud = new Hud(doc);
hud.mount(jm);

ok('span 数 = cells 数', () => assert.equal(spans().length, jm.cells.length));
ok('キーワードに tk-keyword', () => {
  const i = at(jm, 'function');
  assert.ok(spans()[i].classList.contains('tk-keyword'));
});
ok('関数名に tk-function', () => {
  const i = at(jm, 'fib');
  assert.ok(spans()[i].classList.contains('tk-function'));
});
ok('テンプレート文字列に tk-string', () => {
  const i = at(jm, '`');
  assert.ok(spans()[i].classList.contains('tk-string'));
});
ok('コメントは skip のみ(tk-* を付けない=§7 通電しない暗さ優先)', () => {
  const i = at(jm, '// メモ');
  const cl = spans()[i].classList;
  assert.ok(cl.contains('skip'));
  assert.ok(![...cl].some((c) => c.startsWith('tk-')));
});
ok('数字に tk-number', () => {
  const i = at(jm, '1');
  assert.ok(spans()[i].classList.contains('tk-number'));
});

// ---------------------------------------------------------------- ブレッドクラム
console.log('構造ブレッドクラム(§9):');
const engine = new InputEngine(jm);
engine.start(0);
hud.begin(engine.cursor);

ok('開始時: LINE 1/4 › fib()', () => {
  assert.match(doc.getElementById('crumb').textContent, /LINE 1\/4/);
  assert.match(doc.getElementById('crumb').textContent, /fib\(\)/);
});
ok('if の中に入ると › if が現れる', () => {
  // 2行目の "n <= 1" の n まで打鍵を進める(if_statement スコープ内)
  const target = at(jm, 'n <= 1');
  while (engine.cursor <= target && !engine.done) autoType(engine, hud, jm, 1);
  const crumb = doc.getElementById('crumb').textContent;
  assert.match(crumb, /fib\(\)/);
  assert.match(crumb, /if/);
});
ok('セパレータは textContent 描画(innerHTML 不使用の確認)', () => {
  assert.ok(doc.querySelectorAll('#crumb .sep').length >= 1);
  assert.ok(doc.querySelectorAll('#crumb .seg').length >= 2);
});

// ---------------------------------------------------------------- pair-lit / passed
console.log('クォートの pair-lit と type-over 描画(§3):');
{
  const src = 'f("x");';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  const h = new Hud(doc);
  h.mount(m);
  const e = new InputEngine(m);
  e.start(0);
  h.begin(e.cursor);

  autoType(e, h, m, 3); // f ( " まで打鍵
  ok('開きクォートを打つと閉じクォートが pair-lit', () => {
    assert.ok(spans()[at(m, '"', 1)].classList.contains('pair-lit'));
  });

  // x のあと ';' で閉じクォート+閉じ括弧を貪欲通過
  let res = e.handleKey('x', 900); h.apply(res, e.cursor, e.hintActive);
  res = e.handleKey(';', 1000); h.apply(res, e.cursor, e.hintActive);
  ok('通過した閉じクォート/閉じ括弧が passed(中抜き表示)', () => {
    assert.equal(res.kind, 'pass');
    assert.ok(spans()[at(m, '"', 1)].classList.contains('passed'));
    assert.ok(spans()[at(m, ')')].classList.contains('passed'));
    assert.ok(spans()[at(m, ';')].classList.contains('done'));
  });
  ok('passed は done を持たない(WPM 非加算の視覚的対応 §3)', () => {
    assert.ok(!spans()[at(m, ')')].classList.contains('done'));
  });
}

console.log(`\n全 ${n} 項目パス`);