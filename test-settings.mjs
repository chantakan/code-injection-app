/**
 * test-settings.mjs — P6 設定画面(§7, §9)の永続化単体テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-settings.mjs
 */
import assert from 'node:assert/strict';
import { SettingsStore } from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };

const fakeStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

console.log('SettingsStore(localStorage 注入式):');

ok('初期値は既定(演出強度 normal / スコープ背景・参照ハイライト ON)', () => {
  const st = new SettingsStore(fakeStorage());
  assert.deepEqual(st.get(), { effectLevel: 'normal', scopeBg: true, refHighlight: true });
});

ok('部分更新は他フィールドを保持する', () => {
  const st = new SettingsStore(fakeStorage());
  const next = st.set({ effectLevel: 'off' });
  assert.deepEqual(next, { effectLevel: 'off', scopeBg: true, refHighlight: true });
  st.set({ scopeBg: false });
  assert.deepEqual(st.get(), { effectLevel: 'off', scopeBg: false, refHighlight: true });
});

ok('別インスタンス(同じ storage)でも保存値を読める', () => {
  const s = fakeStorage();
  new SettingsStore(s).set({ refHighlight: false, effectLevel: 'low' });
  const st2 = new SettingsStore(s);
  assert.deepEqual(st2.get(), { effectLevel: 'low', scopeBg: true, refHighlight: false });
});

ok('壊れた保存値(JSON パース不可)は既定値にフォールバック', () => {
  const s = fakeStorage();
  s.setItem('codeinject.settings.v1', '{{{not json');
  const st = new SettingsStore(s);
  assert.deepEqual(st.get(), { effectLevel: 'normal', scopeBg: true, refHighlight: true });
});

ok('不正な値(型不一致・列挙外)は該当フィールドだけ既定値に置換', () => {
  const s = fakeStorage();
  s.setItem('codeinject.settings.v1', JSON.stringify({ effectLevel: 'ultra', scopeBg: 'yes', refHighlight: false }));
  const st = new SettingsStore(s);
  assert.deepEqual(st.get(), { effectLevel: 'normal', scopeBg: true, refHighlight: false });
});

ok('storage 不可(quota / 無効)でも例外を漏らさない(§11 と同じ no-throw 方針)', () => {
  const st = new SettingsStore({
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  });
  assert.deepEqual(st.get(), { effectLevel: 'normal', scopeBg: true, refHighlight: true });
  const next = st.set({ effectLevel: 'off' }); // 投げないこと。メモリ上には反映される
  assert.equal(next.effectLevel, 'off');
  assert.equal(st.get().effectLevel, 'off'); // キャッシュから読める(保存はできていない)

  const none = new SettingsStore(null); // storage 自体が無い環境
  assert.deepEqual(none.get(), { effectLevel: 'normal', scopeBg: true, refHighlight: true });
  assert.equal(none.set({ effectLevel: 'low' }).effectLevel, 'low');
});

console.log(`\n全 ${n} 項目パス`);
