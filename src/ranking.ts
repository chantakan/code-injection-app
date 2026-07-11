/**
 * ranking.ts — ランキングAPIクライアント層(§6, §11, §12, P7)
 *
 * server/rank.php と通信するだけの薄い層。DOM に依存しない。他フェーズ
 * (analyzer.ts の initAnalyzer / difficulty.ts の initDifficulty)と同じ注入式設計:
 * エンドポイントと fetch 実装を initRanking() で差し替え可能にし、Node からテストできる
 * ようにする(import.meta.env はプレーンな esbuild バンドルでは未定義になるため、
 * ライブラリ内から直接参照しない。値の解決は main.ts が行い、ここに注入する)。
 *
 * - wpm/accuracy/postedAt はサーバー側で replay から再計算・確定するため送信しない(§13)
 * - 投稿資格(score !== null && typableCount >= LIMITS.minTypableForRanking §6)の判定は
 *   呼び出し側(main.ts)の責務。ここでは行わない
 */

import type { RankingApiError, RankingEntry, RankingMap, RankingSubmitResponse } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RankingConfig {
  /** POST/GET 先。既定は同一オリジン相対パス(dist/ と server/ を同じドメイン配下に置く §11) */
  endpoint: string;
  fetchImpl: FetchLike;
}

const DEFAULT_ENDPOINT = './server/rank.php';

// 素の `fetch` 参照をそのまま config に渡すと `config.fetchImpl(...)` 呼び出し時に
// `this` が window から外れ「Illegal invocation」で落ちる(ブラウザ組み込みAPIの既知の罠)。
// アロー関数で包んで呼び出し形に依存しないようにする
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

let config: RankingConfig = {
  endpoint: DEFAULT_ENDPOINT,
  fetchImpl: defaultFetch,
};

/**
 * 起動時に main.ts から呼ぶ。VITE_RANKING_API_URL(未設定なら既定の相対パス)や
 * テスト用のモック fetch をここで注入する
 */
export function initRanking(opts: Partial<RankingConfig>): void {
  config = { ...config, ...opts };
}

function isApiError(data: unknown): data is RankingApiError {
  return typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === false;
}

/** ランキング一覧取得(§7 ランキング画面)。失敗時は例外を投げる(呼び出し側でトースト表示) */
export async function fetchRankings(): Promise<RankingMap> {
  let res: Response;
  try {
    res = await config.fetchImpl(config.endpoint, { method: 'GET' });
  } catch {
    throw new Error('通信に失敗しました(オフライン?)');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('サーバー応答の形式が不正です');
  }
  if (isApiError(data)) throw new Error(data.message);
  const rankings = (data as { rankings?: unknown }).rankings;
  if (typeof rankings !== 'object' || rankings === null) {
    throw new Error('サーバー応答の形式が不正です');
  }
  return rankings as RankingMap;
}

/**
 * ランキング投稿。ネットワーク断・サーバーエラー・検証エラーのいずれも例外を投げず、
 * ok で判別可能な値を返す(呼び出し側は if (result.ok) で分岐するだけでよい)
 */
export async function submitRanking(entry: RankingEntry): Promise<RankingSubmitResponse | RankingApiError> {
  let res: Response;
  try {
    res = await config.fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch {
    return { ok: false, error: 'network-error', message: '通信に失敗しました(オフライン?)' };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'invalid-response', message: 'サーバー応答の形式が不正です' };
  }
  if (isApiError(data)) return data;
  const d = data as Partial<RankingSubmitResponse>;
  if (d.ok !== true || !Array.isArray(d.entries)) {
    return { ok: false, error: 'invalid-response', message: 'サーバー応答の形式が不正です' };
  }
  return { ok: true, rank: d.rank ?? null, entries: d.entries };
}
