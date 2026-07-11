/**
 * heatmap.ts — ミス箇所ヒートマップの集計(P6、§7「回路基板風」)
 *
 * SessionResult.missIndices(cells インデックス、重複あり = 同一箇所を繰り返しミスすると
 * 複数回入る)を、ソース全体を覆う固定数のバケットに集約する。
 *
 * 描画側(hud.ts)はこの結果をスネーク配列(偶数行=左→右、奇数行=右→左)のまま
 * 格子点として並べれば、隣接ノードを順につなぐだけで基板のトレースのような
 * ジグザグの配線になる(§7 の「回路基板風」演出)。
 *
 * DOM 非依存の純関数(Node テスト可能)。
 */

import type { CharModel, HeatmapData, HeatmapNode } from './types';

const DEFAULT_COLS = 8;
/** バケット数の上限(短いファイルはこれより少ない粒度になる) */
const MAX_BUCKETS = 64;

/**
 * @param model        ミスが起きたセッションと同一の CharModel(cells.length で正規化)
 * @param missIndices  SessionResult.missIndices(§10)。範囲外の添字は無視する
 * @param cols         格子の列数(既定 8)。バケット数がこれ未満なら実際の列数に合わせて縮める
 */
export function buildHeatmap(
  model: CharModel,
  missIndices: readonly number[],
  cols: number = DEFAULT_COLS,
): HeatmapData {
  const total = model.cells.length;
  if (total === 0 || cols < 1) {
    return { nodes: [], cols: 0, rows: 0, maxCount: 0, totalMisses: missIndices.length };
  }

  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, total));
  const counts = new Array<number>(bucketCount).fill(0);
  for (const idx of missIndices) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue; // 壊れた入力への耐性
    const b = Math.min(bucketCount - 1, Math.floor((idx / total) * bucketCount));
    counts[b] = (counts[b] ?? 0) + 1;
  }

  let maxCount = 0;
  for (const c of counts) if (c > maxCount) maxCount = c;

  const effectiveCols = Math.min(cols, bucketCount);
  const rows = Math.ceil(bucketCount / effectiveCols);
  const nodes: HeatmapNode[] = counts.map((count, i) => {
    const row = Math.floor(i / effectiveCols);
    // スネーク配列: 偶数行は左→右、奇数行は右→左(基板配線の折り返し)
    const posInRow = i % effectiveCols;
    const col = row % 2 === 0 ? posInRow : effectiveCols - 1 - posInRow;
    const start = Math.floor((i / bucketCount) * total);
    const end = i === bucketCount - 1 ? total : Math.floor(((i + 1) / bucketCount) * total);
    return { col, row, count, intensity: maxCount > 0 ? count / maxCount : 0, start, end };
  });

  return { nodes, cols: effectiveCols, rows, maxCount, totalMisses: missIndices.length };
}
