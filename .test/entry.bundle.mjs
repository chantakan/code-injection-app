// src/analyzer.ts
import { Language, Parser } from "web-tree-sitter";
var config = {
  runtimeWasmPath: "",
  grammarBase: "/grammars/",
  fetchBytes: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`analyzer: ${url} \u306E\u53D6\u5F97\u306B\u5931\u6557(${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
};
function initAnalyzer(c) {
  config = { ...config, ...c };
}
var parserInit = null;
var languageCache = /* @__PURE__ */ new Map();
function ensureParserInit() {
  parserInit ??= Parser.init(
    config.runtimeWasmPath !== "" ? { locateFile: (name) => name.endsWith(".wasm") ? config.runtimeWasmPath : name } : void 0
  );
  return parserInit;
}
var EXT_MAP = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  py: "python",
  pyw: "python",
  c: "c",
  h: "c",
  rs: "rust",
  go: "go",
  hs: "haskell",
  lean: "lean4"
};
var HEURISTICS = [
  { language: "python", patterns: [
    [/^\s*def\s+\w+\s*\(.*\)\s*(->.*)?:/m, 3],
    [/^\s*class\s+\w+(\(.*\))?\s*:/m, 2],
    [/^(from\s+[\w.]+\s+)?import\s+\w/m, 2],
    [/\bself\b/, 1],
    [/^\s*#(?!include)/m, 1],
    [/^\s*(elif|def|except)\b/m, 2]
  ] },
  { language: "typescript", patterns: [
    [/\binterface\s+\w+\s*(extends\s+\w+\s*)?\{/, 3],
    [/\bexport\s+type\b/, 3],
    [/:\s*(string|number|boolean|void|unknown|never)\b/, 2],
    [/\breadonly\s+\w/, 2],
    [/\b(implements|enum)\s+\w/, 2],
    [/\bas\s+const\b/, 2]
  ] },
  { language: "javascript", patterns: [
    [/\b(const|let)\s+[\w$]+\s*=/, 2],
    [/=>\s*[{(]?/, 1],
    [/\bfunction\s*[\w$]*\s*\(/, 2],
    [/\bconsole\.\w+\(/, 2],
    [/\b(require\(|module\.exports)/, 2],
    [/^import\s.+\sfrom\s+['"]/m, 2]
  ] },
  { language: "rust", patterns: [
    [/\bfn\s+\w+/, 2],
    [/\blet\s+mut\b/, 3],
    [/#\[\w+/, 2],
    [/\b(impl|trait)\s+\w/, 2],
    [/\bpub\s+(fn|struct|enum|mod)\b/, 3],
    [/&(str|mut)\b/, 2]
  ] },
  { language: "go", patterns: [
    [/^package\s+\w+/m, 3],
    [/\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/, 2],
    [/:=/, 2],
    [/\bfmt\.\w+\(/, 2],
    [/\bgo\s+func\b/, 2],
    [/\bdefer\b/, 2]
  ] },
  { language: "c", patterns: [
    [/#include\s*[<"]/, 3],
    [/\bint\s+main\s*\(/, 2],
    [/\b(void|char|int|float|double)\s+\*?\w+\s*\(/, 2],
    [/\bprintf\s*\(/, 2],
    [/\b(struct|typedef)\s+\w/, 2],
    [/#define\s+\w/, 2]
  ] },
  { language: "haskell", patterns: [
    [/^\s*module\s+[A-Z]\w*/m, 3],
    [/::\s*.*->/, 2],
    [/^\s*import\s+qualified/m, 3],
    [/\bwhere\s*$/m, 2],
    [/\bdata\s+[A-Z]\w*\s*=/, 2],
    [/^\s*--\s/m, 1]
  ] },
  { language: "lean4", patterns: [
    [/\b(theorem|lemma)\s+\w+/, 3],
    [/:=\s*by\b/, 3],
    [/^import\s+(Mathlib|Lean|Std)/m, 3],
    [/^\s*--\s/m, 1],
    [/[∀∃→↔ℕℝ]/u, 2],
    [/\bdef\s+\w+.*:=/, 2]
  ] }
];
function detectLanguage(fileName, text) {
  const ext = fileName?.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  const byExt = ext !== void 0 ? EXT_MAP[ext] : void 0;
  if (byExt !== void 0) return { language: byExt, via: "extension" };
  const head = text.slice(0, 200);
  if (/^#!.*\bpython/.test(head)) return { language: "python", via: "heuristic" };
  if (/^#!.*\b(node|deno|bun)\b/.test(head)) return { language: "javascript", via: "heuristic" };
  const sample = text.slice(0, 2e4);
  let best = null;
  for (const h of HEURISTICS) {
    const score = h.patterns.reduce((n, [re, w]) => n + (re.test(sample) ? w : 0), 0);
    if (score >= 3 && (best === null || score > best.score)) best = { language: h.language, score };
  }
  return best !== null ? { language: best.language, via: "heuristic" } : { language: "plain", via: "fallback" };
}
var JS_LIKE = {
  comment: /* @__PURE__ */ new Set(["comment", "html_comment"]),
  string: /* @__PURE__ */ new Set(["string", "template_string"]),
  opaque: /* @__PURE__ */ new Set(["regex"]),
  named: {
    function_declaration: "func",
    generator_function_declaration: "func",
    function_expression: "func",
    arrow_function: "func",
    method_definition: "func",
    class_declaration: "type",
    class: "type",
    // TS 専用(JS 文法には出てこないだけなので同居で無害)
    interface_declaration: "type",
    enum_declaration: "type",
    type_alias_declaration: "type"
  },
  block: {
    if_statement: "if",
    else_clause: "else",
    for_statement: "for",
    for_in_statement: "for",
    while_statement: "while",
    do_statement: "do",
    try_statement: "try",
    catch_clause: "catch",
    finally_clause: "finally",
    switch_statement: "switch"
  },
  lineComment: ["//"]
};
var RULES = {
  javascript: { ...JS_LIKE, wasm: "javascript.wasm" },
  typescript: { ...JS_LIKE, wasm: "typescript.wasm" },
  python: {
    wasm: "python.wasm",
    comment: /* @__PURE__ */ new Set(["comment"]),
    string: /* @__PURE__ */ new Set(["string"]),
    opaque: /* @__PURE__ */ new Set(),
    named: { function_definition: "func", class_definition: "type" },
    block: {
      if_statement: "if",
      elif_clause: "elif",
      else_clause: "else",
      for_statement: "for",
      while_statement: "while",
      try_statement: "try",
      except_clause: "except",
      finally_clause: "finally",
      with_statement: "with",
      match_statement: "match"
    },
    lineComment: ["#"],
    docstring: true
  },
  lean4: {
    // 品質確認済み(2026-07-09 実測: AOCS 5.5% / EPS 9.8% / TCS 32.2%)。
    // 平均は基準10%超だが二極化しており、フォールバック(/- -/ を打たされる)の
    // 実害の方が大きいため採用と判断。ERROR 多めのファイルは §4 警告が出る(仕様)
    wasm: "lean4.wasm",
    comment: /* @__PURE__ */ new Set(["line_comment", "block_comment", "doc_comment"]),
    string: /* @__PURE__ */ new Set(["str_lit"]),
    opaque: /* @__PURE__ */ new Set(),
    // スコープ(ブレッドクラム §9)のノード種別は未調査 → 当面 LINE n/m のみ。
    // 実ファイルの parse 結果を見て後日追加(空でも他機能に影響なし)
    named: {},
    block: {},
    lineComment: ["--"]
  }
  // c / rust / go / haskell: wasm ビルド後に追加(それまでは簡易フォールバック)
};
var FALLBACK_LINE_COMMENTS = {
  c: ["//"],
  rust: ["//"],
  go: ["//"],
  haskell: ["--"],
  lean4: ["--"],
  plain: ["//", "#"]
};
async function analyze(source, language, fileName) {
  const rules = RULES[language];
  if (rules?.wasm === void 0) return simpleAnalyze(source, language);
  const wasmFile = language === "typescript" && fileName !== void 0 && /\.tsx$/i.test(fileName) ? "tsx.wasm" : rules.wasm;
  try {
    await ensureParserInit();
    const lang = await loadLanguage(wasmFile);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (tree === null) throw new Error("parse \u304C\u30AD\u30E3\u30F3\u30BB\u30EB\u3055\u308C\u305F");
    try {
      return extract(tree.rootNode, source, language, rules);
    } finally {
      tree.delete();
    }
  } catch (e) {
    console.warn(`[CODE://INJECT] ${language} \u306E Tree-sitter \u89E3\u6790\u306B\u5931\u6557\u3002\u7C21\u6613\u89E3\u6790\u3067\u7D9A\u884C:`, e);
    return simpleAnalyze(source, language);
  }
}
function loadLanguage(wasmFile) {
  let cached = languageCache.get(wasmFile);
  if (cached === void 0) {
    cached = config.fetchBytes(config.grammarBase + wasmFile).then((bytes) => Language.load(bytes));
    cached.catch(() => languageCache.delete(wasmFile));
    languageCache.set(wasmFile, cached);
  }
  return cached;
}
function makeToCell(source) {
  if (!/[\uD800-\uDBFF]/.test(source)) return (i) => i;
  const map = new Int32Array(source.length + 1);
  let cp = 0;
  for (let i = 0; i < source.length; cp++) {
    map[i] = cp;
    const wide = (source.codePointAt(i) ?? 0) > 65535;
    if (wide) map[i + 1] = cp;
    i += wide ? 2 : 1;
  }
  map[source.length] = cp;
  return (i) => map[Math.max(0, Math.min(i, source.length))] ?? cp;
}
function extract(root, source, language, rules) {
  const toCell = makeToCell(source);
  const comments = [];
  const strings = [];
  const tokens = [];
  const scopes = [];
  const scopeStack = [];
  let errorChars = 0;
  let errorDepth = 0;
  const enter = (node) => {
    const type = node.type;
    if (type === "ERROR") {
      if (errorDepth === 0) errorChars += node.endIndex - node.startIndex;
      errorDepth++;
      return true;
    }
    if (rules.comment.has(type)) {
      const span = { start: toCell(node.startIndex), end: toCell(node.endIndex) };
      const kind = type.includes("block") || type === "doc_comment" || source.startsWith("/*", node.startIndex) || source.startsWith("/-", node.startIndex) ? "block" : "line";
      comments.push({ ...span, kind });
      tokens.push({ ...span, cls: "comment" });
      return false;
    }
    if (rules.string.has(type)) {
      if (isDocstring(node, rules)) {
        const span = { start: toCell(node.startIndex), end: toCell(node.endIndex) };
        comments.push({ ...span, kind: "block" });
        tokens.push({ ...span, cls: "comment" });
        return false;
      }
      strings.push(stringSpanOf(node, toCell));
      tokens.push({ start: toCell(node.startIndex), end: toCell(node.endIndex), cls: "string" });
      return false;
    }
    if (rules.opaque.has(type)) {
      tokens.push({ start: toCell(node.startIndex), end: toCell(node.endIndex), cls: "string" });
      return false;
    }
    const named = rules.named[type];
    const block = rules.block[type];
    if (named !== void 0 || block !== void 0) {
      const scope = {
        start: toCell(node.startIndex),
        end: toCell(node.endIndex),
        label: named !== void 0 ? namedLabel(node, named, source) : block ?? type,
        kind: type,
        children: []
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
          cls: classifyLeaf(node, source)
        });
      }
      return false;
    }
    return true;
  };
  const exit = (node) => {
    if (node.type === "ERROR") errorDepth--;
    else if (rules.named[node.type] !== void 0 || rules.block[node.type] !== void 0) {
      scopeStack.pop();
    }
  };
  walk(root.walk(), enter, exit);
  const total = [...source].length;
  return {
    language,
    engine: "tree-sitter",
    // 定義は types.ts 参照: ERROR に覆われる文字数 ÷ 総文字数(UTF-16 差でも比としては十分)
    errorRatio: total > 0 ? Math.min(1, errorChars / source.length) : 0,
    comments,
    strings,
    tokens,
    scopes
  };
}
function isDocstring(node, rules) {
  if (rules.docstring !== true) return false;
  const stmt = node.parent;
  if (stmt === null || stmt.type !== "expression_statement" || stmt.namedChildCount !== 1) {
    return false;
  }
  const body = stmt.parent;
  if (body === null) return false;
  const isBodyOfScope = body.type === "module" || body.type === "block" && (body.parent?.type === "function_definition" || body.parent?.type === "class_definition");
  if (!isBodyOfScope) return false;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child === null || rules.comment.has(child.type)) continue;
    return child.startIndex === stmt.startIndex && child.endIndex === stmt.endIndex;
  }
  return false;
}
function walk(cursor, enter, exit) {
  outer: while (true) {
    if (enter(cursor.currentNode) && cursor.gotoFirstChild()) continue;
    while (true) {
      exit(cursor.currentNode);
      if (cursor.gotoNextSibling()) continue outer;
      if (!cursor.gotoParent()) return;
    }
  }
}
function stringSpanOf(node, toCell) {
  const first = node.firstChild;
  const last = node.lastChild;
  const isDelim = (n) => n !== null && (!n.isNamed || n.type === "string_start" || n.type === "string_end");
  const openEnd = isDelim(first) && first.startIndex === node.startIndex ? first.endIndex : node.startIndex;
  const closeStart = isDelim(last) && last.endIndex === node.endIndex && last.startIndex >= openEnd ? last.startIndex : node.endIndex;
  return {
    start: toCell(node.startIndex),
    end: toCell(node.endIndex),
    openEnd: toCell(openEnd),
    closeStart: toCell(closeStart)
  };
}
function namedLabel(node, kind, source) {
  const name = fieldText(node, "name", source) ?? // 無名関数(arrow 等): 代入先の変数名を借りる(const f = () => ...)
  (node.parent !== null ? fieldText(node.parent, "name", source) : null);
  if (kind === "func") return `${name ?? "fn"}()`;
  return name !== null ? `${node.type.split("_")[0]} ${name}` : node.type;
}
function fieldText(node, field, source) {
  const n = node.childForFieldName(field);
  return n !== null ? source.slice(n.startIndex, n.endIndex) : null;
}
function classifyLeaf(node, source) {
  const type = node.type;
  if (!node.isNamed) {
    if (/^[A-Za-z_][\w$]*$/.test(type)) return "keyword";
    if (/^[()[\]{};,.:]+$/.test(type)) return "punctuation";
    return "operator";
  }
  if (type === "type_identifier") return "type";
  if (type === "identifier" || type.endsWith("_identifier")) {
    const p = node.parent;
    if (p !== null) {
      const isField = (f) => p.childForFieldName(f)?.id === node.id;
      if ((p.type === "call_expression" || p.type === "call") && isField("function")) return "function";
      if (isField("name") && /function|method|definition|declaration/.test(p.type)) {
        return /class|interface|enum|type/.test(p.type) ? "type" : "function";
      }
    }
    return "identifier";
  }
  if (type === "number" || type === "integer" || type === "float") return "number";
  if (type === "escape_sequence" || type.startsWith("string_")) return "string";
  if (source.slice(node.startIndex, node.endIndex) === type) return "keyword";
  return "plain";
}
function simpleAnalyze(source, language) {
  const markers = RULES[language]?.lineComment ?? FALLBACK_LINE_COMMENTS[language] ?? ["//", "#"];
  const comments = [];
  const tokens = [];
  let lineStart = 0;
  for (const line of source.split("\n")) {
    const chars = [...line];
    const trimmed = line.trimStart();
    if (markers.some((m) => trimmed.startsWith(m))) {
      const indent = chars.length - [...trimmed].length;
      const span = { start: lineStart + indent, end: lineStart + chars.length };
      comments.push({ ...span, kind: "line" });
      tokens.push({ ...span, cls: "comment" });
    }
    lineStart += chars.length + 1;
  }
  return { language, engine: "simple", errorRatio: 0, comments, strings: [], tokens, scopes: [] };
}

// src/charModel.ts
var OPENERS = "([{";
var CLOSERS = ")]}";
function isOpener(ch) {
  return ch.length === 1 && OPENERS.includes(ch);
}
function isCloser(ch) {
  return ch.length === 1 && CLOSERS.includes(ch);
}
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}
function isTypeableChar(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 32 && cp <= 126;
}
function buildCharModel(rawText, language = "plain", analysis) {
  const source = normalizeNewlines(rawText);
  const a = analysis ?? simpleAnalyze(source, language);
  const chars = [...source];
  const n = chars.length;
  const inComment = new Uint8Array(n);
  for (const c of a.comments) {
    for (let i = Math.max(0, c.start); i < Math.min(c.end, n); i++) inComment[i] = 1;
    for (let i = c.start - 1; i >= 0 && (chars[i] === " " || chars[i] === "	"); i--) {
      inComment[i] = 1;
    }
  }
  const inString = new Uint8Array(n);
  for (const s of a.strings) {
    for (let i = Math.max(0, s.start); i < Math.min(s.end, n); i++) inString[i] = 1;
  }
  const cells = [];
  let line = 0;
  let col = 0;
  let atIndent = true;
  let lineHasTypable = false;
  let lineHasComment = false;
  let lineHasNonascii = false;
  for (let i = 0; i < n; i++) {
    const ch = chars[i] ?? "";
    if (ch === "\n") {
      const lineAllSkipped = !lineHasTypable && (lineHasComment || lineHasNonascii);
      const skip2 = inComment[i] === 1 || lineAllSkipped && lineHasComment ? "comment" : lineAllSkipped ? "nonascii" : null;
      cells.push({ ch, line, col, skip: skip2, match: -1, pair: null });
      line++;
      col = 0;
      atIndent = true;
      lineHasTypable = false;
      lineHasComment = false;
      lineHasNonascii = false;
      continue;
    }
    const isSpace = ch === " " || ch === "	";
    if (!isSpace) atIndent = false;
    let skip = null;
    if (inComment[i] === 1) {
      skip = "comment";
      lineHasComment = true;
    } else if (atIndent && isSpace) {
      skip = "indent";
    } else if (ch === "	") {
      skip = "tab";
    } else if (!isTypeableChar(ch)) {
      skip = "nonascii";
      lineHasNonascii = true;
    } else {
      lineHasTypable = true;
    }
    cells.push({ ch, line, col, skip, match: -1, pair: null });
    col++;
  }
  pairBrackets(cells, inString);
  pairQuotes(cells, a);
  return {
    cells,
    source,
    lineCount: line + 1,
    typableCount: cells.reduce((m, c) => c.skip === null ? m + 1 : m, 0),
    language,
    analysis: a
  };
}
function pairBrackets(cells, inString) {
  const stack = [];
  cells.forEach((cell, i) => {
    if (cell.skip !== null || inString[i] === 1) return;
    const oi = OPENERS.indexOf(cell.ch);
    if (oi >= 0) {
      cell.pair = "open";
      stack.push({ index: i, closer: CLOSERS.charAt(oi) });
      return;
    }
    if (isCloser(cell.ch)) {
      cell.pair = "close";
      const top = stack[stack.length - 1];
      if (top !== void 0 && top.closer === cell.ch) {
        stack.pop();
        const opener = cells[top.index];
        if (opener !== void 0) opener.match = i;
        cell.match = top.index;
      }
    }
  });
}
function pairQuotes(cells, analysis) {
  for (const s of analysis.strings) {
    if (!(s.start < s.openEnd && s.openEnd <= s.closeStart && s.closeStart < s.end)) continue;
    const open = cells[s.start];
    const close = cells[s.closeStart];
    if (open === void 0 || close === void 0) continue;
    if (open.skip !== null || close.skip !== null) continue;
    for (let i = s.start; i < s.openEnd; i++) {
      const c = cells[i];
      if (c !== void 0 && c.skip === null) c.pair = "open";
    }
    for (let i = s.closeStart; i < s.end; i++) {
      const c = cells[i];
      if (c !== void 0 && c.skip === null) c.pair = "close";
    }
    open.match = s.closeStart;
    close.match = s.start;
  }
}

// src/types.ts
var ENGINE = {
  /** 同一箇所でこの回数連続ミスしたら正解文字を黄色強調(救済) */
  hintAfterMisses: 3
};

// src/input.ts
var InputEngine = class {
  model;
  mode;
  idx = 0;
  started = false;
  finished = false;
  startTime = 0;
  lastEventTime = 0;
  finishTime = null;
  hits = 0;
  misses = 0;
  combo = 0;
  maxCombo = 0;
  missStreak = 0;
  passedCount = 0;
  missIndices = [];
  events = [];
  constructor(model, mode = "ranking") {
    this.model = model;
    this.mode = mode;
  }
  /** 現在のカーソル位置(cells インデックス)。done 時は cells.length */
  get cursor() {
    return this.idx;
  }
  get done() {
    return this.finished;
  }
  get isStarted() {
    return this.started;
  }
  /** プレイ開始。行頭のスキップ(コメント行等)を自動通過する */
  start(now) {
    if (this.started) return;
    this.started = true;
    this.startTime = now;
    this.lastEventTime = now;
    this.advanceSkips();
    this.checkFinish(now);
  }
  /**
   * 1 打鍵の処理。
   * @param key 正規化済みキー(1 文字 or '\n')
   * @param now 打鍵時刻(performance.now() 系の単調時刻)
   */
  handleKey(key, now) {
    if (!this.started || this.finished) return { kind: "ignored" };
    if (key !== "\n" && [...key].length !== 1) return { kind: "ignored" };
    const cur = this.model.cells[this.idx];
    if (cur === void 0) return { kind: "ignored" };
    if (key === cur.ch) {
      const index = this.idx;
      this.recordEvent(key, now, true, 0);
      this.onHit();
      this.idx = index + 1;
      this.advanceSkips();
      this.checkFinish(now);
      return { kind: "hit", index };
    }
    if (cur.pair === "close") {
      const t = this.tryTypeOver(key);
      if (t !== null) {
        this.recordEvent(key, now, true, t.passed.length);
        this.passedCount += t.passed.length;
        this.onHit();
        this.idx = t.hitIndex + 1;
        this.advanceSkips();
        this.checkFinish(now);
        return { kind: "pass", passed: t.passed, hitIndex: t.hitIndex };
      }
    }
    this.recordEvent(key, now, false, 0);
    this.misses++;
    this.combo = 0;
    this.missStreak++;
    this.missIndices.push(this.idx);
    return { kind: "miss", index: this.idx, missStreak: this.missStreak };
  }
  /** 救済ヒント(§3: 同一箇所 3 連続ミスで正解文字を黄色強調)を出すべきか */
  get hintActive() {
    return this.missStreak >= ENGINE.hintAfterMisses;
  }
  stats(now) {
    const elapsedMs = Math.max(0, (this.finishTime ?? now) - this.startTime);
    const minutes = elapsedMs / 6e4;
    const total = this.hits + this.misses;
    return {
      wpm: minutes > 0 ? this.hits / 5 / minutes : 0,
      accuracy: total > 0 ? this.hits / total * 100 : 100,
      combo: this.combo,
      maxCombo: this.maxCombo,
      hits: this.hits,
      misses: this.misses,
      passedCount: this.passedCount,
      elapsedMs
    };
  }
  /**
   * 確定リザルト(§10)。
   * @param now 単調時刻(elapsed 計算用)
   * @param wallClock 履歴表示用の epoch ms(テストでは固定値を渡す)
   */
  result(now, wallClock = Date.now()) {
    return {
      ...this.stats(now),
      mode: this.mode,
      language: this.model.language,
      missIndices: [...this.missIndices],
      finishedAt: wallClock
    };
  }
  /**
   * リプレイ(§11)。
   * @param sourceHash 原文の SHA-256(replay.hashSource)。P5 から保存・共有時は必須
   *                   (ゴースト照合 §10・投稿検証 P7 の鍵)。テスト等では省略可
   */
  replay(sourceHash) {
    return {
      formatVersion: 1,
      language: this.model.language,
      mode: this.mode,
      ...sourceHash !== void 0 ? { sourceHash } : {},
      events: [...this.events]
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
  tryTypeOver(key) {
    const cells = this.model.cells;
    const passed = [];
    let j = this.idx;
    while (j < cells.length) {
      const cell = cells[j];
      if (cell === void 0) break;
      if (cell.skip !== null) {
        j++;
        continue;
      }
      if (cell.pair === "close") {
        if (j > this.idx && cell.ch === key) {
          return { passed, hitIndex: j };
        }
        passed.push(j);
        j++;
        continue;
      }
      return cell.ch === key ? { passed, hitIndex: j } : null;
    }
    return null;
  }
  onHit() {
    this.hits++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.missStreak = 0;
  }
  advanceSkips() {
    const cells = this.model.cells;
    while (this.idx < cells.length) {
      const cell = cells[this.idx];
      if (cell === void 0 || cell.skip === null) break;
      this.idx++;
    }
  }
  checkFinish(now) {
    if (this.idx >= this.model.cells.length && !this.finished) {
      this.finished = true;
      this.finishTime = now;
    }
  }
  recordEvent(key, now, ok, passed) {
    this.events.push({
      key,
      dt: Math.max(0, Math.round(now - this.lastEventTime)),
      ok,
      passed
    });
    this.lastEventTime = now;
  }
};

// src/hud.ts
function mustGet(doc, id) {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`hud: \u8981\u7D20 #${id} \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093(index.html \u3092\u78BA\u8A8D)`);
  return el;
}
var Hud = class {
  doc;
  codeEl;
  crumbEl;
  wpmEl;
  accEl;
  comboEl;
  comboFillEl;
  resultEl;
  model = null;
  /** cells と同順の span 参照(モックの chars[].el 相当をこちら側で持つ) */
  spans = [];
  rows = [];
  lastCursor = 0;
  curIndex = null;
  ghostIndex = null;
  lastCrumb = "";
  reducedMotion;
  constructor(doc = document) {
    this.doc = doc;
    this.codeEl = mustGet(doc, "code");
    this.crumbEl = mustGet(doc, "crumb");
    this.wpmEl = mustGet(doc, "wpm");
    this.accEl = mustGet(doc, "acc");
    this.comboEl = mustGet(doc, "combo");
    this.comboFillEl = mustGet(doc, "comboFill");
    this.resultEl = mustGet(doc, "result");
    this.reducedMotion = doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
  }
  // ------------------------------------------------------------ コード構築
  /** CharModel からコード表示 DOM を構築する */
  mount(model) {
    this.model = model;
    this.spans = [];
    this.rows = [];
    this.lastCursor = 0;
    this.curIndex = null;
    this.ghostIndex = null;
    this.lastCrumb = "";
    this.codeEl.textContent = "";
    const frag = this.doc.createDocumentFragment();
    let row = this.newRow();
    for (const cell of model.cells) {
      const s = this.doc.createElement("span");
      if (cell.ch === "\n") {
        s.className = "ch newline-mark";
        s.textContent = "\u23CE";
      } else {
        s.className = "ch";
        s.textContent = cell.ch;
      }
      if (cell.skip !== null) s.classList.add("skip");
      row.appendChild(s);
      this.spans.push(s);
      if (cell.ch === "\n") {
        frag.appendChild(row);
        this.rows.push(row);
        row = this.newRow();
      }
    }
    frag.appendChild(row);
    this.rows.push(row);
    this.codeEl.appendChild(frag);
    this.paintTokens(model);
  }
  /**
   * 薄字シンタックスハイライト(§9)。未入力トークンを低彩度で色分けする。
   * コメント(skip)は .skip の「通電しない暗さ」(§7)を優先し、改行マークも除外
   */
  paintTokens(model) {
    for (const t of model.analysis.tokens) {
      if (t.cls === "plain" || t.cls === "identifier") continue;
      for (let i = t.start; i < Math.min(t.end, this.spans.length); i++) {
        const cell = model.cells[i];
        if (cell === void 0 || cell.skip !== null || cell.ch === "\n") continue;
        this.spans[i]?.classList.add(`tk-${t.cls}`);
      }
    }
  }
  newRow() {
    const row = this.doc.createElement("span");
    row.className = "row";
    return row;
  }
  focus() {
    this.codeEl.focus();
  }
  // ------------------------------------------------------------ 打鍵反映
  /** プレイ開始時。先頭のスキップ(コメント行等)を消化してカーソルを置く */
  begin(cursor) {
    this.advanceTo(cursor, null, null);
  }
  /**
   * KeyResult を描画に反映する。
   * @param res        エンジンの判定結果
   * @param newCursor  処理後の engine.cursor
   * @param hintActive 救済ヒント(§3)を表示すべきか
   */
  apply(res, newCursor, hintActive) {
    switch (res.kind) {
      case "hit":
        this.advanceTo(newCursor, res.index, null);
        break;
      case "pass":
        this.advanceTo(newCursor, res.hitIndex, new Set(res.passed));
        break;
      case "miss":
        this.missEffect(res.index, hintActive);
        break;
      case "ignored":
        break;
    }
  }
  /**
   * [lastCursor, newCursor) を消化して描画。
   * - hitIndex: 通常ヒットの1文字(フラッシュ演出)
   * - passed:   type-over 通過セル(中抜き表示)。それ以外は自動スキップ分(done)
   */
  advanceTo(newCursor, hitIndex, passed) {
    for (let i = this.lastCursor; i < newCursor; i++) {
      const s = this.spans[i];
      if (s === void 0) continue;
      s.classList.remove("cur", "hint", "pair-lit");
      s.classList.add(passed?.has(i) === true ? "passed" : "done");
      if (i === hitIndex) this.retrigger(s, "flash");
    }
    if (hitIndex !== null && this.model !== null) {
      const cell = this.model.cells[hitIndex];
      if (cell !== void 0 && cell.pair === "open" && cell.match >= 0) {
        this.spans[cell.match]?.classList.add("pair-lit");
      }
    }
    this.lastCursor = newCursor;
    this.setCursor(newCursor);
  }
  setCursor(index) {
    if (this.curIndex !== null) this.spans[this.curIndex]?.classList.remove("cur");
    for (const r of this.rows) r.classList.remove("current");
    if (index >= this.spans.length) {
      this.curIndex = null;
      return;
    }
    const s = this.spans[index];
    const cell = this.model?.cells[index];
    if (s === void 0 || cell === void 0) return;
    this.curIndex = index;
    s.classList.add("cur");
    this.rows[cell.line]?.classList.add("current");
    s.scrollIntoView({ block: "center", behavior: this.reducedMotion ? "auto" : "smooth" });
    this.setCrumb(index, cell.line);
  }
  /**
   * ゴーストカーソル(§10, P5): 本走カーソルと独立に並走する 2 本目のカーソル。
   * null または範囲外(完走)で非表示。スクロールは本走カーソルだけが握る
   */
  setGhost(index) {
    const next = index !== null && index < this.spans.length ? index : null;
    if (next === this.ghostIndex) return;
    if (this.ghostIndex !== null) this.spans[this.ghostIndex]?.classList.remove("ghost-cur");
    this.ghostIndex = next;
    if (next !== null) this.spans[next]?.classList.add("ghost-cur");
  }
  missEffect(index, hintActive) {
    const s = this.spans[index];
    if (s === void 0) return;
    this.retrigger(s, "misshit");
    if (hintActive) s.classList.add("hint");
    const body = this.doc.body;
    body.classList.add("shake");
    setTimeout(() => body.classList.remove("shake"), 130);
  }
  /** CSS アニメーションを再発火させる(連打対応) */
  retrigger(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  // ------------------------------------------------------------ HUD / リザルト
  /**
   * 構造ブレッドクラム(§9): `LINE n/m › fib() › if`。
   * scopes(開始位置順の木)を根からカーソル位置で辿る。ラベルはソース由来の
   * 文字列なので textContent で描く(innerHTML 不可)
   */
  setCrumb(index, line) {
    const model = this.model;
    if (model === null) return;
    const segs = [`LINE ${line + 1}/${model.lineCount}`];
    let nodes = model.analysis.scopes;
    while (true) {
      const hit = nodes.find((sc) => sc.start <= index && index < sc.end);
      if (hit === void 0) break;
      segs.push(hit.label);
      nodes = hit.children;
    }
    const key = segs.join("\n");
    if (key === this.lastCrumb) return;
    this.lastCrumb = key;
    this.crumbEl.textContent = "";
    segs.forEach((label, i) => {
      if (i > 0) {
        const sep = this.doc.createElement("span");
        sep.className = "sep";
        sep.textContent = "\u203A";
        this.crumbEl.appendChild(sep);
      }
      const seg = this.doc.createElement("span");
      seg.className = "seg";
      seg.textContent = label;
      this.crumbEl.appendChild(seg);
    });
  }
  updateStats(stats) {
    this.wpmEl.textContent = String(Math.round(stats.wpm));
    this.accEl.textContent = String(Math.round(stats.accuracy));
    this.comboEl.textContent = String(stats.combo);
    this.comboEl.classList.toggle("combo-hot", stats.combo >= 10);
    this.comboFillEl.style.width = `${Math.min(stats.combo * 2.5, 100)}%`;
  }
  showResult(r, score) {
    const set = (id, v) => {
      mustGet(this.doc, id).textContent = v;
    };
    const wpm = Math.round(r.wpm);
    const acc = Math.round(r.accuracy);
    if (score === null) {
      set("rScore", "---");
      set("rScoreNote", "NO SCORE \u2014 \u96E3\u6613\u5EA6\u7B97\u51FA\u4E0D\u53EF\u306E\u305F\u3081\u30E9\u30F3\u30AD\u30F3\u30B0\u5BFE\u8C61\u5916(\u30D7\u30EC\u30FC\u30F3\u30C6\u30AD\u30B9\u30C8)");
    } else {
      set("rScore", (Math.round(score.score * 10) / 10).toFixed(1));
      set(
        "rScoreNote",
        `WPM ${r.wpm.toFixed(1)} \xD7 DIFFICULTY ${score.difficulty.value.toFixed(4)} \xD7 LENGTH ${score.lengthFactor.toFixed(4)} \u2014 score v${score.difficulty.scoreVersion}`
      );
    }
    set("rWpm", String(wpm));
    set("rAcc", `${acc}%`);
    set("rMax", String(r.maxCombo));
    set("rPass", String(r.passedCount));
    set("rTime", formatTime(r.elapsedMs));
    this.resultEl.classList.remove("hidden");
  }
};
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1e3);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// src/replay.ts
async function hashSource(source) {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var LANGS = [
  "javascript",
  "typescript",
  "python",
  "c",
  "rust",
  "go",
  "haskell",
  "lean4",
  "plain"
];
var MODES = ["ranking", "practice"];
function pack(r) {
  const keys = [];
  const d = [];
  const x = [];
  const p = [];
  r.events.forEach((ev, i) => {
    keys.push(ev.key);
    d.push(ev.dt);
    if (!ev.ok) x.push(i);
    if (ev.passed !== 0) p.push([i, ev.passed]);
  });
  return {
    f: 1,
    l: r.language,
    m: r.mode,
    h: r.sourceHash ?? "",
    k: keys.join(""),
    d,
    x,
    p
  };
}
function unpack(o) {
  const keys = [...o.k];
  const missSet = new Set(o.x);
  const passedMap = new Map(o.p);
  const events = keys.map((key, i) => ({
    key,
    dt: o.d[i] ?? 0,
    ok: !missSet.has(i),
    passed: passedMap.get(i) ?? 0
  }));
  return {
    formatVersion: 1,
    language: o.l,
    mode: o.m,
    ...o.h !== "" ? { sourceHash: o.h } : {},
    events
  };
}
function validatePacked(o) {
  const fail = (why) => {
    throw new Error(`replay: \u5FA9\u53F7\u30C7\u30FC\u30BF\u304C\u4E0D\u6B63\u3067\u3059(${why})`);
  };
  if (typeof o !== "object" || o === null) fail("not object");
  const r = o;
  if (r["f"] !== 1) fail("format version");
  if (typeof r["l"] !== "string" || !LANGS.includes(r["l"])) fail("language");
  if (typeof r["m"] !== "string" || !MODES.includes(r["m"])) fail("mode");
  if (typeof r["h"] !== "string" || !/^([0-9a-f]{64})?$/.test(r["h"])) fail("sourceHash");
  if (typeof r["k"] !== "string") fail("keys");
  const n = [...r["k"]].length;
  const d = r["d"];
  if (!Array.isArray(d) || d.length !== n) fail("dt \u5217\u9577");
  if (!d.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) {
    fail("dt \u5024");
  }
  const x = r["x"];
  if (!Array.isArray(x) || !x.every((v) => Number.isInteger(v) && v >= 0 && v < n)) fail("miss \u6DFB\u5B57");
  const p = r["p"];
  if (!Array.isArray(p) || !p.every(
    (e) => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < n && Number.isInteger(e[1]) && e[1] > 0
  )) {
    fail("passed \u30EA\u30B9\u30C8");
  }
  return o;
}
async function pipeBytes(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}
function toBase64Url(bytes) {
  let bin = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("replay: Base64URL \u5F62\u5F0F\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function encodeReplay(r) {
  const json = new TextEncoder().encode(JSON.stringify(pack(r)));
  return toBase64Url(await pipeBytes(json, new CompressionStream("deflate-raw")));
}
async function decodeReplay(s) {
  const json = await pipeBytes(fromBase64Url(s), new DecompressionStream("deflate-raw"));
  const parsed = JSON.parse(new TextDecoder().decode(json));
  return unpack(validatePacked(parsed));
}

// src/ghost.ts
var GhostPlayer = class {
  engine;
  events;
  /** 各イベントの発生時刻(開始からの累積 ms) */
  times;
  next = 0;
  /** ゴーストの総所要時間(ms)。進捗表示などに使える */
  totalMs;
  /**
   * @param model  今回プレイと同一の CharModel(sourceHash 一致を呼び出し側で確認すること)
   * @param replay 過去の走り(自己ベスト or 共有 URL 由来)
   */
  constructor(model, replay) {
    this.engine = new InputEngine(model, replay.mode);
    this.engine.start(0);
    this.events = replay.events;
    let t = 0;
    this.times = this.events.map((ev) => t += ev.dt);
    this.totalMs = t;
  }
  /**
   * 開始からの経過 ms までのイベントを消化し、ゴーストのカーソル位置を返す。
   * 単調増加の elapsed で呼ぶこと(巻き戻しは非対応 = リプレイは前進のみ)。
   * 完走後は cells.length(=範囲外)を返し続ける
   */
  cursorAt(elapsedMs) {
    while (this.next < this.events.length) {
      const t = this.times[this.next];
      if (t === void 0 || t > elapsedMs) break;
      const ev = this.events[this.next];
      if (ev !== void 0) this.engine.handleKey(ev.key, t);
      this.next++;
    }
    return this.engine.cursor;
  }
  get done() {
    return this.engine.done;
  }
};

// src/storage.ts
var HISTORY_KEY = "codeinject.history.v1";
var GHOST_PREFIX = "codeinject.ghost.v1.";
var HISTORY_MAX = 50;
var LocalStore = class {
  s;
  /** @param storage 省略時はブラウザの localStorage(無い環境では null = 常に no-op) */
  constructor(storage) {
    this.s = storage !== void 0 ? storage : typeof localStorage === "undefined" ? null : localStorage;
  }
  // ------------------------------------------------------------ 履歴(§7 ホーム用)
  /** ローカル履歴(新しい順)。壊れたデータは空扱い */
  history() {
    const raw = this.get(HISTORY_KEY);
    if (raw === null) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  /** 履歴に 1 件追加(先頭 = 最新、HISTORY_MAX 件で切り捨て) */
  addHistory(entry) {
    const next = [entry, ...this.history()].slice(0, HISTORY_MAX);
    this.set(HISTORY_KEY, JSON.stringify(next));
  }
  // ------------------------------------------------------------ ゴースト(§10)
  /** sourceHash のベストゴースト。無ければ null */
  ghost(sourceHash) {
    const raw = this.get(GHOST_PREFIX + sourceHash);
    if (raw === null) return null;
    try {
      const o = JSON.parse(raw);
      if (typeof o === "object" && o !== null && typeof o.wpm === "number" && typeof o.encoded === "string") {
        return o;
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
  saveGhostIfBetter(sourceHash, encoded, wpm, savedAt) {
    const cur = this.ghost(sourceHash);
    if (cur !== null && cur.wpm >= wpm) return false;
    const rec = { wpm, encoded, savedAt };
    return this.set(GHOST_PREFIX + sourceHash, JSON.stringify(rec));
  }
  // ------------------------------------------------------------ 低レベル(全部 no-throw)
  get(key) {
    try {
      return this.s?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  set(key, value) {
    try {
      this.s?.setItem(key, value);
      return this.s !== null;
    } catch {
      return false;
    }
  }
};
export {
  CLOSERS,
  GhostPlayer,
  HISTORY_MAX,
  Hud,
  InputEngine,
  LocalStore,
  OPENERS,
  analyze,
  buildCharModel,
  decodeReplay,
  detectLanguage,
  encodeReplay,
  hashSource,
  initAnalyzer,
  isCloser,
  isOpener,
  isTypeableChar,
  normalizeNewlines,
  simpleAnalyze
};
