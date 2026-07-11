import { defineConfig } from 'vite';

export default defineConfig({
  // さくらのレンタルサーバー上の任意パス配下に置けるよう相対パス出力(§11)
  base: './',
  build: {
    target: 'es2022',
  },
  // P7(ランキング §11): 本番は dist/ と server/ を同一オリジンに置く前提で
  // ranking.ts の既定エンドポイント('./server/rank.php')をそのまま使う。
  // 開発時だけ別プロセスの PHP(`php -S 127.0.0.1:8787 -t .` を repo ルートで起動)へ
  // プロキシする。VITE_RANKING_API_URL を設定した場合はそちらが優先される(main.ts 参照)
  server: {
    proxy: {
      '/server/rank.php': 'http://127.0.0.1:8787',
    },
  },
});