// src/types.ts
var TOKEN_CLASS_CODE = {
  keyword: 0,
  identifier: 1,
  function: 2,
  type: 3,
  string: 4,
  number: 5,
  comment: 6,
  operator: 7,
  punctuation: 8,
  plain: 9
};

// src/difficulty.ts
var config = {};
var enginePromise = null;
var engine = null;
function initDifficulty(c) {
  config = { ...config, ...c };
}
async function ensureEngine() {
  enginePromise ??= (async () => {
    const load = config.loadGlue ?? (() => import("./wasm/difficulty/difficulty_engine.js"));
    const glue = await load();
    if (config.fetchBytes) {
      if (config.wasmUrl === void 0) {
        throw new Error("difficulty: fetchBytes \u4F7F\u7528\u6642\u306F wasmUrl \u306E\u6307\u5B9A\u304C\u5FC5\u8981");
      }
      await glue.default({ module_or_path: await config.fetchBytes(config.wasmUrl) });
    } else if (config.wasmUrl !== void 0) {
      await glue.default({ module_or_path: config.wasmUrl });
    } else {
      await glue.default();
    }
    engine = glue;
    return glue;
  })();
  return enginePromise;
}
async function preloadDifficulty() {
  await ensureEngine();
}
function buildDifficultyInput(model) {
  const n = model.cells.length;
  const cls = new Uint8Array(n).fill(TOKEN_CLASS_CODE.plain);
  for (const t of model.analysis.tokens) {
    const code = TOKEN_CLASS_CODE[t.cls];
    const end = Math.min(t.end, n);
    for (let i = Math.max(0, t.start); i < end; i++) cls[i] = code;
  }
  const depth = new Uint16Array(n);
  const mark = (node, d) => {
    const dd = Math.min(d, 65535);
    const end = Math.min(node.end, n);
    for (let i = Math.max(0, node.start); i < end; i++) depth[i] = dd;
    for (const child of node.children) mark(child, d + 1);
  };
  for (const root of model.analysis.scopes) mark(root, 1);
  const typable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const cell = model.cells[i];
    if (cell !== void 0 && cell.skip === null) typable[i] = 1;
  }
  return { text: model.source, cls, depth, typable };
}
async function computeDifficulty(model) {
  if (model.analysis.engine !== "tree-sitter") return null;
  if (model.typableCount === 0) return null;
  const g = await ensureEngine();
  const { text, cls, depth, typable } = buildDifficultyInput(model);
  return g.computeDifficulty(text, cls, depth, typable);
}
function lengthFactor(typableCount) {
  if (engine === null) {
    throw new Error("difficulty: wasm \u672A\u30ED\u30FC\u30C9(computeDifficulty \u304B preloadDifficulty \u3092\u5148\u306B)");
  }
  return engine.lengthFactor(Math.max(0, Math.floor(typableCount)));
}
function rankingScore(wpm, difficulty, lengthFactorValue) {
  return Math.round(wpm * difficulty.value * lengthFactorValue * 1e4) / 1e4;
}
export {
  buildDifficultyInput,
  computeDifficulty,
  initDifficulty,
  lengthFactor,
  preloadDifficulty,
  rankingScore
};
