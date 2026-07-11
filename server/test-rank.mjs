/**
 * server/test-rank.mjs — P7 server/rank.php 統合テスト(§6, §11, §13)
 * 実行: node server/test-rank.mjs
 * 前提: PHP 7.4+ が `php` コマンドで使える(組み込みサーバー `php -S` を起動する)。
 *
 * server/ 一式を一時ディレクトリへコピーして起動する(リポジトリの
 * server/data/rankings.json を汚さないため)。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;

let n = 0;
const ok = (name) => console.log(`  ok ${++n}: ${name}`);

// ---------------------------------------------------------------- セットアップ
// server/ 一式(rank.php・ng_words.php・data/)を一時ディレクトリへコピーして
// そこを docroot に php -S を起動する(リポジトリの server/data/rankings.json を汚さない)
const tmp = await mkdtemp(join(tmpdir(), 'ci-rank-'));
await cp(join(HERE, 'rank.php'), join(tmp, 'rank.php'));
await cp(join(HERE, 'ng_words.php'), join(tmp, 'ng_words.php'));
const dataDir = join(tmp, 'data');
await mkdir(dataDir, { recursive: true });
const dataFile = join(dataDir, 'rankings.json');
await writeFile(dataFile, '{}');

const server = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', tmp], { stdio: 'pipe' });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += String(d); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`php -S 起動タイムアウト: ${serverErr}`)), 5000);
  const tryConnect = async () => {
    try {
      await fetch(`${BASE}/rank.php`);
      clearTimeout(timer);
      resolve();
    } catch {
      setTimeout(tryConnect, 100);
    }
  };
  tryConnect();
});

async function resetData() {
  await writeFile(dataFile, '{}');
}

/** 妥当なリプレイイベント列を組み立てる(全 hit、dt 一定 §13 再計算ロジックのテスト用) */
function makeEvents(count, dtMs = 100) {
  return Array.from({ length: count }, () => ({ key: 'a', dt: dtMs, ok: true, passed: 0 }));
}

function makeBody(overrides = {}) {
  const typableCount = overrides.typableCount ?? 320;
  const events = overrides.events ?? makeEvents(typableCount, overrides.dtMs ?? 100);
  return {
    name: overrides.name ?? 'テスト太郎',
    language: overrides.language ?? 'javascript',
    difficulty: overrides.difficulty ?? { value: 1.0, scoreVersion: 1 },
    lengthFactor: overrides.lengthFactor ?? 0.5,
    typableCount,
    replay: {
      formatVersion: overrides.formatVersion ?? 1,
      language: overrides.replayLanguage ?? overrides.language ?? 'javascript',
      mode: overrides.mode ?? 'ranking',
      sourceHash: overrides.sourceHash ?? 'a'.repeat(64),
      events,
    },
  };
}

async function post(body) {
  const res = await fetch(`${BASE}/rank.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get() {
  const res = await fetch(`${BASE}/rank.php`);
  return { status: res.status, json: await res.json() };
}

try {
  // -------------------------------------------------------------- GET
  console.log('GET(§7 一覧取得):');
  await resetData();
  {
    const { status, json } = await get();
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(Object.keys(json.rankings).sort(), [
      'c', 'go', 'haskell', 'javascript', 'lean4', 'python', 'rust', 'typescript',
    ].sort());
    for (const lang of Object.keys(json.rankings)) assert.deepEqual(json.rankings[lang], []);
  }
  ok('初期状態は全言語空配列');

  // -------------------------------------------------------------- POST 正常系
  console.log('POST 正常系(§13 リプレイ再計算):');
  await resetData();
  {
    // 320 hits, dt=100ms → elapsedMs=32000ms=0.5333min → wpm = 320/5/0.5333 = 120
    const { status, json } = await post(makeBody({ typableCount: 320, dtMs: 100 }));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.rank, 1);
    assert.equal(json.entries.length, 1);
    assert.equal(json.entries[0].wpm, 120);
    assert.equal(json.entries[0].accuracy, 100);
    // score = wpm(再計算) × difficulty × lengthFactor = 120 × 1.0 × 0.5 = 60
    assert.equal(json.entries[0].score, 60);
  }
  ok('WPM/正確率/スコアはリプレイから再計算した値になる(申告 wpm は存在しないので送りようがない)');

  {
    const { json } = await get();
    assert.equal(json.rankings.javascript.length, 1);
    assert.equal(json.rankings.javascript[0].name, 'テスト太郎');
  }
  ok('投稿後 GET に反映される');

  // -------------------------------------------------------------- POST 検証エラー系
  console.log('POST 検証エラー系(§6, §11):');
  await resetData();

  {
    const { status, json } = await post(makeBody({ name: '' }));
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid-name');
  }
  ok('空の名前は拒否');

  {
    const { status, json } = await post(makeBody({ name: 'あ'.repeat(21) }));
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid-name');
  }
  ok('21文字以上の名前は拒否(NAME_MAX_LEN=20)');

  {
    const { status, json } = await post(makeBody({ name: '死ねよ' }));
    assert.equal(status, 400);
    assert.equal(json.error, 'ng-name');
  }
  ok('NGワードを含む名前は拒否(部分一致)');

  {
    const { status, json } = await post(makeBody({ typableCount: 299, events: makeEvents(299) }));
    assert.equal(status, 400);
    assert.equal(json.error, 'not-eligible');
  }
  ok('typableCount < 300 は投稿資格なしで拒否(§6)');

  {
    const { status, json } = await post(makeBody({ difficulty: { value: 999, scoreVersion: 1 } }));
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid-difficulty');
  }
  ok('難易度スコアが妥当範囲外(改ざん疑い)は拒否');

  {
    const { status, json } = await post(makeBody({ difficulty: { value: 1.0, scoreVersion: 2 } }));
    assert.equal(status, 400);
    assert.equal(json.error, 'unsupported-score-version');
  }
  ok('scoreVersion 不一致(P3 式変更時の混在防止)は拒否');

  {
    const { status, json } = await post(makeBody({ mode: 'practice' }));
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid-replay');
  }
  ok('practice モードのリプレイは投稿対象外(§3, §11)');

  {
    const { status, json } = await post(makeBody({ language: 'javascript', replayLanguage: 'python' }));
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid-replay');
  }
  ok('language と replay.language の不一致は拒否');

  {
    // typableCount を実際のイベント数より多く申告(改ざん試行)
    const { status, json } = await post(makeBody({ typableCount: 320, events: makeEvents(300) }));
    assert.equal(status, 400);
    assert.equal(json.error, 'replay-mismatch');
  }
  ok('typableCount とリプレイの実打鍵数が不一致(改ざん試行)は拒否(§13)');

  {
    // dt をほぼ0にして非現実的な WPM を狙う改ざん試行
    const { status, json } = await post(makeBody({ typableCount: 320, dtMs: 1 }));
    assert.equal(status, 400);
    assert.equal(json.error, 'replay-mismatch');
  }
  ok('非現実的な高WPM(dt改ざん試行)は拒否(MAX_WPM)');

  {
    const { status, json } = await post({ language: 'javascript' }); // 必須フィールド欠落
    assert.equal(status, 400);
    assert.equal(json.ok, false);
  }
  ok('必須フィールド欠落は拒否');

  {
    const res = await fetch(`${BASE}/rank.php`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  }
  ok('未対応メソッドは405');

  // -------------------------------------------------------------- 上位N件トリム
  console.log('上位N件トリム(§11):');
  {
    // TOP_N=100 を直接ファイルへ事前投入(HTTP経由の100回投稿は遅いため)
    const seed = { python: Array.from({ length: 100 }, (_, i) => ({
      name: `p${i + 1}`, wpm: 50, accuracy: 100, difficulty: 1.0,
      score: i + 1, // p1=score1(最下位) 〜 p100=score100(最上位)
      postedAt: i + 1,
    })) };
    await writeFile(dataFile, JSON.stringify(seed));

    // 新規投稿(スコアは全既存より確実に高くなるよう高WPM・高難易度・高長さ係数。
    // MAX_WPM=400 の境界での浮動小数誤差を避けるため十分な余裕を持たせる)
    const { status, json } = await post(makeBody({
      language: 'python', replayLanguage: 'python',
      typableCount: 320, dtMs: 32, // wpm = 320/5/(10240/60000) ≈ 375(MAX_WPM=400に余裕を持って収まる)
      difficulty: { value: 4.0, scoreVersion: 1 }, lengthFactor: 1,
    }));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.entries.length, 100); // 101件目は追加されず100件のまま
    assert.equal(json.rank, 1); // 新規投稿がトップ
    assert.equal(json.entries[0].name, 'テスト太郎');
    assert.ok(!json.entries.some((e) => e.name === 'p1')); // 最下位(p1)が押し出される
    assert.ok(json.entries.some((e) => e.name === 'p2')); // p2以降は残る
  }
  ok('上位N件(=100)のみ保持し、最下位が押し出される(§11)');

  // -------------------------------------------------------------- 排他制御(簡易)
  console.log('排他制御(§11、簡易な並行投稿):');
  await resetData();
  {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post(makeBody({ language: 'go', replayLanguage: 'go', name: `並行${i}`, typableCount: 300, events: makeEvents(300) }))),
    );
    assert.ok(results.every((r) => r.status === 200 && r.json.ok === true));
    const { json } = await get();
    assert.equal(json.rankings.go.length, 5); // 5件とも取りこぼしなく反映(flock による排他)
  }
  ok('同時投稿5件がすべて反映される(取りこぼしなし)');
} finally {
  server.kill();
  await rm(tmp, { recursive: true, force: true });
}

console.log(`server/rank.php: ${n} ok`);
