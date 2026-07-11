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
export {
  analyze,
  detectLanguage,
  initAnalyzer,
  simpleAnalyze
};
