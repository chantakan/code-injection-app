/**
 * storage.ts — ローカル履歴・ゴースト保存(P5、§11)
 *
 * §11: 履歴・ゴーストは localStorage(クライアント端末内、サーバー送信なし・Cookie 不使用)。
 *
 * 設計:
 * - Storage 注入式(Node テストではインメモリ実装を渡す)。既定はブラウザの localStorage
 * - localStorage が使えない環境(プライベートモード・容量超過等)でもプレイを壊さない:
 *   すべての操作を try/catch し、失敗は「保存されないだけ」に留める
 * - ゴーストは sourceHash ごとにベスト 1 件(WPM 比較)。値は encodeReplay 済み文字列を
 *   そのまま持つ(展開せず保存 = URL 共有と同一表現 §11)
 * - 履歴は新しい順に最大 HISTORY_MAX 件。ホーム画面での一覧表示は P6(§7)
 */

import type { HistoryEntry } from './types';

const HISTORY_KEY = 'codeinject.history.v1';
const GHOST_PREFIX = 'codeinject.ghost.v1.';
export const HISTORY_MAX = 50;

/** localStorage 互換の最小インターフェース(テスト注入用) */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** sourceHash ごとのベストゴースト(§10/§11) */
export interface GhostRecord {
  /** 記録時の WPM(ベスト判定に使う) */
  wpm: number;
  /** encodeReplay 済み文字列 */
  encoded: string;
  savedAt: number;
}

export class LocalStore {
  private readonly s: StorageLike | null;

  /** @param storage 省略時はブラウザの localStorage(無い環境では null = 常に no-op) */
  constructor(storage?: StorageLike | null) {
    this.s =
      storage !== undefined
        ? storage
        : typeof localStorage === 'undefined'
          ? null
          : localStorage;
  }

  // ------------------------------------------------------------ 履歴(§7 ホーム用)

  /** ローカル履歴(新しい順)。壊れたデータは空扱い */
  history(): HistoryEntry[] {
    const raw = this.get(HISTORY_KEY);
    if (raw === null) return [];
    try {
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** 履歴に 1 件追加(先頭 = 最新、HISTORY_MAX 件で切り捨て) */
  addHistory(entry: HistoryEntry): void {
    const next = [entry, ...this.history()].slice(0, HISTORY_MAX);
    this.set(HISTORY_KEY, JSON.stringify(next));
  }

  // ------------------------------------------------------------ ゴースト(§10)

  /** sourceHash のベストゴースト。無ければ null */
  ghost(sourceHash: string): GhostRecord | null {
    const raw = this.get(GHOST_PREFIX + sourceHash);
    if (raw === null) return null;
    try {
      const o: unknown = JSON.parse(raw);
      if (
        typeof o === 'object' && o !== null &&
        typeof (o as GhostRecord).wpm === 'number' &&
        typeof (o as GhostRecord).encoded === 'string'
      ) {
        return o as GhostRecord;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 今回の走りがベストなら上書き保存(§10 ゴースト保存)。
   * @returns 保存された(=自己ベスト更新)か
   */
  saveGhostIfBetter(sourceHash: string, encoded: string, wpm: number, savedAt: number): boolean {
    const cur = this.ghost(sourceHash);
    if (cur !== null && cur.wpm >= wpm) return false;
    const rec: GhostRecord = { wpm, encoded, savedAt };
    return this.set(GHOST_PREFIX + sourceHash, JSON.stringify(rec));
  }

  // ------------------------------------------------------------ 低レベル(全部 no-throw)

  private get(key: string): string | null {
    try {
      return this.s?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private set(key: string, value: string): boolean {
    try {
      this.s?.setItem(key, value);
      return this.s !== null;
    } catch {
      return false; // 容量超過等。プレイは続行(§11 保存されないだけ)
    }
  }
}