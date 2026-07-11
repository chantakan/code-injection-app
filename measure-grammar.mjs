/**
 * measure-grammar.mjs — 文法wasmの品質判定(§2 Lean4、§13)
 *
 * analyzer.ts と同じ定義の ERROR 率(ERROR ノードに覆われる文字数 ÷ 総文字数)を
 * 実ファイルで測る。RULES 追加時の参考として、コメント/文字列らしきノード種別も出す。
 *
 * 使い方:
 *   node measure-grammar.mjs <文法.wasm> <ソースファイル...>
 * 例:
 *   node measure-grammar.mjs public/grammars/lean4.wasm ~/lean/src/*.lean
 *
 * 判定目安(P2 で合意した基準):
 *   平均 10% 超 → 簡易パースへフォールバック(RULES に wasm を書かない)
 *   平均 10% 以下 → RULES に lean4 を追加して採用
 */
import { readFile } from 'node:fs/promises';
import { Parser, Language } from 'web-tree-sitter';

const [wasmPath, ...files] = process.argv.slice(2);
if (wasmPath === undefined || files.length === 0) {
  console.error('使い方: node measure-grammar.mjs <文法.wasm> <ソースファイル...>');
  process.exit(1);
}

await Parser.init();
const lang = await Language.load(new Uint8Array(await readFile(wasmPath)));
const parser = new Parser();
parser.setLanguage(lang);

/** ERROR ノードの文字被覆を非再帰 DFS で数える(analyzer.ts の extract と同じ考え方) */
function measure(root) {
  let errorChars = 0;
  let missing = 0;
  let depth = 0;
  const commentTypes = new Set();
  const stringTypes = new Set();

  const cursor = root.walk();
  outer: while (true) {
    const node = cursor.currentNode;
    if (node.type === 'ERROR' && depth === 0) errorChars += node.endIndex - node.startIndex;
    if (node.type === 'ERROR') depth++;
    if (node.isMissing) missing++;
    const t = node.type.toLowerCase();
    if (t.includes('comment')) commentTypes.add(node.type);
    if (t.includes('string') || t.includes('str_lit') || t.includes('char_lit')) stringTypes.add(node.type);

    if (cursor.gotoFirstChild()) continue;
    while (true) {
      if (cursor.currentNode.type === 'ERROR') depth--;
      if (cursor.gotoNextSibling()) continue outer;
      if (!cursor.gotoParent()) return { errorChars, missing, commentTypes, stringTypes };
    }
  }
}

const rows = [];
const allComment = new Set();
const allString = new Set();

for (const file of files) {
  const source = (await readFile(file, 'utf-8')).replace(/\r\n?/g, '\n');
  const tree = parser.parse(source);
  if (tree === null) {
    rows.push({ file, ratio: NaN, missing: 0, chars: source.length });
    continue;
  }
  const m = measure(tree.rootNode);
  m.commentTypes.forEach((t) => allComment.add(t));
  m.stringTypes.forEach((t) => allString.add(t));
  rows.push({
    file,
    ratio: source.length > 0 ? m.errorChars / source.length : 0,
    missing: m.missing,
    chars: source.length,
  });
  tree.delete();
}

console.log('\nファイル別 ERROR 率:');
for (const r of rows) {
  const pct = Number.isNaN(r.ratio) ? 'parse失敗' : `${(r.ratio * 100).toFixed(2)}%`;
  console.log(`  ${pct.padStart(8)}  missing=${String(r.missing).padStart(3)}  ${r.file} (${r.chars}字)`);
}

const valid = rows.filter((r) => !Number.isNaN(r.ratio));
const avg = valid.reduce((s, r) => s + r.ratio, 0) / Math.max(1, valid.length);
const worst = Math.max(...valid.map((r) => r.ratio));
console.log(`\n平均: ${(avg * 100).toFixed(2)}% / 最悪: ${(worst * 100).toFixed(2)}% (${valid.length} ファイル)`);
console.log(`判定: ${avg > 0.1 ? '× フォールバック推奨(平均10%超)' : '○ 採用可(平均10%以下)'}`);

console.log('\nRULES 設定の参考:');
console.log(`  コメント系ノード種別: ${[...allComment].join(', ') || '(検出なし)'}`);
console.log(`  文字列系ノード種別:   ${[...allString].join(', ') || '(検出なし)'}`);