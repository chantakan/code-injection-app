/**
 * ghost.ts — ゴーストレース再生(P5、§10)
 *
 * リプレイ(§11 の {文字, 時刻差分, 正誤, 通過フラグ})を InputEngine にそのまま
 * 流し込んで、経過時間に応じたゴーストのカーソル位置を決定的に再現する。
 *
 * 設計:
 * - 判定ロジックを複製しない: 本物の InputEngine を時刻注入(dt の累積)で駆動する。
 *   type-over 貪欲通過・スキップ・詰まる方式が本走とビット単位で同じ挙動になる
 * - DOM 非依存・純粋(Node テスト可能)。描画(ゴーストカーソルの span 移動)は hud、
 *   時間の供給(経過 ms)は main が行う
 * - ミスイベントは handleKey がミスとして食う(カーソルは進まない)= 本走の詰まりも再現
 */

import type { CharModel, Replay } from './types';
import { InputEngine } from './input';

export class GhostPlayer {
  private readonly engine: InputEngine;
  private readonly events: Replay['events'];
  /** 各イベントの発生時刻(開始からの累積 ms) */
  private readonly times: number[];
  private next = 0;

  /** ゴーストの総所要時間(ms)。進捗表示などに使える */
  readonly totalMs: number;

  /**
   * @param model  今回プレイと同一の CharModel(sourceHash 一致を呼び出し側で確認すること)
   * @param replay 過去の走り(自己ベスト or 共有 URL 由来)
   */
  constructor(model: CharModel, replay: Replay) {
    this.engine = new InputEngine(model, replay.mode);
    this.engine.start(0);
    this.events = replay.events;
    let t = 0;
    this.times = this.events.map((ev) => (t += ev.dt));
    this.totalMs = t;
  }

  /**
   * 開始からの経過 ms までのイベントを消化し、ゴーストのカーソル位置を返す。
   * 単調増加の elapsed で呼ぶこと(巻き戻しは非対応 = リプレイは前進のみ)。
   * 完走後は cells.length(=範囲外)を返し続ける
   */
  cursorAt(elapsedMs: number): number {
    while (this.next < this.events.length) {
      const t = this.times[this.next];
      if (t === undefined || t > elapsedMs) break;
      const ev = this.events[this.next];
      if (ev !== undefined) this.engine.handleKey(ev.key, t);
      this.next++;
    }
    return this.engine.cursor;
  }

  get done(): boolean {
    return this.engine.done;
  }
}