/**
 * rhythm.ts — リズムグラフの集計(P6、§7/§10)
 *
 * Replay.events(§11 の {文字, 時刻差分, 正誤, 通過フラグ})から、経過時間に対する
 * 打鍵速度の推移(x=経過時間の割合、y=速度)を組み立てる。ミスは別系列(t のみ)で返し、
 * 描画側(hud.ts)が折れ線の上に赤点として重ねる。
 *
 * §8 の RhythmTracker(アルペジオの安定判定)とは目的が異なる: あちらは「直近が安定して
 * いるか」の二値判定、こちらは全走行を可視化するための連続系列。ロジックは独立させる。
 *
 * DOM 非依存の純関数(Node テスト可能)。
 */

import type { ReplayEvent, RhythmPoint, RhythmSeries } from './types';

/** これ以下の打鍵間隔は最速(v=1)扱い */
const V_MIN_DT = 40;
/** これ以上の打鍵間隔は最遅(v=0)扱い(§8 ARP.pauseMs=900 と揃えた休止相当) */
const V_MAX_DT = 900;

function speedFromDt(dt: number): number {
  const clamped = Math.min(V_MAX_DT, Math.max(V_MIN_DT, dt));
  return 1 - (clamped - V_MIN_DT) / (V_MAX_DT - V_MIN_DT);
}

export function buildRhythmSeries(events: readonly ReplayEvent[]): RhythmSeries {
  if (events.length === 0) return { points: [], misses: [] };

  const totalMs = events.reduce((sum, ev) => sum + ev.dt, 0);
  const points: RhythmPoint[] = [];
  const misses: number[] = [];
  let cum = 0;

  for (const ev of events) {
    cum += ev.dt;
    const t = totalMs > 0 ? cum / totalMs : 0;
    if (ev.ok) points.push({ t, v: speedFromDt(ev.dt) });
    else misses.push(t);
  }

  return { points, misses };
}
