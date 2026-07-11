/**
 * CODE://INJECT — 共有型定義
 *
 * 全フェーズ(P1〜P7)の共有契約。handoff.md の §番号を各所に併記する。
 * ここを変更するときは handoff.md との整合を先に確認すること。
 *
 * 方針:
 * - このファイルは DOM に依存しない(描画用の要素参照などは持たない)。
 *   モックv2の chars[].el のような DOM 参照は renderer 側で別管理する。
 * - 改行は charModel 構築時に LF('\n')へ正規化する(CRLF/CR 対応)。
 */

// ---------------------------------------------------------------- 言語・モード

/** 対応言語(§2)。判定と Tree-sitter は P2。P1 では常に 'plain' */
export type LanguageId =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'c'
  | 'rust'
  | 'go'
  | 'haskell'
  | 'lean4'
  /** 未対応言語 = プレーンテキストモード。ランキング投稿不可(§2) */
  | 'plain';

/**
 * ミス処理モード(§3)。
 * - 'ranking': 詰まる方式(正しい文字を打つまで進まない)
 * - 'practice': バックスペース可(ミスは記録に残る)— P1 では未実装
 */
export type PlayMode = 'ranking' | 'practice';

// ------------------------------------------------------ 文字モデル(charModel.ts)

/**
 * 自動スキップの理由(§3)。
 * - 'indent':  行頭インデント(スペース/タブ)
 * - 'comment': コメント(表示はするが打たない。P1 は正規表現簡易判定、P2 で Tree-sitter)
 * - 'tab':     文中タブ。Tab キーは無視(§3)のため、詰まる方式でのソフトロックを
 *              防ぐ目的で自動スキップにする(→ 提示時の指摘事項 #2)
 * - 'nonascii': 打鍵不能文字(確定事項 #9、P3)。印字可能 ASCII(U+0020–U+007E)と
 *              改行以外の文字(CJK・全角記号・制御文字等)。IME 経由の文字は
 *              keydown 判定に乗らず詰まる方式でソフトロックするため自動スキップ。
 *              基準はコスト表(§6 確定 #1 の US 配列)と同様に環境非依存で固定
 */
export type SkipReason = 'indent' | 'comment' | 'tab' | 'nonascii';

/** 打鍵対象テキストの 1 文字分のモデル */
export interface CharCell {
  /** 実際の文字。改行は '\n' に正規化済み */
  ch: string;
  /** 0-based 行番号 */
  line: number;
  /** 0-based 桁位置(正規化後テキスト上の位置。タブは 1 桁扱い・展開しない) */
  col: number;
  /** 自動スキップ対象ならその理由、打鍵対象なら null */
  skip: SkipReason | null;
  match: number;
  /**
   * type-over ペアでの役割(§3)。閉じ判定はこれで行う(クォートは開閉が同一文字の
   * ため、P1 の isCloser(ch) のような文字ベース判定ができない)。
   * null = ペア構成要素でない
   */
  pair: 'open' | 'close' | null;
}

/** charModel.ts の出力。プレイ 1 回分の静的データ */
export interface CharModel {
  cells: CharCell[];
  /** LF 正規化済みの原文(cells と 1:1 対応) */
  source: string;
  lineCount: number;
  /** skip を除いた打鍵対象文字数。投稿資格 300 文字(§6)の判定などに使う */
  typableCount: number;
  language: LanguageId;
  /**
   * 構築に使った解析結果(P2)。hud が tokens(薄字ハイライト §9)と
   * scopes(ブレッドクラム §9)を、loader が errorRatio(§4)をここから読む
   */
  analysis: SourceAnalysis;
}

// --------------------------------------------------------- 入力エンジン(input.ts)

/**
 * 1 打鍵の判定結果。input.ts が返し、main.ts が描画(hud)・音(sound)・
 * リプレイ記録に分配する。
 */
export type KeyResult =
  /** 通常の正解打鍵 */
  | { kind: 'hit'; index: number }
  /**
   * type-over 通過(§3): passed の cells を中抜き表示で通過し、
   * hitIndex を通常打鍵として消費した
   */
  | { kind: 'pass'; passed: number[]; hitIndex: number }
  /** ミス(詰まる)。missStreak が hintAfterMisses に達したら救済表示(§3) */
  | { kind: 'miss'; index: number; missStreak: number }
  /** Tab など判定対象外のキー */
  | { kind: 'ignored' };

/** HUD が毎打鍵/毎秒受け取るライブ統計 */
export interface LiveStats {
  /** hits/5 ÷ 経過分。type-over 通過は打鍵数に数えない(§3) */
  wpm: number;
  /** 正確率 0–100 */
  accuracy: number;
  combo: number;
  maxCombo: number;
  hits: number;
  misses: number;
  /** type-over で通過した閉じ括弧の累計数 */
  passedCount: number;
  elapsedMs: number;
}

/** リザルト画面(§10)に渡す確定結果 */
export interface SessionResult extends LiveStats {
  mode: PlayMode;
  language: LanguageId;
  /** ミスが発生した cells インデックス(重複あり)。ヒートマップ用(§10) */
  missIndices: number[];
  /** 完了時刻(epoch ms)。ローカル履歴用 */
  finishedAt: number;
}

// ------------------------------------------------------------- リプレイ(§11, P5)

/**
 * リプレイ 1 イベント。§11 の {文字, 時刻差分, 正誤, 通過フラグ} に対応。
 * ※ 通過「フラグ」は通過「数」に拡張(0 = 通過なし)。貪欲通過(§3)で
 *   1 打鍵が複数括弧を通過しうるため(→ 提示時の指摘事項 #5)
 */
export interface ReplayEvent {
  /** 打鍵した文字。Enter は '\n' */
  key: string;
  /** 直前イベントからの経過 ms(整数)。先頭イベントは開始からの経過 */
  dt: number;
  /** 正誤 */
  ok: boolean;
  /** このイベントで通過した閉じ括弧の数 */
  passed: number;
}

export interface Replay {
  formatVersion: 1;
  language: LanguageId;
  mode: PlayMode;
  /** 原文の識別ハッシュ。ゴースト照合・投稿検証用(P5/P7 で必須化) */
  sourceHash?: string;
  events: ReplayEvent[];
}

// ------------------------------------------------------------- ローカル履歴(§7, §11, P5)

/**
 * ローカル履歴 1 件(§11: localStorage 保存、サーバー送信なし)。
 * ホーム画面の一覧表示(§7)は P6。score はプレーンテキスト等では null(§2)
 */
export interface HistoryEntry {
  finishedAt: number;
  language: LanguageId;
  fileName: string | null;
  wpm: number;
  accuracy: number;
  score: number | null;
  /** 原文の SHA-256(hex)。ゴースト(§10)との対応付けに使う */
  sourceHash: string;
  typableCount: number;
}

// -------------------------------------------------------- スコア(§6, P3/P7 契約)

/** 難易度スコア。決定的・再現可能、式バージョン必須(§6) */
export interface DifficultyScore {
  value: number;
  /** 式のバージョン。変更時は旧スコアと混在させない(§6) */
  scoreVersion: number;
}

/**
 * ランキング投稿 1 件分のペイロード(§6, §11, P7)。POST /server/rank.php の body。
 * サーバーは wpm/accuracy/score をこの申告値のまま信用せず、replay.events から
 * 再計算した値だけを保存する(§13「リプレイからスコア再計算して一致確認」)。
 * wpm/accuracy/postedAt はサーバー側で確定するため送信不要。
 */
export interface RankingEntry {
  name: string;
  /** plain は投稿不可(§2) */
  language: Exclude<LanguageId, 'plain'>;
  difficulty: DifficultyScore;
  /** 長さ係数: 約2000文字まで逓減、以降 1.0(§6) */
  lengthFactor: number;
  /** 投稿資格(§6: 300 文字以上)の判定・サーバー側でのリプレイ整合チェックに使う */
  typableCount: number;
  /** スコア検証用リプレイ(§11)。sourceHash 必須 */
  replay: Replay;
}

/** ランキング一覧 1 件分(§7 ランキング画面)。サーバー再計算後の確定値 */
export interface RankingListEntry {
  name: string;
  wpm: number;
  accuracy: number;
  difficulty: number;
  score: number;
  postedAt: number;
}

/** GET /server/rank.php のレスポンス形。plain を除く全言語ぶん */
export type RankingMap = Partial<Record<Exclude<LanguageId, 'plain'>, RankingListEntry[]>>;

/** POST /server/rank.php 成功時のレスポンス */
export interface RankingSubmitResponse {
  ok: true;
  /** 上位 N 件内の順位(1-based)。圏外なら null(§11) */
  rank: number | null;
  /** 更新後のその言語のランキング全件(表示用) */
  entries: RankingListEntry[];
}

/** POST/GET /server/rank.php エラー時のレスポンス */
export interface RankingApiError {
  ok: false;
  /** 機械可読なエラーコード(例: 'ng-name' | 'not-eligible' | 'replay-mismatch' 等) */
  error: string;
  /** 表示用の日本語メッセージ */
  message: string;
}

// ------------------------------------------------------------- 読み込み(loader.ts)

/** loader.ts の上限チェック結果(§4) */
export type LoadCheck =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: 'too-large';
      lines: number;
      chars: number;
      /** 上限内に収まる先頭行数(「先頭N行だけ写経」提案用 §4) */
      suggestedLines: number;
      /** 先頭 suggestedLines 行を切り出したテキスト(そのまま開始できる) */
      truncatedText: string;
    };

// ----------------------------------------------------------------- サウンド(§8)

/**
 * 効果音の種類(§8)。
 * 'ghost' = type-over 通過時の極小音量ゴーストノート、'enter' = 改行アクセント
 */
export type SoundKind = 'hit' | 'miss' | 'ghost' | 'enter';

// ------------------------------------------------------------------- 設定(§7)

/** 演出強度(§7)。P1〜P5 は 'normal' 固定。P6 で設定画面から変更可能にする */
export type EffectLevel = 'off' | 'low' | 'normal';

/**
 * 設定画面(§7, §9, P6)。localStorage に保存(settings.ts)。
 * - effectLevel: 背景アニメ・グロー等の演出強度
 * - scopeBg: 現在のブロック範囲の背景を微着色(§9)
 * - refHighlight: 打鍵中の識別子と同名箇所を薄く発光(§9、名前一致ベース)
 */
export interface Settings {
  effectLevel: EffectLevel;
  scopeBg: boolean;
  refHighlight: boolean;
}

/** 設定の既定値。初回起動時・壊れた保存値のフォールバック */
export const DEFAULT_SETTINGS: Settings = {
  effectLevel: 'normal',
  scopeBg: true,
  refHighlight: true,
} as const;

// ------------------------------------------------------------------- 定数

/** 入力制限(§4)と投稿資格(§6) */
export const LIMITS = {
  maxLines: 5_000,
  maxChars: 200_000,
  /** ランキング投稿に必要な最小「打鍵対象」文字数(§6) */
  minTypableForRanking: 300,
} as const;

/** 入力エンジンの挙動定数(§3) */
export const ENGINE = {
  /** 同一箇所でこの回数連続ミスしたら正解文字を黄色強調(救済) */
  hintAfterMisses: 3,
} as const;

// ------------------------------------------ P2: 解析インターフェース(§2, §3, §4, §9, §12)

/**
 * 解析結果の区間はすべて cells インデックス単位の半開区間 [start, end)。
 *
 * 重要: Tree-sitter(web-tree-sitter)の node.startIndex/endIndex は UTF-16
 * コード単位だが、CharModel はコードポイント単位で 1 文字 = 1 セル(サロゲート
 * ペアも 1 セル)。単位変換は analyzer.ts 内部で吸収し、このインターフェースの
 * 外には cells インデックスしか出さない。charModel/hud は変換を意識しない。
 */
export interface CellSpan {
  start: number;
  /** 半開区間の終端(この位置は含まない) */
  end: number;
}

/** コメント範囲(§3 スキップ用)。行内・ブロックコメント対応(P1 簡易判定の置換) */
export interface CommentSpan extends CellSpan {
  kind: 'line' | 'block';
}

/**
 * 文字列ノード(§3 クォート type-over 用)。
 * 開閉が同一文字のため文字マッチでは判定できず、ノードの開始/終了で判定する(§3)。
 *
 *   [start, openEnd)   = 開きデリミタ(`"`, `'''`, `` ` `` 等。複数文字可)
 *   [closeStart, end)  = 閉じデリミタ
 *   [openEnd, closeStart) = 中身(この範囲の括弧はペア対象外 §3)
 *
 * 閉じられていない文字列(パースエラー時)は closeStart === end(閉じ側なし)。
 * Rust の lifetime `'a` 等はノード種別で除外され、ここには入らない(§3)。
 */
export interface StringSpan extends CellSpan {
  openEnd: number;
  closeStart: number;
}

/**
 * 薄字シンタックスハイライト(§9)と音色分け(§8: 識別子=柔/記号=パーカッシブ/
 * キーワード=太)で共有するトークン分類。Tree-sitter ノード種別から言語ごとに写像する
 */
export type TokenClass =
  | 'keyword'
  | 'identifier'
  | 'function'   // 関数・メソッド名
  | 'type'       // 型名・クラス名
  | 'string'
  | 'number'
  | 'comment'
  | 'operator'
  | 'punctuation'
  | 'plain';     // 上記に該当しない(既定色)

export interface TokenSpan extends CellSpan {
  cls: TokenClass;
}

/**
 * 構造ブレッドクラム(§9: `fib() › if › 条件式`)用のスコープ木。
 * hud は カーソル位置を含むノードを根から辿って label を連結する。
 * 全ファイル分を解析時に 1 回だけ構築する静的データ(プレイ中に再パースしない)
 */
export interface ScopeNode extends CellSpan {
  /** 表示ラベル(例: 'fib()', 'if', 'class Foo') */
  label: string;
  /** 元の Tree-sitter ノード種別(スコープ背景 §9 の ON/OFF 判定等に使う) */
  kind: string;
  children: ScopeNode[];
}

/** 解析器の種別(§2)。'simple' = 正規表現ベース簡易版(plain / Lean4 フォールバック) */
export type AnalyzerEngine = 'tree-sitter' | 'simple';

/**
 * analyzer.ts の出力。パース結果を JS 側へ渡す唯一の契約(§12)。
 * 入力は LF 正規化済みテキスト(CharModel.source と同一)であること。
 * charModel はこれを受けて skip / match / pair を確定し、hud は tokens / scopes を使う
 */
export interface SourceAnalysis {
  language: LanguageId;
  engine: AnalyzerEngine;
  /**
   * ERROR ノード率(§4 警告方式)。
   * 定義: ERROR / MISSING ノードに覆われる文字数 ÷ 正規化後の総文字数(0–1)。
   * ノード個数比でなく文字数比(巨大な壊れ区間を正しく重くするため)。
   * engine が 'simple' のときは常に 0(算出不可 → 警告も拒否もしない)
   */
  errorRatio: number;
  comments: CommentSpan[];
  strings: StringSpan[];
  /** 重複しない昇順ソート済み。comment 範囲も cls:'comment' で含む(描画はこれだけ見ればよい) */
  tokens: TokenSpan[];
  scopes: ScopeNode[];
}

/** 言語判定の結果(§2: 拡張子 + 内容ヒューリスティック)。判定根拠を UI 表示に使える */
export interface LanguageDetection {
  language: LanguageId;
  via: 'extension' | 'heuristic' | 'fallback';
}

/** 構文チェックの閾値(§4)。reject は仕様確定値、warn は要チューニング(§13 扱い) */
export const SYNTAX_CHECK = {
  /** これを超えたら警告表示(仮値。実測で調整) */
  warnErrorRatio: 0.02,
  /** これを超えたら拒否(コードでない長文の排除を兼ねる §4) */
  rejectErrorRatio: 0.5,
} as const;

// ------------------------------------------ P3: 難易度エンジン(§5, §6, §12)

/**
 * TokenClass → u8 コード。difficulty.ts が CharModel から wasm へ渡す
 * 平行配列(cls)を組み立てるときに使う。
 * Rust 側 difficulty-engine/src/lib.rs の token_class モジュールと一致させること
 * (変更時は両側を同時に更新し、SCORE_VERSION を上げる)
 */
export const TOKEN_CLASS_CODE = {
  keyword: 0,
  identifier: 1,
  function: 2,
  type: 3,
  string: 4,
  number: 5,
  comment: 6,
  operator: 7,
  punctuation: 8,
  plain: 9,
} as const satisfies Record<TokenClass, number>;

/**
 * 難易度の内訳。value / scoreVersion は DifficultyScore と同じ意味
 * (RankingEntry.difficulty にはこのまま代入可能)。
 * 残り 4 因子は §13 の係数チューニングとリザルトのデバッグ表示用に wasm が返す。
 * 全フィールド 1e-4 丸め(エンジン側 round4。保存・照合の安定化)
 */
export interface DifficultyBreakdown extends DifficultyScore {
  /** 平均打鍵コスト(基本1.0/数字段1.3/Shift1.6/遠い記号1.8/同指連続×1.2 §6) */
  avgKeystrokeCost: number;
  /** 記号密度 0–1(打鍵対象セルのうち ASCII 記号の比率。文字ベース §13) */
  symbolDensity: number;
  /** 正規化ネスト深度 0–1(min(depth,8)/8 の打鍵対象セル平均) */
  nestDepthNorm: number;
  /** 識別子反復率 0–1(生値。式には min(生値, 0.5) が使われる §13) */
  identRepetition: number;
}

// ------------------------------------------ P6: リザルト可視化(§7, §10, heatmap.ts/rhythm.ts)

/**
 * ミス箇所ヒートマップ 1 ノード(§7「回路基板風」)。
 * cells インデックス範囲をバケットに集約した格子点。circuit board のノード 1 個に対応
 */
export interface HeatmapNode {
  /** 格子上の位置(0-based) */
  col: number;
  row: number;
  /** このバケットのミス数 */
  count: number;
  /** count を maxCount で正規化した 0–1(全ノード count=0 なら 0) */
  intensity: number;
  /** バケットが対応する cells 範囲(半開区間)。デバッグ・将来のドリルダウン用 */
  start: number;
  end: number;
}

/** heatmap.ts の出力。hud.showResult がこのまま描画する */
export interface HeatmapData {
  nodes: HeatmapNode[];
  cols: number;
  rows: number;
  maxCount: number;
  totalMisses: number;
}

/** リズムグラフ 1 点(§7, §10)。x/y とも 0–1 正規化済み(SVG 座標への写像は描画側) */
export interface RhythmPoint {
  /** 経過時間の割合(0=開始, 1=完走時) */
  t: number;
  /** 打鍵速度の正規化値(速いほど 1 に近い)。dt が小さいほど高い */
  v: number;
}

/** rhythm.ts の出力 */
export interface RhythmSeries {
  /** 正解打鍵(hit/pass)の系列。折れ線グラフの点 */
  points: RhythmPoint[];
  /** ミス発生位置(t のみ。グラフ上に赤点として重ねる) */
  misses: number[];
}