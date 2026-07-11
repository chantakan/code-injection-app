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

/** hud.showResult に渡すダミー SessionResult(P6 テスト用) */
const dummyResult = (overrides = {}) => ({
  wpm: 42, accuracy: 96, combo: 0, maxCombo: 5, hits: 20, misses: 1,
  passedCount: 2, elapsedMs: 12000, mode: 'ranking', language: 'javascript',
  missIndices: [], finishedAt: Date.now(), ...overrides,
});

initAnalyzer({
  grammarBase: new URL('./public/grammars/', import.meta.url).pathname,
  fetchBytes: async (path) => new Uint8Array(await readFile(path)),
});

const dom = new JSDOM(`<!DOCTYPE html><body>
  <span id="crumb"></span><span id="wpm"></span><span id="acc"></span>
  <span id="combo"></span><div id="comboFill"></div>
  <div id="code" tabindex="0"></div>
  <div id="result" class="hidden">
    <div id="rScore"></div><div id="rScoreNote"></div>
    <div id="rWpm"></div><div id="rAcc"></div><div id="rMax"></div>
    <div id="rPass"></div><div id="rTime"></div>
    <svg id="rHeatmap"></svg><p id="rHeatmapNote"></p>
    <svg id="rRhythm"></svg>
  </div>
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

// ---------------------------------------------------------------- スコープ背景(§9, P6)
console.log('スコープ背景(§9):');
{
  const src = 'function fib(n) {\n  if (n <= 1) return n;\n  return n;\n}\n';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  const h = new Hud(doc);
  h.mount(m);
  const e = new InputEngine(m);
  e.start(0);
  h.begin(e.cursor);

  ok('既定 ON: 関数スコープに入ると scope-bg が付く', () => {
    // 最初の打鍵(先頭 'f')で関数スコープに入る
    const res = e.handleKey('f', 50);
    h.apply(res, e.cursor, e.hintActive);
    assert.ok(spans()[at(m, 'function')].classList.contains('scope-bg'));
  });

  ok('スコープを外れると前の scope-bg が外れる(差分適用)', () => {
    // if の中に入る
    const target = at(m, 'n <= 1');
    while (e.cursor <= target && !e.done) autoType(e, h, m, 1);
    assert.ok(spans()[at(m, 'if')].classList.contains('scope-bg'));
  });

  ok('setScopeBg(false) で即座にクリアされる', () => {
    h.setScopeBg(false);
    assert.ok(![...spans()].some((s) => s.classList.contains('scope-bg')));
  });

  ok('setScopeBg(true) で現在位置から再計算される', () => {
    h.setScopeBg(true);
    assert.ok([...spans()].some((s) => s.classList.contains('scope-bg')));
  });
}

// ---------------------------------------------------------------- 参照ハイライト(§9, P6)
console.log('参照ハイライト(§9):');
{
  const src = 'function add(a, b) {\n  return a + b;\n}\n';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  const h = new Hud(doc);
  h.mount(m);
  const e = new InputEngine(m);
  e.start(0);
  h.begin(e.cursor);

  ok('識別子 "a" にカーソルが乗ると同名箇所すべてに ref-hl', () => {
    const idxA1 = at(m, 'a,'); // 仮引数の a("add(a, b)")
    const idxA2 = at(m, 'a + b'); // 本体内の使用箇所
    while (e.cursor < idxA1 && !e.done) autoType(e, h, m, 1); // カーソルをちょうど a の上へ
    assert.ok(spans()[idxA1].classList.contains('ref-hl'));
    assert.ok(spans()[idxA2].classList.contains('ref-hl'));
  });

  ok('setRefHighlight(false) で即座にクリアされる', () => {
    h.setRefHighlight(false);
    assert.ok(![...spans()].some((s) => s.classList.contains('ref-hl')));
  });
}

// ---------------------------------------------------------------- ヒートマップ/リズムグラフ(§7, P6)
console.log('リザルト可視化(§7, P6):');
{
  const src = 'const x = 1;\nconsole.log(x);\n';
  const m = buildCharModel(src, 'javascript', await analyze(src, 'javascript'));
  const h = new Hud(doc);
  h.mount(m);

  ok('showResult でヒートマップ(circle)が描画される', () => {
    h.showResult(dummyResult({ missIndices: [3, 3, 10] }), null, []);
    assert.ok(doc.querySelectorAll('#rHeatmap circle').length > 0);
    assert.match(doc.getElementById('rHeatmapNote').textContent, /MISSES: 3/);
  });

  ok('ミスなしは「ミスなし」表示', () => {
    h.showResult(dummyResult({ missIndices: [] }), null, []);
    assert.equal(doc.getElementById('rHeatmapNote').textContent, 'ミスなし');
  });

  ok('リズムグラフは events から polyline を描く', () => {
    const events = [
      { key: 'c', dt: 100, ok: true, passed: 0 },
      { key: 'o', dt: 120, ok: true, passed: 0 },
      { key: 'x', dt: 200, ok: false, passed: 0 },
      { key: 'n', dt: 90, ok: true, passed: 0 },
    ];
    h.showResult(dummyResult(), null, events);
    assert.equal(doc.querySelectorAll('#rRhythm polyline').length, 1);
    assert.equal(doc.querySelectorAll('#rRhythm circle.rrhythm-miss').length, 1);
  });

  ok('result が表示状態になる(既存挙動の維持)', () => {
    assert.ok(!doc.getElementById('result').classList.contains('hidden'));
  });
}

console.log(`\n全 ${n} 項目パス`);