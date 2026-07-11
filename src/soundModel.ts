/**
 * soundModel.ts — サウンドの純粋ロジック(P4、§8)
 *
 * Web Audio / DOM に一切依存しない決定的なロジックだけを置く(Node 単体テスト可能)。
 * 出音(オシレータ生成・スケジューリング)は sound.ts が担当し、このモジュールの
 * 判断結果(音程・音色・ドローン層数・リズム安定)を消費する。
 *
 * §8 の対応関係:
 * - 音程: 行内の桁位置ベース(右へ行くほど高い)→ pitchForCol
 * - スケール: マイナーペンタトニック固定 → PENTA / arpeggioSemitone
 * - 音色: トークン種別で変える(識別子=柔/記号=パーカッシブ/キーワード=太)→ timbreForClass
 * - コンボ: ドローン(持続低音)が積層 → droneLayersForCombo / DRONE_OFFSETS
 * - リズム安定でアルペジオ追加 → RhythmTracker
 */

import type { TokenClass, TokenSpan } from './types';

// ---------------------------------------------------------------- 音程(§8)

/** マイナーペンタトニック(半音オフセット)。§8: スケール固定 */
export const PENTA = [0, 3, 5, 7, 10] as const;
export const BASE_FREQ = 220;
/** このコラム数ごとに 1 オクターブ上げる(モックv2 準拠) */
export const COLS_PER_OCTAVE = 14;
export const MAX_OCTAVE_UP = 2;

/** 桁位置 → マイナーペンタトニック上の周波数(P1 sound.ts から移設。挙動不変) */
export function pitchForCol(col: number): number {
  const c = Math.max(0, col);
  const step =
    (PENTA[c % PENTA.length] ?? 0) +
    12 * Math.min(Math.floor(c / COLS_PER_OCTAVE), MAX_OCTAVE_UP);
  return BASE_FREQ * Math.pow(2, step / 12);
}

// ---------------------------------------------------------------- 音色(§8)

/**
 * 打鍵音の音色。§8「識別子=柔、記号=パーカッシブ、キーワード=太」。
 * sound.ts がオシレータ波形・エンベロープに写像する
 */
export type Timbre = 'soft' | 'perc' | 'bold';

/**
 * トークン種別 → 音色(§8)。
 * - keyword → bold(太)
 * - operator / punctuation → perc(記号=パーカッシブ)
 * - それ以外(identifier / function / type / string / number / plain)→ soft(柔)。
 *   comment は打鍵対象にならない(§3 自動スキップ)ため実際には来ない
 */
export function timbreForClass(cls: TokenClass): Timbre {
  switch (cls) {
    case 'keyword':
      return 'bold';
    case 'operator':
    case 'punctuation':
      return 'perc';
    default:
      return 'soft';
  }
}

/**
 * cells インデックス → TokenClass(二分探索)。
 * tokens は SourceAnalysis の契約どおり「重複しない昇順ソート済み」であること。
 * どのスパンにも覆われない位置は 'plain'
 */
export function tokenClassAt(tokens: readonly TokenSpan[], index: number): TokenClass {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (t === undefined) break;
    if (index < t.start) hi = mid - 1;
    else if (index >= t.end) lo = mid + 1;
    else return t.cls;
  }
  return 'plain';
}

// ---------------------------------------------------------------- ドローン(§8)

/**
 * ドローン積層の定義(§8: コンボで持続低音が積み上がる)。
 * - root: 低い A(BASE_FREQ の 2 オクターブ下)。打鍵音のペンタトニックと同根音
 * - offsets: 各層の半音オフセット(根音/5度/オクターブ/オクターブ+5度 = 常に協和)
 * - thresholds: combo がこの値以上で層が 1 枚ずつ増える(§13 扱いの初期値)
 */
export const DRONE = {
  rootFreq: BASE_FREQ / 4, // 55 Hz
  offsets: [0, 7, 12, 19] as const,
  thresholds: [5, 12, 25, 45] as const,
} as const;

/** combo → ドローン層数(0〜DRONE.offsets.length)。ミスで combo が 0 に戻ると全剥がれ */
export function droneLayersForCombo(combo: number): number {
  let layers = 0;
  for (const th of DRONE.thresholds) if (combo >= th) layers++;
  return layers;
}

/** ドローン第 n 層(0-based)の周波数 */
export function droneFreq(layer: number): number {
  const off = DRONE.offsets[Math.max(0, Math.min(layer, DRONE.offsets.length - 1))] ?? 0;
  return DRONE.rootFreq * Math.pow(2, off / 12);
}

// ---------------------------------------------------------------- アルペジオ(§8)

/**
 * アルペジオの音列: ペンタトニックを 1 オクターブ上り下りするサイクル
 * (0,3,5,7,10,12,10,7,5,3 …)。step は単調増加のカウンタでよい
 */
export function arpeggioSemitone(step: number): number {
  const up = [...PENTA, 12];
  const cycle = [...up, ...up.slice(1, -1).reverse()]; // 0,3,5,7,10,12,10,7,5,3
  return cycle[((step % cycle.length) + cycle.length) % cycle.length] ?? 0;
}

/** アルペジオ発動条件・テンポの定数(§13 扱いの初期値。耳で調整する) */
export const ARP = {
  /** リズム判定に使う直近の打鍵間隔の数 */
  windowSize: 8,
  /** 変動係数(標準偏差÷平均)がこれ未満なら「リズム安定」 */
  cvThreshold: 0.35,
  /** この間隔(ms)を超える打鍵間隔は「休止」としてリズムをリセット */
  pauseMs: 900,
  /** アルペジオの発音間隔の下限/上限(ms)。打鍵テンポ(中央値)をこの範囲に丸める */
  minIntervalMs: 110,
  maxIntervalMs: 450,
} as const;

/**
 * リズム安定判定(§8: リズム安定でアルペジオ追加)。
 * 打鍵間隔(ms)を push し、直近 windowSize 個の変動係数で安定を判定する。
 * 純粋ロジック: 時刻は呼び出し側が計測して間隔だけを渡す
 */
export class RhythmTracker {
  private dts: number[] = [];

  /** 打鍵間隔を記録する。長い休止はリズムの断絶としてリセット */
  push(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs < 0) return;
    if (dtMs > ARP.pauseMs) {
      this.reset();
      return;
    }
    this.dts.push(dtMs);
    if (this.dts.length > ARP.windowSize) this.dts.shift();
  }

  /** ミス・完了などでリズムを断ち切る */
  reset(): void {
    this.dts = [];
  }

  /** 直近 windowSize 打鍵が揃っていて、間隔のばらつきが小さいか */
  get stable(): boolean {
    if (this.dts.length < ARP.windowSize) return false;
    const mean = this.dts.reduce((a, b) => a + b, 0) / this.dts.length;
    if (mean <= 0) return false;
    const varsum = this.dts.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    const cv = Math.sqrt(varsum / this.dts.length) / mean;
    return cv < ARP.cvThreshold;
  }

  /** 打鍵間隔の中央値(ms)。アルペジオのテンポに使う。データ不足は null */
  get medianDt(): number | null {
    if (this.dts.length === 0) return null;
    const sorted = [...this.dts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const v =
      sorted.length % 2 === 1
        ? sorted[mid]
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    return v ?? null;
  }

  /** アルペジオの発音間隔(ms)。打鍵テンポを ARP.min/max に丸める。不安定時 null */
  get arpIntervalMs(): number | null {
    if (!this.stable) return null;
    const m = this.medianDt;
    if (m === null) return null;
    return Math.min(ARP.maxIntervalMs, Math.max(ARP.minIntervalMs, m));
  }
}