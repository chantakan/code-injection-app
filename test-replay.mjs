/**
 * test-replay.mjs — P5(リプレイ符号化 / ゴースト再生 / ローカル保存)単体テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-replay.mjs
 * 前提: Node 18+(crypto.subtle / CompressionStream / Blob / Response)
 */
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  buildCharModel, InputEngine,
  hashSource, encodeReplay, decodeReplay,
  GhostPlayer, LocalStore, HISTORY_MAX,
} from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };
const okAsync = async (name, fn) => { await fn(); console.log(`  ok ${++n}: ${name}`); };

// ---------------------------------------------------------------- sourceHash(§11)
console.log('sourceHash(SHA-256):');
await okAsync('決定的で 64 桁 hex', async () => {
  const a = await hashSource('const x = 1;\n');
  const b = await hashSource('const x = 1;\n');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
await okAsync('原文が 1 文字違えばハッシュも違う', async () => {
  assert.notEqual(await hashSource('a'), await hashSource('b'));
});

// ---------------------------------------------------------------- 記録の準備
// 'const a = (1);\n' を plain(simpleAnalyze)で写経: hit 連続+ミス 1+type-over 1+Enter
const TEXT = 'const a = (1);\n';
const model = buildCharModel(TEXT);
const engine = new InputEngine(model);
engine.start(0);
let t = 0;
const step = (key) => engine.handleKey(key, (t += 100));
for (const ch of 'const a = (1') step(ch); // 12 打鍵(全部 hit)
assert.equal(step('x').kind, 'miss');      // ')' の位置でミス(詰まる §3)
assert.equal(step(';').kind, 'pass');      // ')' を type-over 通過して ';' に着地(§3)
assert.equal(step('\n').kind, 'hit');      // Enter で完走
assert.equal(engine.done, true);
const HASH = await hashSource(model.source);
const replay = engine.replay(HASH);

// ---------------------------------------------------------------- 符号化(§11)
console.log('encodeReplay / decodeReplay(§11):');
await okAsync('往復でイベント列・メタが完全一致', async () => {
  const enc = await encodeReplay(replay);
  assert.match(enc, /^[A-Za-z0-9_-]+$/); // Base64URL(# 以降にそのまま置ける)
  const dec = await decodeReplay(enc);
  assert.deepEqual(dec, replay);
});
await okAsync('sourceHash 未設定でも往復可(P1〜P4 互換)', async () => {
  const noHash = engine.replay();
  const dec = await decodeReplay(await encodeReplay(noHash));
  assert.deepEqual(dec, noHash);
  assert.equal('sourceHash' in dec, false);
});
await okAsync('ゴミ文字列は例外(URL は信用しない)', async () => {
  await assert.rejects(() => decodeReplay('こんにちは'));
  await assert.rejects(() => decodeReplay('AAAA')); // deflate でない
});
const craft = (obj) => Buffer.from(deflateRawSync(JSON.stringify(obj))).toString('base64url');
await okAsync('形式検証: バージョン・列長・値域の不正を拒否', async () => {
  const base = { f: 1, l: 'plain', m: 'ranking', h: '', k: 'ab', d: [1, 2], x: [], p: [] };
  await decodeReplay(craft(base)); // これは通る(基準)
  await assert.rejects(() => decodeReplay(craft({ ...base, f: 2 })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, l: 'cobol' })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, d: [1] })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, d: [1, -2] })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, x: [9] })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, p: [[0, 0]] })), /replay/);
  await assert.rejects(() => decodeReplay(craft({ ...base, h: 'zz' })), /replay/);
});
await okAsync('数千打鍵でも数 KB(§11 の想定)', async () => {
  const big = new InputEngine(buildCharModel('abcdefghij\n'.repeat(300)));
  big.start(0);
  let bt = 0;
  for (const ch of 'abcdefghij\n'.repeat(300)) big.handleKey(ch, (bt += 137));
  assert.equal(big.done, true);
  const enc = await encodeReplay(big.replay(HASH));
  assert.ok(enc.length < 8_000, `URL ハッシュが ${enc.length} 文字(3300 打鍵)`);
});

// ---------------------------------------------------------------- ゴースト再生(§10)
console.log('GhostPlayer(§10 決定的再生):');
ok('経過時間に応じてカーソルが本走と同じ位置を辿る', () => {
  const g = new GhostPlayer(buildCharModel(TEXT), replay);
  assert.equal(g.cursorAt(99), 0);   // 最初の打鍵前
  assert.equal(g.cursorAt(100), 1);  // 'c' を打った直後
  assert.equal(g.cursorAt(1150), 11); // 11 打目('(')まで消化 → idx 11
  assert.equal(g.cursorAt(1250), 12); // 12 打目('1')まで消化 → ')' 上
});
ok('ミスでは進まず、type-over 通過はまとめて跳ぶ', () => {
  const g = new GhostPlayer(buildCharModel(TEXT), replay);
  const atMiss = g.cursorAt(1300);   // 13 個目のイベント=ミス
  assert.equal(atMiss, 12);          // '(1' まで入力済み、')' で詰まったまま
  const afterPass = g.cursorAt(1400); // ';' で ')' を貪欲通過(§3)
  assert.equal(afterPass, 14);       // ');' を越えて改行セルへ
});
ok('完走後は範囲外を返し done になる', () => {
  const g = new GhostPlayer(buildCharModel(TEXT), replay);
  assert.equal(g.totalMs, 1500);
  assert.equal(g.cursorAt(1500), [...TEXT].length);
  assert.equal(g.done, true);
  assert.equal(g.cursorAt(99999), [...TEXT].length); // 以降も安定
});

// ---------------------------------------------------------------- 保存(§11)
console.log('LocalStore(localStorage 注入式):');
const fakeStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
};
const entry = (i) => ({
  finishedAt: 1000 + i, language: 'javascript', fileName: `f${i}.js`,
  wpm: 40 + i, accuracy: 98, score: 400 + i, sourceHash: 'h'.repeat(64), typableCount: 500,
});
ok('履歴は新しい順・上限で切り捨て', () => {
  const st = new LocalStore(fakeStorage());
  for (let i = 0; i < HISTORY_MAX + 5; i++) st.addHistory(entry(i));
  const h = st.history();
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0].finishedAt, 1000 + HISTORY_MAX + 4); // 最新が先頭
});
ok('ゴーストは WPM ベストのみ上書き(§10)', () => {
  const st = new LocalStore(fakeStorage());
  assert.equal(st.saveGhostIfBetter('hashA', 'enc1', 40, 1), true);  // 初回
  assert.equal(st.saveGhostIfBetter('hashA', 'enc2', 35, 2), false); // 遅い → 保存しない
  assert.equal(st.ghost('hashA').encoded, 'enc1');
  assert.equal(st.saveGhostIfBetter('hashA', 'enc3', 55, 3), true);  // 更新
  assert.equal(st.ghost('hashA').wpm, 55);
  assert.equal(st.ghost('hashB'), null); // 別ファイルには波及しない
});
ok('壊れた保存データは空/null 扱い(例外にしない)', () => {
  const s = fakeStorage();
  s.setItem('codeinject.history.v1', '{{{broken');
  s.setItem('codeinject.ghost.v1.hashA', '42');
  const st = new LocalStore(s);
  assert.deepEqual(st.history(), []);
  assert.equal(st.ghost('hashA'), null);
});
ok('storage 不可(quota / 無効)でも例外を漏らさない(§11)', () => {
  const st = new LocalStore({
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  });
  assert.deepEqual(st.history(), []);
  st.addHistory(entry(0)); // 投げないこと
  assert.equal(st.saveGhostIfBetter('h', 'e', 40, 1), false);
  const none = new LocalStore(null); // storage 自体が無い環境
  assert.equal(none.saveGhostIfBetter('h', 'e', 40, 1), false);
});

console.log(`\n全 ${n} 項目パス`);