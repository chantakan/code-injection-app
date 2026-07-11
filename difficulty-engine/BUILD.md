# P3 難易度エンジン — wasm-pack ビルド手順(手元実行用)

P2 の文法 wasm(tree-sitter CLI `build --wasm`)とは別系統。ここで初めて wasm-pack を使う
(handoff §5/§12。P2 完了メモ「反映事項 #1」のとおり)。

## 0. 前提

- rustup 導入済みであること(`rustc --version` で確認)
- wasm-pack は **cargo のバイナリ**なので、npm の allowScripts 承認は無関係(P2 メモの
  tree-sitter-cli / esbuild のような承認作業は不要)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

※ `cargo install` はソースビルドで数分かかる。急ぐ場合は
   https://rustwasm.github.io/wasm-pack/installer/ のバイナリインストーラでも可。

## 1. ビルド

リポジトリ直下(`difficulty-engine/` の親)で:

```sh
wasm-pack build difficulty-engine --release --target web --no-pack \
  --out-dir ../src/wasm/difficulty
```

- `--target web`: ES モジュール + 手動 init 形式。analyzer.ts と同じ「URL/バイト列を
  注入する」設計にできる(Vite でも Node テストでも動く)
- `--no-pack`: npm パッケージ用 package.json を作らない(npm に見せる必要がないため)
- 出力先を `src/wasm/difficulty/` にするのは、Vite にグルー JS をバンドルさせ、
  wasm だけ `?url` で解決させるため(public/ 配置だとグルーの型が効かない)

生成物(`src/wasm/difficulty/`):

| ファイル | 役割 |
|---|---|
| `difficulty_engine.js` | ES モジュールグルー(default export = init) |
| `difficulty_engine.d.ts` | 型定義(TS strict でそのまま使える) |
| `difficulty_engine_bg.wasm` | エンジン本体 |
| `difficulty_engine_bg.wasm.d.ts` | wasm エクスポートの型 |
| `.gitignore` | wasm-pack が生成(中身 `*`)。**生成物をコミットするなら削除** |

## 2. スモークテスト(ブラウザ不要・Node で確認)

リポジトリ直下に `test-difficulty-smoke.mjs` として保存して `node test-difficulty-smoke.mjs`:

```js
import { readFile } from 'node:fs/promises';
import init, {
  scoreVersion,
  computeDifficulty,
  lengthFactor,
} from './src/wasm/difficulty/difficulty_engine.js';

const bytes = await readFile(
  new URL('./src/wasm/difficulty/difficulty_engine_bg.wasm', import.meta.url),
);
await init({ module_or_path: bytes });

console.log('scoreVersion :', scoreVersion()); // → 1
console.log('lengthFactor :', lengthFactor(1000)); // → 1(雛形は固定値)

// 'ab\n'(3 セル、全部打鍵対象・トークンは identifier×2 + plain)
const bd = computeDifficulty(
  'ab\n',
  new Uint8Array([1, 1, 9]),
  new Uint16Array([0, 0, 0]),
  new Uint8Array([1, 1, 1]),
);
console.log('breakdown    :', bd);
// → { value: 1, scoreVersion: 1, avgKeystrokeCost: 1, symbolDensity: 0,
//     nestDepthNorm: 0, identRepetition: 0 }(雛形の仮値)

// 契約違反は例外(配列長不一致)
try {
  computeDifficulty('ab', new Uint8Array([1]), new Uint16Array(2), new Uint8Array(2));
} catch (e) {
  console.log('length check :', String(e).slice(0, 60), '… OK');
}
```

## 3. Vite 側の配線(次ステップで difficulty.ts を実装したら)

analyzer.ts の initAnalyzer と同じ注入式。main.ts 側はこうなる予定:

```ts
import wasmUrl from './wasm/difficulty/difficulty_engine_bg.wasm?url';
import { initDifficulty } from './difficulty';

initDifficulty({ wasmUrl });
```

## 再ビルドが必要になるとき

- 式・係数・コスト表・長さ係数を変更したとき(= SCORE_VERSION を上げたとき)
- それ以外で JS 側だけの変更なら再ビルド不要
