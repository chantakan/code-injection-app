/**
 * test-sound.mjs — soundModel.ts(P4 純粋ロジック)単体テスト
 * 実行: npx esbuild src/soundModel.ts --bundle --format=esm \
 *         --outfile=.test/sound.bundle.mjs && node test-sound.mjs
 * ※ 出音(sound.ts)は Web Audio 依存のためここでは対象外。e2e で配線エラーなしを確認する
 */
import assert from 'node:assert/strict';
import {
  PENTA, BASE_FREQ, COLS_PER_OCTAVE, MAX_OCTAVE_UP,
  pitchForCol, timbreForClass, tokenClassAt,
  DRONE, droneLayersForCombo, droneFreq,
  arpeggioSemitone, ARP, RhythmTracker,
} from './.test/sound.bundle.mjs';

let n = 0;
const ok = (name, fn) => { fn(); console.log(`  ok ${++n}: ${name}`); };
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// ---------------------------------------------------------------- 音程(§8)
console.log('音程(桁位置→ペンタトニック §8):');
ok('col 0 は基音 220Hz', () => approx(pitchForCol(0), BASE_FREQ));
ok('col 1..4 はペンタトニックを上る', () => {
  for (let i = 1; i < PENTA.length; i++) {
    approx(pitchForCol(i), BASE_FREQ * Math.pow(2, PENTA[i] / 12));
  }
});
ok('COLS_PER_OCTAVE ごとに 1 オクターブ上がる', () => {
  approx(pitchForCol(COLS_PER_OCTAVE), pitchForCol(COLS_PER_OCTAVE % PENTA.length) * 2);
});
ok('オクターブ上限 MAX_OCTAVE_UP でクランプ', () => {
  const deep = COLS_PER_OCTAVE * (MAX_OCTAVE_UP + 3); // 上限の遥か先の桁
  const capped = pitchForCol(deep);
  const step = PENTA[deep % PENTA.length] + 12 * MAX_OCTAVE_UP;
  approx(capped, BASE_FREQ * Math.pow(2, step / 12));
});
ok('負の col は 0 扱い(防御)', () => approx(pitchForCol(-5), BASE_FREQ));

// ---------------------------------------------------------------- 音色(§8)
console.log('音色写像(識別子=柔/記号=パーカッシブ/キーワード=太 §8):');
ok('keyword → bold', () => assert.equal(timbreForClass('keyword'), 'bold'));
ok('operator / punctuation → perc', () => {
  assert.equal(timbreForClass('operator'), 'perc');
  assert.equal(timbreForClass('punctuation'), 'perc');
});
ok('identifier / function / type / string / number / plain → soft', () => {
  for (const cls of ['identifier', 'function', 'type', 'string', 'number', 'plain']) {
    assert.equal(timbreForClass(cls), 'soft');
  }
});

// ---------------------------------------------------------------- tokenClassAt
console.log('tokenClassAt(二分探索):');
const tokens = [
  { start: 0, end: 3, cls: 'keyword' },     // 0,1,2
  { start: 4, end: 7, cls: 'identifier' },  // 4,5,6
  { start: 7, end: 8, cls: 'punctuation' }, // 7
  { start: 12, end: 20, cls: 'string' },
];
ok('スパン内は該当 cls(境界含む)', () => {
  assert.equal(tokenClassAt(tokens, 0), 'keyword');
  assert.equal(tokenClassAt(tokens, 2), 'keyword');
  assert.equal(tokenClassAt(tokens, 4), 'identifier');
  assert.equal(tokenClassAt(tokens, 7), 'punctuation');
  assert.equal(tokenClassAt(tokens, 19), 'string');
});
ok('半開区間: end 位置は含まない', () => {
  assert.equal(tokenClassAt(tokens, 3), 'plain'); // keyword の end
  assert.equal(tokenClassAt(tokens, 20), 'plain');
});
ok('隙間・範囲外・空配列は plain', () => {
  assert.equal(tokenClassAt(tokens, 9), 'plain');
  assert.equal(tokenClassAt(tokens, 999), 'plain');
  assert.equal(tokenClassAt([], 0), 'plain');
});

// ---------------------------------------------------------------- ドローン(§8)
console.log('ドローン積層(combo → 層数 §8):');
ok('combo 0 は 0 層(ミスで全剥がれ)', () => assert.equal(droneLayersForCombo(0), 0));
ok('閾値ごとに 1 層ずつ積み上がる', () => {
  const th = DRONE.thresholds;
  for (let i = 0; i < th.length; i++) {
    assert.equal(droneLayersForCombo(th[i] - 1), i);
    assert.equal(droneLayersForCombo(th[i]), i + 1);
  }
});
ok('上限は offsets の枚数', () =>
  assert.equal(droneLayersForCombo(9999), DRONE.offsets.length));
ok('層の周波数は root/5度/oct/oct+5度(常に協和)', () => {
  approx(droneFreq(0), DRONE.rootFreq);
  approx(droneFreq(1), DRONE.rootFreq * Math.pow(2, 7 / 12));
  approx(droneFreq(2), DRONE.rootFreq * 2);
  approx(droneFreq(3), DRONE.rootFreq * Math.pow(2, 19 / 12));
});

// ---------------------------------------------------------------- アルペジオ(§8)
console.log('アルペジオ(音列とリズム安定 §8):');
ok('音列はペンタトニックの上り下りサイクル', () => {
  const expected = [0, 3, 5, 7, 10, 12, 10, 7, 5, 3];
  for (let i = 0; i < expected.length * 2; i++) {
    assert.equal(arpeggioSemitone(i), expected[i % expected.length]);
  }
});
ok('一定リズムで安定(stable)になる', () => {
  const r = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) r.push(150);
  assert.equal(r.stable, true);
  assert.equal(r.medianDt, 150);
  assert.equal(r.arpIntervalMs, 150);
});
ok('窓が埋まるまでは不安定', () => {
  const r = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize - 1; i++) r.push(150);
  assert.equal(r.stable, false);
  assert.equal(r.arpIntervalMs, null);
});
ok('ばらついたリズムは不安定', () => {
  const r = new RhythmTracker();
  const jitter = [60, 480, 90, 400, 70, 500, 80, 450];
  for (const dt of jitter.slice(0, ARP.windowSize)) r.push(dt);
  assert.equal(r.stable, false);
});
ok('長い休止(pauseMs 超)でリセット', () => {
  const r = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) r.push(150);
  r.push(ARP.pauseMs + 1);
  assert.equal(r.stable, false);
  assert.equal(r.medianDt, null);
});
ok('reset() でリズム断絶(ミス時に使う)', () => {
  const r = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) r.push(150);
  r.reset();
  assert.equal(r.stable, false);
});
ok('アルペジオ間隔は min/max にクランプ', () => {
  const fast = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) fast.push(50); // 高速タイパー
  assert.equal(fast.arpIntervalMs, ARP.minIntervalMs);
  const slow = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) slow.push(800); // ゆっくり(pause 未満)
  assert.equal(slow.arpIntervalMs, ARP.maxIntervalMs);
});
ok('不正値(負・NaN)は無視される', () => {
  const r = new RhythmTracker();
  for (let i = 0; i < ARP.windowSize; i++) r.push(150);
  r.push(-10);
  r.push(Number.NaN);
  assert.equal(r.stable, true); // 窓は壊れない
});

console.log(`\n全 ${n} 項目パス`);