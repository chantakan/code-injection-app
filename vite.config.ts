import { defineConfig } from 'vite';

export default defineConfig({
  // さくらのレンタルサーバー上の任意パス配下に置けるよう相対パス出力(§11)
  base: './',
  build: {
    target: 'es2022',
  },
});