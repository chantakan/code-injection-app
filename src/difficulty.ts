/**
 * difficulty.ts — 難易度エンジン連携(P3、§5/§6/§12)
 *
 * 責務:
 * - difficulty-engine(Rust/WASM)の遅延ロードと呼び出し
 * - CharModel → wasm 入力(セル=コードポイント単位の平行配列)の組み立て
 * - ランキングスコア合成(補正スコア = WPM × 難易度 × 長さ係数 §6)
 *
 * 設計:
 * - analyzer.ts と同じ注入式。Vite では wasmUrl(?url)を注入、
 *   Node テストでは fetchBytes と loadGlue を注入する
 * - 難易度は「全文字を打った場合」の値でファイル固有に固定(§6)。
 *   type-over 通過などプレイ内容には一切依存しない
 * - analysis.engine が 'simple'(plain / フォールバック)は難易度算出不可(§2)
 *   → computeDifficulty は null(ランキング投稿不可・補正スコア非表示)
 */

import type { CharModel, DifficultyBreakdown, DifficultyScore, ScopeNode } from './types';
import { TOKEN_CLASS_CODE } from './types';

// ---------------------------------------------------------------- 設定・初期化

/** wasm-pack --target web が生成するグルーの、この モジュールが使う表面 */
interface GlueModule {
  /** init。module_or_path に URL または wasm バイト列を渡す */
  default: (init?: { module_or_path: unknown }) => Promise<unknown>;
  scoreVersion: () => number;
  computeDifficulty: (
    text: string,
    cls: Uint8Array,
    depth: Uint16Array,
    typable: Uint8Array,
  ) => DifficultyBreakdown;
  lengthFactor: (typableCount: number) => number;
}

export interface DifficultyConfig {
  /**
   * 難易度 wasm の URL。Vite 側:
   * `import wasmUrl from './wasm/difficulty/difficulty_engine_bg.wasm?url'` を注入
   */
  wasmUrl?: string;
  /** wasm バイト列の取得(Node テスト用)。指定時は wasmUrl をこの関数に渡す */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /**
   * グルー JS のロード。既定はバンドラ解決の動的 import(Vite が chunk 化)。
   * Node テストではバンドル外の生成物を import する関数を注入する
   */
  loadGlue?: () => Promise<GlueModule>;
}

let config: DifficultyConfig = {};
let enginePromise: Promise<GlueModule> | null = null;
/** ロード完了後の同期アクセス用(lengthFactor) */
let engine: GlueModule | null = null;

/** 起動時に 1 回呼ぶ(main.ts)。ロード開始前なら何度でも設定し直せる */
export function initDifficulty(c: DifficultyConfig): void {
  config = { ...config, ...c };
}

async function ensureEngine(): Promise<GlueModule> {
  enginePromise ??= (async () => {
    const load =
      config.loadGlue ??
      (() =>
        import('./wasm/difficulty/difficulty_engine.js') as unknown as Promise<GlueModule>);
    const glue = await load();
    if (config.fetchBytes) {
      if (config.wasmUrl === undefined) {
        throw new Error('difficulty: fetchBytes 使用時は wasmUrl の指定が必要');
      }
      await glue.default({ module_or_path: await config.fetchBytes(config.wasmUrl) });
    } else if (config.wasmUrl !== undefined) {
      await glue.default({ module_or_path: config.wasmUrl });
    } else {
      // 既定解決(グルーが import.meta.url 相対で fetch)。Vite では wasmUrl 注入を推奨
      await glue.default();
    }
    engine = glue;
    return glue;
  })();
  return enginePromise;
}

/** wasm の事前ロード(任意)。解析中に並行で温めておく用 */
export async function preloadDifficulty(): Promise<void> {
  await ensureEngine();
}

// ------------------------------------------------------------ wasm 入力の組み立て

/**
 * CharModel → wasm への平行配列(Rust 側 compute_difficulty の契約)。
 * すべて cells インデックス(コードポイント)単位で 1:1。
 * - cls:     TokenSpan から写像(未カバーのセルは plain)
 * - depth:   ScopeNode 木の包含数(トップレベル外 = 0、直下 = 1、…)
 * - typable: CharCell.skip === null
 * テスト・§13 チューニングで中身を検分できるよう公開している
 */
export function buildDifficultyInput(model: CharModel): {
  text: string;
  cls: Uint8Array;
  depth: Uint16Array;
  typable: Uint8Array;
} {
  const n = model.cells.length;

  const cls = new Uint8Array(n).fill(TOKEN_CLASS_CODE.plain);
  for (const t of model.analysis.tokens) {
    const code = TOKEN_CLASS_CODE[t.cls];
    const end = Math.min(t.end, n);
    for (let i = Math.max(0, t.start); i < end; i++) cls[i] = code;
  }

  const depth = new Uint16Array(n);
  const mark = (node: ScopeNode, d: number): void => {
    const dd = Math.min(d, 0xffff);
    const end = Math.min(node.end, n);
    for (let i = Math.max(0, node.start); i < end; i++) depth[i] = dd;
    for (const child of node.children) mark(child, d + 1);
  };
  for (const root of model.analysis.scopes) mark(root, 1);

  const typable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const cell = model.cells[i];
    if (cell !== undefined && cell.skip === null) typable[i] = 1;
  }

  return { text: model.source, cls, depth, typable };
}

// ------------------------------------------------------------------- 公開 API

/**
 * ファイル固有の難易度スコア(§6)。決定的(同じ CharModel なら常に同じ値)。
 * analysis.engine が 'simple'(plain / フォールバック)は算出不可(§2)→ null
 */
export async function computeDifficulty(model: CharModel): Promise<DifficultyBreakdown | null> {
  if (model.analysis.engine !== 'tree-sitter') return null;
  // 打鍵対象 0(全文コメント・全文 CJK 等)は難易度が定義できない(wasm 側もエラー契約)
  if (model.typableCount === 0) return null;
  const g = await ensureEngine();
  const { text, cls, depth, typable } = buildDifficultyInput(model);
  return g.computeDifficulty(text, cls, depth, typable);
}

/**
 * 長さ係数(§6): min(1, √(typableCount/2000))。約 2000 文字まで逓減、以降 1.0。
 * wasm ロード後(computeDifficulty 解決後 or preloadDifficulty 後)なら同期で呼べる
 */
export function lengthFactor(typableCount: number): number {
  if (engine === null) {
    throw new Error('difficulty: wasm 未ロード(computeDifficulty か preloadDifficulty を先に)');
  }
  return engine.lengthFactor(Math.max(0, Math.floor(typableCount)));
}

/**
 * 補正スコア = WPM × 難易度 × 長さ係数(§6)。
 * 丸めはエンジン出力と同じ 1e-4(表示側でさらに丸めるのは自由)
 */
export function rankingScore(
  wpm: number,
  difficulty: DifficultyScore,
  lengthFactorValue: number,
): number {
  return Math.round(wpm * difficulty.value * lengthFactorValue * 10_000) / 10_000;
}