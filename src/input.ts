/**
 * input.ts — 入力エンジン(P1: 詰まる方式 + 括弧 type-over)
 *
 * 責務(§3):
 * - 完全一致判定と「詰まる方式」(正しい文字を打つまで idx が進まない)
 * - 括弧 type-over: 閉じ括弧上では「その括弧を打つ / run 内の後続閉じ括弧を打つ /
 *   run 直後の打鍵対象文字を打つ(改行なら Enter)」が正解(確認済み事項 #4: 中間ヒット可)
 * - スキップ(インデント/コメント/文中タブ)の自動通過
 * - 統計(WPM/ACC/コンボ)とリプレイ記録(§11)。通過は WPM の打鍵数に数えない
 *
 * 設計:
 * - DOM 非依存・時刻は全て引数 now(ms)で受け取る(テスト・リプレイ再生を決定的にするため)
 * - キーの正規化(KeyboardEvent.key → 1文字 / '\n')は呼び出し側(main.ts)が行う。
 *   Tab は呼び出し側で preventDefault して渡さない(§3)
 * - 描画側は KeyResult と cursor の移動範囲から差分クラスを導出する(hud.ts)
 */

import type {
  CharModel,
  KeyResult,
  LiveStats,
  PlayMode,
  Replay,
  ReplayEvent,
  SessionResult,
} from './types';
import { ENGINE } from './types';

export class InputEngine {
  readonly model: CharModel;
  readonly mode: PlayMode;

  private idx = 0;
  private started = false;
  private finished = false;
  private startTime = 0;
  private lastEventTime = 0;
  private finishTime: number | null = null;

  private hits = 0;
  private misses = 0;
  private combo = 0;
  private maxCombo = 0;
  private missStreak = 0;
  private passedCount = 0;
  private missIndices: number[] = [];
  private events: ReplayEvent[] = [];

  constructor(model: CharModel, mode: PlayMode = 'ranking') {
    // P1 は詰まる方式のみ。practice(バックスペース可)は将来実装(§3)
    this.model = model;
    this.mode = mode;
  }

  /** 現在のカーソル位置(cells インデックス)。done 時は cells.length */
  get cursor(): number {
    return this.idx;
  }

  get done(): boolean {
    return this.finished;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** プレイ開始。行頭のスキップ(コメント行等)を自動通過する */
  start(now: number): void {
    if (this.started) return;
    this.started = true;
    this.startTime = now;
    this.lastEventTime = now;
    this.advanceSkips();
    this.checkFinish(now); // 全文スキップ(コメントのみ等)の即完了に対応
  }

  /**
   * 1 打鍵の処理。
   * @param key 正規化済みキー(1 文字 or '\n')
   * @param now 打鍵時刻(performance.now() 系の単調時刻)
   */
  handleKey(key: string, now: number): KeyResult {
    if (!this.started || this.finished) return { kind: 'ignored' };
    if (key !== '\n' && [...key].length !== 1) return { kind: 'ignored' };

    const cur = this.model.cells[this.idx];
    if (cur === undefined) return { kind: 'ignored' };

    // --- 完全一致 ---
    if (key === cur.ch) {
      const index = this.idx;
      this.recordEvent(key, now, true, 0);
      this.onHit();
      this.idx = index + 1;
      this.advanceSkips();
      this.checkFinish(now);
      return { kind: 'hit', index };
    }

    // --- type-over(カーソルが閉じ役=閉じ括弧/閉じクォート上のときだけ発動 §3) ---
    // P2: 判定は cell.pair(クォートは開閉同一文字のため文字では判定できない)
    if (cur.pair === 'close') {
      const t = this.tryTypeOver(key);
      if (t !== null) {
        this.recordEvent(key, now, true, t.passed.length);
        this.passedCount += t.passed.length;
        this.onHit(); // ヒット扱いは hitIndex の 1 文字のみ。通過分は数えない(§3)
        this.idx = t.hitIndex + 1;
        this.advanceSkips();
        this.checkFinish(now);
        return { kind: 'pass', passed: t.passed, hitIndex: t.hitIndex };
      }
    }

    // --- ミス(詰まる) ---
    this.recordEvent(key, now, false, 0);
    this.misses++;
    this.combo = 0;
    this.missStreak++;
    this.missIndices.push(this.idx);
    return { kind: 'miss', index: this.idx, missStreak: this.missStreak };
  }

  /** 救済ヒント(§3: 同一箇所 3 連続ミスで正解文字を黄色強調)を出すべきか */
  get hintActive(): boolean {
    return this.missStreak >= ENGINE.hintAfterMisses;
  }

  stats(now: number): LiveStats {
    const elapsedMs = Math.max(0, (this.finishTime ?? now) - this.startTime);
    const minutes = elapsedMs / 60_000;
    const total = this.hits + this.misses;
    return {
      wpm: minutes > 0 ? this.hits / 5 / minutes : 0,
      accuracy: total > 0 ? (this.hits / total) * 100 : 100,
      combo: this.combo,
      maxCombo: this.maxCombo,
      hits: this.hits,
      misses: this.misses,
      passedCount: this.passedCount,
      elapsedMs,
    };
  }

  /**
   * 確定リザルト(§10)。
   * @param now 単調時刻(elapsed 計算用)
   * @param wallClock 履歴表示用の epoch ms(テストでは固定値を渡す)
   */
  result(now: number, wallClock: number = Date.now()): SessionResult {
    return {
      ...this.stats(now),
      mode: this.mode,
      language: this.model.language,
      missIndices: [...this.missIndices],
      finishedAt: wallClock,
    };
  }

  /**
   * リプレイ(§11)。
   * @param sourceHash 原文の SHA-256(replay.hashSource)。P5 から保存・共有時は必須
   *                   (ゴースト照合 §10・投稿検証 P7 の鍵)。テスト等では省略可
   */
  replay(sourceHash?: string): Replay {
    return {
      formatVersion: 1,
      language: this.model.language,
      mode: this.mode,
      ...(sourceHash !== undefined ? { sourceHash } : {}),
      events: [...this.events],
    };
  }

  // ------------------------------------------------------------ 内部処理

  /**
   * type-over の走査。カーソルから閉じ括弧とスキップの連続(run)を前方走査し、
   * - run 内の後続の閉じ括弧が key に一致 → そこまで通過してヒット(中間ヒット)
   * - run 直後の打鍵対象文字が key に一致 → run 全体を通過してヒット(貪欲通過)
   * のいずれかで {通過した閉じ括弧, ヒット位置} を返す。不成立なら null。
   * run は改行で止まる(改行セルは閉じ括弧でもスキップでもないため)。
   * 閉じ括弧直後が改行なら key='\n'(Enter)が「直後の文字」に一致する(§3)。
   */
  private tryTypeOver(key: string): { passed: number[]; hitIndex: number } | null {
    const cells = this.model.cells;
    const passed: number[] = [];
    let j = this.idx;

    while (j < cells.length) {
      const cell = cells[j];
      if (cell === undefined) break;

      if (cell.skip !== null) {
        j++; // スキップセルは run に巻き込む(通過リストには入れない)
        continue;
      }

      if (cell.pair === 'close') {
        if (j > this.idx && cell.ch === key) {
          return { passed, hitIndex: j }; // 中間の閉じ括弧を直接ヒット
        }
        passed.push(j);
        j++;
        continue;
      }

      // run 終端(閉じ括弧でもスキップでもない最初のセル)
      return cell.ch === key ? { passed, hitIndex: j } : null;
    }
    return null; // 末尾まで閉じ括弧/スキップのみで key に届かなかった
  }

  private onHit(): void {
    this.hits++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.missStreak = 0;
  }

  private advanceSkips(): void {
    const cells = this.model.cells;
    while (this.idx < cells.length) {
      const cell = cells[this.idx];
      if (cell === undefined || cell.skip === null) break;
      this.idx++;
    }
  }

  private checkFinish(now: number): void {
    if (this.idx >= this.model.cells.length && !this.finished) {
      this.finished = true;
      this.finishTime = now;
    }
  }

  private recordEvent(key: string, now: number, ok: boolean, passed: number): void {
    this.events.push({
      key,
      dt: Math.max(0, Math.round(now - this.lastEventTime)),
      ok,
      passed,
    });
    this.lastEventTime = now;
  }
}