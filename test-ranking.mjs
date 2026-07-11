/**
 * test-ranking.mjs — P7(ランキング §6, §11, §13)クライアント層単体テスト
 * 実行: npx esbuild test-entry.ts --bundle --format=esm --external:web-tree-sitter \
 *         --outfile=.test/entry.bundle.mjs && node test-ranking.mjs
 * サーバー側(server/rank.php)の検証ロジックは server/test-rank.mjs で別途テストする。
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  initRanking,
  fetchRankings,
  submitRanking,
  renderRankingTabs,
  renderRankingTable,
  entriesFor,
  RANKING_LANGUAGES,
} from './.test/entry.bundle.mjs';

let n = 0;
const ok = (name, fn) => {
  fn();
  console.log(`  ok ${++n}: ${name}`);
};
const okAsync = async (name, fn) => {
  await fn();
  console.log(`  ok ${++n}: ${name}`);
};

// ---------------------------------------------------------------- fetchRankings(§7)
console.log('fetchRankings(§7 ランキング一覧取得):');
await okAsync('GET成功: rankings をそのまま返す', async () => {
  initRanking({
    endpoint: '/server/rank.php',
    fetchImpl: async (url, init) => {
      assert.equal(url, '/server/rank.php');
      assert.equal((init ?? {}).method ?? 'GET', 'GET');
      return { json: async () => ({ ok: true, updatedAt: 1, rankings: { javascript: [] } }) };
    },
  });
  const data = await fetchRankings();
  assert.deepEqual(data, { javascript: [] });
});

await okAsync('GET失敗(ok:false): message を例外として投げる', async () => {
  initRanking({
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'server-error', message: 'ダウン中' }) }),
  });
  await assert.rejects(() => fetchRankings(), /ダウン中/);
});

await okAsync('ネットワークエラー: 例外を投げる(呼び出し側でトースト表示できるように)', async () => {
  initRanking({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(() => fetchRankings());
});

// ---------------------------------------------------------------- submitRanking(§6, §11, §13)
console.log('submitRanking(§6, §11, §13):');
const dummyEntry = () => ({
  name: 'テスト',
  language: 'javascript',
  difficulty: { value: 1.0, scoreVersion: 1 },
  lengthFactor: 0.5,
  typableCount: 300,
  replay: { formatVersion: 1, language: 'javascript', mode: 'ranking', sourceHash: 'a'.repeat(64), events: [] },
});

await okAsync('POST成功: entry を JSON body で送り、確定値(rank/entries)を返す', async () => {
  let sentBody = null;
  initRanking({
    endpoint: '/server/rank.php',
    fetchImpl: async (url, init) => {
      sentBody = JSON.parse(init.body);
      return { json: async () => ({ ok: true, rank: 5, entries: [] }) };
    },
  });
  const res = await submitRanking(dummyEntry());
  assert.equal(res.ok, true);
  assert.equal(res.rank, 5);
  assert.equal(sentBody.name, 'テスト');
  // wpm/accuracy/score/postedAt はサーバーが replay から再計算するため送らない(§13)
  assert.equal('wpm' in sentBody, false);
  assert.equal('accuracy' in sentBody, false);
  assert.equal('score' in sentBody, false);
  assert.equal('postedAt' in sentBody, false);
});

await okAsync('POST失敗(ok:false): 例外にせずそのまま返す(NGワード等 §11)', async () => {
  initRanking({
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'ng-name', message: 'NGです' }) }),
  });
  const res = await submitRanking(dummyEntry());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ng-name');
});

await okAsync('ネットワークエラー: 例外を投げず network-error を返す(main.ts 側で分岐しやすく)', async () => {
  initRanking({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const res = await submitRanking(dummyEntry());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network-error');
});

await okAsync('サーバー応答の JSON parse 失敗: invalid-response を返す', async () => {
  initRanking({
    fetchImpl: async () => ({
      json: async () => {
        throw new Error('bad json');
      },
    }),
  });
  const res = await submitRanking(dummyEntry());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid-response');
});

// ---------------------------------------------------------------- rankingUI(§7 描画)
console.log('rankingUI(§7 ランキング画面描画):');
const dom = new JSDOM('<!DOCTYPE html><div id="tabs"></div><div id="table"></div>');
const doc = dom.window.document;

ok('renderRankingTabs: 8言語ぶんのタブ、active に aria-pressed=true', () => {
  const container = doc.getElementById('tabs');
  let clicked = null;
  renderRankingTabs(container, 'python', (lang) => {
    clicked = lang;
  });
  const buttons = container.querySelectorAll('button');
  assert.equal(RANKING_LANGUAGES.length, 8);
  assert.equal(buttons.length, 8);
  const active = [...buttons].find((b) => b.classList.contains('active'));
  assert.equal(active.getAttribute('aria-pressed'), 'true');
  buttons[0].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(clicked, RANKING_LANGUAGES[0]);
});

ok('renderRankingTable: 0件・未取得は空メッセージ', () => {
  const container = doc.getElementById('table');
  renderRankingTable(container, undefined);
  assert.match(container.textContent, /まだ記録がありません/);
  renderRankingTable(container, []);
  assert.match(container.textContent, /まだ記録がありません/);
});

ok('renderRankingTable: entries をそのまま表描画・XSS注入なし(textContentのみ)', () => {
  const container = doc.getElementById('table');
  const evilName = '<img src=x onerror=alert(1)>';
  renderRankingTable(container, [
    { name: evilName, wpm: 88.4, accuracy: 97.2, difficulty: 1.2, score: 105.6, postedAt: 1 },
  ]);
  assert.equal(container.querySelectorAll('img').length, 0); // innerHTML注入されていない
  assert.equal(container.querySelectorAll('tbody tr').length, 1);
  assert.match(container.textContent, /88\.4/);
  assert.match(container.textContent, /97\.2%/);
  assert.match(container.textContent, /105\.6/);
  assert.ok(container.textContent.includes(evilName)); // タグとしてではなく文字列としてそのまま表示されている
});

ok('entriesFor: null/欠損は undefined', () => {
  assert.equal(entriesFor(null, 'javascript'), undefined);
  assert.equal(entriesFor({ python: [] }, 'javascript'), undefined);
  assert.deepEqual(entriesFor({ javascript: [] }, 'javascript'), []);
});

console.log(`ranking: ${n} ok`);
