/// <reference types="vite/client" />

// P7(ランキング §11): ビルド時に埋め込む API エンドポイント。未設定時は ranking.ts の
// 既定値(同一オリジン相対パス)にフォールバックする(main.ts 参照)
interface ImportMetaEnv {
  readonly VITE_RANKING_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}