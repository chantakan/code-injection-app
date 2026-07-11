/**
 * analyzer.ts — Tree-sitter 統合(P2)
 *
 * 責務(§2, §12):
 * - 言語判定: 拡張子 + 内容ヒューリスティック
 * - 文法 wasm の遅延ロード(判定後、該当 wasm のみ fetch)
 * - パース → SourceAnalysis(types.ts の契約)への変換
 * - 簡易フォールバック: plain / wasm 未配備言語 / ロード・パース失敗時
 *   (Lean4 の品質不足時フォールバック §2 もこの経路に落とす)
 *
 * 設計:
 * - DOM・バンドラ非依存。ランタイム wasm のパスと文法 wasm の取得手段は
 *   initAnalyzer() で注入する(input.ts の時刻注入と同じ思想。Node でテスト可能)
 *   main.ts 側: import url from 'web-tree-sitter/tree-sitter.wasm?url' を渡す
 * - 入力は LF 正規化済みテキスト(CharModel.source と同一)であること
 * - オフセット変換(UTF-16 → コードポイント=cells インデックス)はこの中で吸収する
 */

import type { Node, TreeCursor } from 'web-tree-sitter';
import { Language, Parser } from 'web-tree-sitter';
import type {
  CommentSpan,
  LanguageDetection,
  LanguageId,
  ScopeNode,
  SourceAnalysis,
  StringSpan,
  TokenClass,
  TokenSpan,
} from './types';

// ---------------------------------------------------------------- 設定・初期化

export interface AnalyzerConfig {
  /** web-tree-sitter ランタイム(tree-sitter.wasm)の URL。未指定なら既定解決(Node 実行時) */
  runtimeWasmPath?: string;
  /** 文法 wasm の配置ベース。既定 '/grammars/'(public/grammars/ を Vite が配信) */
  grammarBase?: string;
  /** wasm バイト列の取得。既定は fetch(テストでは fs 読み込みを注入) */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

let config: Required<AnalyzerConfig> = {
  runtimeWasmPath: '',
  grammarBase: '/grammars/',
  fetchBytes: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`analyzer: ${url} の取得に失敗(${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** 起動時に 1 回呼ぶ(main.ts)。呼ばなくても既定値で動く(Node では既定解決) */
export function initAnalyzer(c: AnalyzerConfig): void {
  config = { ...config, ...c };
}

let parserInit: Promise<void> | null = null;
/** 文法 Language のキャッシュ(遅延ロード §2。言語切替で再 fetch しない) */
const languageCache = new Map<string, Promise<Language>>();

function ensureParserInit(): Promise<void> {
  // 0.26 のランタイムは 'web-tree-sitter.wasm' を要求する(旧版は 'tree-sitter.wasm')。
  // 名前に依存せず .wasm 要求は全て注入パスへ差し替える
  parserInit ??= Parser.init(
    config.runtimeWasmPath !== ''
      ? { locateFile: (name: string) => (name.endsWith('.wasm') ? config.runtimeWasmPath : name) }
      : undefined,
  );
  return parserInit;
}

// ---------------------------------------------------------------- 言語判定(§2)

/** 拡張子 → 言語。§2 の 8 言語 + よくある別拡張子 */
const EXT_MAP: Record<string, LanguageId> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  c: 'c', h: 'c',
  rs: 'rust',
  go: 'go',
  hs: 'haskell',
  lean: 'lean4',
};

/**
 * 内容ヒューリスティック(拡張子が無い/未知のペースト入力用)。
 * [pattern, weight] の合計スコアが最大かつ 3 以上の言語を採用。
 * 係数は暫定(§13 扱い。誤判定サンプルが出たら都度調整)
 */
const HEURISTICS: Array<{ language: LanguageId; patterns: Array<[RegExp, number]> }> = [
  { language: 'python', patterns: [
    [/^\s*def\s+\w+\s*\(.*\)\s*(->.*)?:/m, 3], [/^\s*class\s+\w+(\(.*\))?\s*:/m, 2],
    [/^(from\s+[\w.]+\s+)?import\s+\w/m, 2], [/\bself\b/, 1], [/^\s*#(?!include)/m, 1], [/^\s*(elif|def|except)\b/m, 2],
  ]},
  { language: 'typescript', patterns: [
    [/\binterface\s+\w+\s*(extends\s+\w+\s*)?\{/, 3], [/\bexport\s+type\b/, 3],
    [/:\s*(string|number|boolean|void|unknown|never)\b/, 2], [/\breadonly\s+\w/, 2],
    [/\b(implements|enum)\s+\w/, 2], [/\bas\s+const\b/, 2],
  ]},
  { language: 'javascript', patterns: [
    [/\b(const|let)\s+[\w$]+\s*=/, 2], [/=>\s*[{(]?/, 1], [/\bfunction\s*[\w$]*\s*\(/, 2],
    [/\bconsole\.\w+\(/, 2], [/\b(require\(|module\.exports)/, 2], [/^import\s.+\sfrom\s+['"]/m, 2],
  ]},
  { language: 'rust', patterns: [
    [/\bfn\s+\w+/, 2], [/\blet\s+mut\b/, 3], [/#\[\w+/, 2], [/\b(impl|trait)\s+\w/, 2],
    [/\bpub\s+(fn|struct|enum|mod)\b/, 3], [/&(str|mut)\b/, 2],
  ]},
  { language: 'go', patterns: [
    [/^package\s+\w+/m, 3], [/\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/, 2], [/:=/, 2],
    [/\bfmt\.\w+\(/, 2], [/\bgo\s+func\b/, 2], [/\bdefer\b/, 2],
  ]},
  { language: 'c', patterns: [
    [/#include\s*[<"]/, 3], [/\bint\s+main\s*\(/, 2], [/\b(void|char|int|float|double)\s+\*?\w+\s*\(/, 2],
    [/\bprintf\s*\(/, 2], [/\b(struct|typedef)\s+\w/, 2], [/#define\s+\w/, 2],
  ]},
  { language: 'haskell', patterns: [
    [/^\s*module\s+[A-Z]\w*/m, 3], [/::\s*.*->/, 2], [/^\s*import\s+qualified/m, 3],
    [/\bwhere\s*$/m, 2], [/\bdata\s+[A-Z]\w*\s*=/, 2], [/^\s*--\s/m, 1],
  ]},
  { language: 'lean4', patterns: [
    [/\b(theorem|lemma)\s+\w+/, 3], [/:=\s*by\b/, 3], [/^import\s+(Mathlib|Lean|Std)/m, 3],
    [/^\s*--\s/m, 1], [/[∀∃→↔ℕℝ]/u, 2], [/\bdef\s+\w+.*:=/, 2],
  ]},
];

/**
 * 言語判定(§2: 拡張子 + 内容ヒューリスティック)。
 * shebang → 拡張子 → 内容スコア → 'plain' の順で決める
 */
export function detectLanguage(fileName: string | null, text: string): LanguageDetection {
  const ext = fileName?.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  const byExt = ext !== undefined ? EXT_MAP[ext] : undefined;
  if (byExt !== undefined) return { language: byExt, via: 'extension' };

  const head = text.slice(0, 200);
  if (/^#!.*\bpython/.test(head)) return { language: 'python', via: 'heuristic' };
  if (/^#!.*\b(node|deno|bun)\b/.test(head)) return { language: 'javascript', via: 'heuristic' };

  const sample = text.slice(0, 20_000); // 冒頭だけで十分(全文走査しない)
  let best: { language: LanguageId; score: number } | null = null;
  for (const h of HEURISTICS) {
    const score = h.patterns.reduce((n, [re, w]) => n + (re.test(sample) ? w : 0), 0);
    if (score >= 3 && (best === null || score > best.score)) best = { language: h.language, score };
  }
  return best !== null
    ? { language: best.language, via: 'heuristic' }
    : { language: 'plain', via: 'fallback' };
}

// ---------------------------------------------------------------- 言語別ルール表

interface LangRules {
  /** 文法 wasm ファイル名(未配備言語は undefined → 簡易フォールバック) */
  wasm?: string;
  /** コメントのノード種別 */
  comment: Set<string>;
  /** 文字列ノード種別(§3 クォート type-over の対象) */
  string: Set<string>;
  /** 'string' 色で塗るが StringSpan にはしない種別(正規表現リテラル等。§3 対象は " ' ` のみ) */
  opaque: Set<string>;
  /** ブレッドクラム(§9): 名前付きスコープ(関数/クラス)。値は 'func' | 'type' */
  named: Record<string, 'func' | 'type'>;
  /** ブレッドクラム(§9): キーワードスコープ。値は表示ラベル */
  block: Record<string, string>;
  /** 簡易フォールバック用の行コメント開始子 */
  lineComment: string[];
  /**
   * docstring をコメント扱いでスキップする(確定事項 #8、Python)。
   * 「モジュール/クラス/関数本体の先頭ステートメントが文字列だけの式文」が対象。
   * 理由: Lean4 の doc_comment(スキップ)と扱いを揃える+日本語 docstring は
   * IME が keydown 判定に乗らず詰まる方式でソフトロックするため
   */
  docstring?: true;
}

const JS_LIKE: Omit<LangRules, 'wasm'> = {
  comment: new Set(['comment', 'html_comment']),
  string: new Set(['string', 'template_string']),
  opaque: new Set(['regex']),
  named: {
    function_declaration: 'func', generator_function_declaration: 'func',
    function_expression: 'func', arrow_function: 'func', method_definition: 'func',
    class_declaration: 'type', class: 'type',
    // TS 専用(JS 文法には出てこないだけなので同居で無害)
    interface_declaration: 'type', enum_declaration: 'type', type_alias_declaration: 'type',
  },
  block: {
    if_statement: 'if', else_clause: 'else', for_statement: 'for', for_in_statement: 'for',
    while_statement: 'while', do_statement: 'do', try_statement: 'try', catch_clause: 'catch',
    finally_clause: 'finally', switch_statement: 'switch',
  },
  lineComment: ['//'],
};

const RULES: Partial<Record<LanguageId, LangRules>> = {
  javascript: { ...JS_LIKE, wasm: 'javascript.wasm' },
  typescript: { ...JS_LIKE, wasm: 'typescript.wasm' },
  python: {
    wasm: 'python.wasm',
    comment: new Set(['comment']),
    string: new Set(['string']),
    opaque: new Set(),
    named: { function_definition: 'func', class_definition: 'type' },
    block: {
      if_statement: 'if', elif_clause: 'elif', else_clause: 'else', for_statement: 'for',
      while_statement: 'while', try_statement: 'try', except_clause: 'except',
      finally_clause: 'finally', with_statement: 'with', match_statement: 'match',
    },
    lineComment: ['#'],
    docstring: true,
  },
  lean4: {
  // 品質確認済み(2026-07-09 実測: AOCS 5.5% / EPS 9.8% / TCS 32.2%)。
  // 平均は基準10%超だが二極化しており、フォールバック(/- -/ を打たされる)の
  // 実害の方が大きいため採用と判断。ERROR 多めのファイルは §4 警告が出る(仕様)
    wasm: 'lean4.wasm',
    comment: new Set(['line_comment', 'block_comment', 'doc_comment']),
    string: new Set(['str_lit']),
    opaque: new Set(),
    // スコープ(ブレッドクラム §9)のノード種別は未調査 → 当面 LINE n/m のみ。
    // 実ファイルの parse 結果を見て後日追加(空でも他機能に影響なし)
    named: {},
    block: {},
    lineComment: ['--'],
  },
  // c / rust / go / haskell: wasm ビルド後に追加(それまでは簡易フォールバック)
};

/** RULES に無い言語の簡易フォールバック用行コメント。plain は P1 互換(// と #) */
const FALLBACK_LINE_COMMENTS: Partial<Record<LanguageId, string[]>> = {
  c: ['//'], rust: ['//'], go: ['//'], haskell: ['--'], lean4: ['--'], plain: ['//', '#'],
};

// ---------------------------------------------------------------- 解析本体

/**
 * 解析エントリポイント。
 * @param source   LF 正規化済みテキスト(CharModel.source と同一であること)
 * @param language detectLanguage() の結果
 * @param fileName TypeScript の変種選択(.tsx → tsx 文法)にだけ使う
 *
 * 失敗時は例外を投げず簡易フォールバックに落とす(写経自体は常に始められる §2)
 */
export async function analyze(
  source: string,
  language: LanguageId,
  fileName?: string,
): Promise<SourceAnalysis> {
  const rules = RULES[language];
  if (rules?.wasm === undefined) return simpleAnalyze(source, language);

  // TypeScript は .tsx のみ tsx 文法(型キャスト <T> と JSX の曖昧性のため文法が別)
  const wasmFile =
    language === 'typescript' && fileName !== undefined && /\.tsx$/i.test(fileName)
      ? 'tsx.wasm'
      : rules.wasm;

  try {
    await ensureParserInit();
    const lang = await loadLanguage(wasmFile);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (tree === null) throw new Error('parse がキャンセルされた');
    try {
      return extract(tree.rootNode, source, language, rules);
    } finally {
      tree.delete(); // wasm 側メモリの解放(SourceAnalysis は純データなので保持不要)
    }
  } catch (e) {
    console.warn(`[CODE://INJECT] ${language} の Tree-sitter 解析に失敗。簡易解析で続行:`, e);
    return simpleAnalyze(source, language);
  }
}

function loadLanguage(wasmFile: string): Promise<Language> {
  let cached = languageCache.get(wasmFile);
  if (cached === undefined) {
    cached = config
      .fetchBytes(config.grammarBase + wasmFile)
      .then((bytes) => Language.load(bytes));
    // ロード失敗をキャッシュしない(次回リトライできるように)
    cached.catch(() => languageCache.delete(wasmFile));
    languageCache.set(wasmFile, cached);
  }
  return cached;
}

// ---------------------------------------------------------------- ツリー → SourceAnalysis

/**
 * UTF-16 オフセット → cells インデックス(コードポイント単位)の変換器。
 * サロゲートペアが無ければ恒等写像(通常のコードはこちら。コスト 0)
 */
function makeToCell(source: string): (utf16: number) => number {
  if (!/[\uD800-\uDBFF]/.test(source)) return (i) => i;
  const map = new Int32Array(source.length + 1);
  let cp = 0;
  for (let i = 0; i < source.length; cp++) {
    map[i] = cp;
    const wide = (source.codePointAt(i) ?? 0) > 0xffff;
    if (wide) map[i + 1] = cp; // ペア後半に落ちた場合も安全側に丸める
    i += wide ? 2 : 1;
  }
  map[source.length] = cp;
  return (i) => map[Math.max(0, Math.min(i, source.length))] ?? cp;
}

/** ツリーを 1 パス走査して SourceAnalysis を組み立てる(再帰しない=深い入れ子で溢れない) */
function extract(
  root: Node,
  source: string,
  language: LanguageId,
  rules: LangRules,
): SourceAnalysis {
  const toCell = makeToCell(source);
  const comments: CommentSpan[] = [];
  const strings: StringSpan[] = [];
  const tokens: TokenSpan[] = [];
  const scopes: ScopeNode[] = [];
  const scopeStack: ScopeNode[] = [];
  let errorChars = 0;
  let errorDepth = 0;

  /** @returns 子へ降りるか */
  const enter = (node: Node): boolean => {
    const type = node.type;

    if (type === 'ERROR') {
      if (errorDepth === 0) errorChars += node.endIndex - node.startIndex;
      errorDepth++;
      return true; // ERROR 内も走査(壊れていない部分のトークン色は出す)
    }

    if (rules.comment.has(type)) {
      const span = { start: toCell(node.startIndex), end: toCell(node.endIndex) };
      // block 判定: ノード種別名(lean4 の block_comment/doc_comment)または開始子
      const kind: CommentSpan['kind'] =
        type.includes('block') || type === 'doc_comment' ||
        source.startsWith('/*', node.startIndex) || source.startsWith('/-', node.startIndex)
          ? 'block'
          : 'line';
      comments.push({ ...span, kind });
      tokens.push({ ...span, cls: 'comment' });
      return false;
    }

    if (rules.string.has(type)) {
      // docstring はコメント扱い(確定事項 #8)。StringSpan に入れない
      // (クォート type-over 対象外)ので、行ごと自動スキップになる
      if (isDocstring(node, rules)) {
        const span = { start: toCell(node.startIndex), end: toCell(node.endIndex) };
        comments.push({ ...span, kind: 'block' });
        tokens.push({ ...span, cls: 'comment' });
        return false;
      }
      strings.push(stringSpanOf(node, toCell));
      tokens.push({ start: toCell(node.startIndex), end: toCell(node.endIndex), cls: 'string' });
      return false; // 文字列内部は §3 によりペア対象外。トークンも一色でよい
    }

    if (rules.opaque.has(type)) {
      tokens.push({ start: toCell(node.startIndex), end: toCell(node.endIndex), cls: 'string' });
      return false;
    }

    const named = rules.named[type];
    const block = rules.block[type];
    if (named !== undefined || block !== undefined) {
      const scope: ScopeNode = {
        start: toCell(node.startIndex),
        end: toCell(node.endIndex),
        label: named !== undefined ? namedLabel(node, named, source) : (block ?? type),
        kind: type,
        children: [],
      };
      (scopeStack[scopeStack.length - 1]?.children ?? scopes).push(scope);
      scopeStack.push(scope);
      return true;
    }

    if (node.childCount === 0) {
      if (node.endIndex > node.startIndex) {
        tokens.push({
          start: toCell(node.startIndex),
          end: toCell(node.endIndex),
          cls: classifyLeaf(node, source),
        });
      }
      return false;
    }
    return true;
  };

  const exit = (node: Node): void => {
    if (node.type === 'ERROR') errorDepth--;
    else if (rules.named[node.type] !== undefined || rules.block[node.type] !== undefined) {
      scopeStack.pop();
    }
  };

  walk(root.walk(), enter, exit);

  const total = [...source].length;
  return {
    language,
    engine: 'tree-sitter',
    // 定義は types.ts 参照: ERROR に覆われる文字数 ÷ 総文字数(UTF-16 差でも比としては十分)
    errorRatio: total > 0 ? Math.min(1, errorChars / source.length) : 0,
    comments,
    strings,
    tokens,
    scopes,
  };
}

/**
 * docstring 判定(確定事項 #8、rules.docstring の言語のみ)。
 * 対象: モジュール直下 / class・関数本体(block)の「先頭ステートメント」で、
 * かつ「文字列 1 つだけの式文」。先頭判定ではコメントを読み飛ばす
 * (Python 意味論: docstring は先頭の文でなければならない。コメントは文でない)
 */
function isDocstring(node: Node, rules: LangRules): boolean {
  if (rules.docstring !== true) return false;
  const stmt = node.parent;
  if (stmt === null || stmt.type !== 'expression_statement' || stmt.namedChildCount !== 1) {
    return false;
  }
  const body = stmt.parent;
  if (body === null) return false;
  const isBodyOfScope =
    body.type === 'module' ||
    (body.type === 'block' &&
      (body.parent?.type === 'function_definition' || body.parent?.type === 'class_definition'));
  if (!isBodyOfScope) return false;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child === null || rules.comment.has(child.type)) continue; // コメントは飛ばす
    // 先頭ステートメントが stmt 自身か(位置で同定。Node の同一性 API に依存しない)
    return child.startIndex === stmt.startIndex && child.endIndex === stmt.endIndex;
  }
  return false;
}

/** カーソルによる非再帰 DFS。enter が false を返した部分木には降りない */
function walk(cursor: TreeCursor, enter: (n: Node) => boolean, exit: (n: Node) => void): void {
  outer: while (true) {
    if (enter(cursor.currentNode) && cursor.gotoFirstChild()) continue;
    while (true) {
      exit(cursor.currentNode);
      if (cursor.gotoNextSibling()) continue outer;
      if (!cursor.gotoParent()) return;
    }
  }
}

/**
 * 文字列ノード → StringSpan(§3)。
 * 開き/閉じデリミタは「ノード端に接する無名トークン(または string_start/string_end)」。
 * 閉じが見つからない(未終端)場合は closeStart = end(閉じ側なし)
 */
function stringSpanOf(node: Node, toCell: (i: number) => number): StringSpan {
  const first = node.firstChild;
  const last = node.lastChild;
  const isDelim = (n: Node | null): n is Node =>
    n !== null && (!n.isNamed || n.type === 'string_start' || n.type === 'string_end');

  const openEnd =
    isDelim(first) && first.startIndex === node.startIndex ? first.endIndex : node.startIndex;
  const closeStart =
    isDelim(last) && last.endIndex === node.endIndex && last.startIndex >= openEnd
      ? last.startIndex
      : node.endIndex;

  return {
    start: toCell(node.startIndex),
    end: toCell(node.endIndex),
    openEnd: toCell(openEnd),
    closeStart: toCell(closeStart),
  };
}

/** 名前付きスコープのラベル: `fib()` / `class Foo` 形式(§9) */
function namedLabel(node: Node, kind: 'func' | 'type', source: string): string {
  const name =
    fieldText(node, 'name', source) ??
    // 無名関数(arrow 等): 代入先の変数名を借りる(const f = () => ...)
    (node.parent !== null ? fieldText(node.parent, 'name', source) : null);
  if (kind === 'func') return `${name ?? 'fn'}()`;
  return name !== null ? `${node.type.split('_')[0]} ${name}` : node.type;
}

function fieldText(node: Node, field: string, source: string): string | null {
  const n = node.childForFieldName(field);
  return n !== null ? source.slice(n.startIndex, n.endIndex) : null;
}

/** 末端トークンの分類(§8 音色 / §9 薄字ハイライト)。粗くてよい(薄字なので実害小) */
function classifyLeaf(node: Node, source: string): TokenClass {
  const type = node.type;

  if (!node.isNamed) {
    // 無名トークン: 英字なら予約語、記号は括弧系/演算子系に二分
    if (/^[A-Za-z_][\w$]*$/.test(type)) return 'keyword';
    if (/^[()[\]{};,.:]+$/.test(type)) return 'punctuation';
    return 'operator';
  }

  if (type === 'type_identifier') return 'type';
  if (type === 'identifier' || type.endsWith('_identifier')) {
    const p = node.parent;
    if (p !== null) {
      const isField = (f: string): boolean => p.childForFieldName(f)?.id === node.id;
      if ((p.type === 'call_expression' || p.type === 'call') && isField('function')) return 'function';
      if (isField('name') && /function|method|definition|declaration/.test(p.type)) {
        return /class|interface|enum|type/.test(p.type) ? 'type' : 'function';
      }
    }
    return 'identifier';
  }
  if (type === 'number' || type === 'integer' || type === 'float') return 'number';
  if (type === 'escape_sequence' || type.startsWith('string_')) return 'string';
  // 型と本文が同一(true / null / this / self 等)= 固定キーワード
  if (source.slice(node.startIndex, node.endIndex) === type) return 'keyword';
  return 'plain';
}

// ---------------------------------------------------------------- 簡易フォールバック(§2)

/**
 * 正規表現ベースの簡易解析。P1 の isCommentLine と同じ「行頭(インデント除く)のみ」判定
 * (行内コメントは文字列との誤認リスクがあるため、簡易版では踏み込まない)。
 * errorRatio は算出不可のため 0(警告も拒否もしない §4)、クォート type-over 無効、
 * トークン色はコメントのみ、ブレッドクラムは無し(hud は LINE n/m 表示に戻る)。
 *
 * export しているのは charModel の既定値用(analysis 未指定 = P1 互換動作)。
 * 同期・純関数なので charModel から直接呼べる
 */
export function simpleAnalyze(source: string, language: LanguageId): SourceAnalysis {
  const markers = RULES[language]?.lineComment ?? FALLBACK_LINE_COMMENTS[language] ?? ['//', '#'];
  const comments: CommentSpan[] = [];
  const tokens: TokenSpan[] = [];

  let lineStart = 0; // cells インデックス(コードポイント単位)で数える
  for (const line of source.split('\n')) {
    const chars = [...line];
    const trimmed = line.trimStart();
    if (markers.some((m) => trimmed.startsWith(m))) {
      const indent = chars.length - [...trimmed].length;
      const span = { start: lineStart + indent, end: lineStart + chars.length };
      comments.push({ ...span, kind: 'line' });
      tokens.push({ ...span, cls: 'comment' });
    }
    lineStart += chars.length + 1; // '\n' の分
  }

  return { language, engine: 'simple', errorRatio: 0, comments, strings: [], tokens, scopes: [] };
}