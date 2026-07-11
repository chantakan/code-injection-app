/**
 * test-e2e.mjs — Playwright 実機テスト(P2 配線: 言語判定→解析→§4チェック→プレイ)
 * 実行: npm i -D playwright-core を入れた上で
 *   npx vite --port 5173 &      # dev サーバーを起動しておく
 *   node test-e2e.mjs           # (CHROMIUM=実行ファイルパス で上書き可)
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';

/** CHROMIUM 環境変数 → よくある実行ファイルパス → インストール済み Chrome 系チャンネル */
async function launchBrowser() {
  const paths = [
    process.env.CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/pw-browsers/chromium',
  ].filter((p) => p !== undefined && existsSync(p));
  for (const executablePath of paths) {
    try { return await chromium.launch({ executablePath }); } catch { /* 次の候補へ */ }
  }
  for (const channel of ['chrome', 'chromium', 'msedge']) {
    try { return await chromium.launch({ channel }); } catch { /* 次の候補へ */ }
  }
  throw new Error(
    'ブラウザが見つかりません。CHROMIUM=/path/to/chrome を指定するか、' +
    'npm i -D playwright && npx playwright install chromium を実行してください',
  );
}

const browser = await launchBrowser();
const page = await browser.newPage();
let n = 0;
const ok = (name) => console.log(`  ok ${++n}: ${name}`);

const paste = (text) =>
  page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);

// ---------------------------------------------------------------- 1. サンプル(JS)
console.log('サンプル開始(javascript / tree-sitter):');
await page.goto(BASE);
await page.click('#startBtn');
await page.waitForSelector('#intro.hidden', { state: 'attached' });
ok('サンプルで開始できる(解析込み)');

assert.ok((await page.locator('.ch.tk-keyword').count()) > 0);
assert.ok((await page.locator('.ch.tk-string').count()) > 0);
ok('薄字ハイライト(tk-keyword / tk-string)が付与される(§9)');

assert.match(await page.locator('#crumb').innerText(), /LINE \d+\/\d+/);
assert.match(await page.locator('#crumb').innerText(), /fib\(\)/);
ok('ブレッドクラムに LINE n/m › fib()(§9)');

await page.locator('#code').click();
await page.keyboard.type('function fib(', { delay: 15 });
assert.ok((await page.locator('.ch.done').count()) >= 13);
ok('打鍵で done が積み上がる(P1 挙動維持)');

assert.equal(await page.locator('.ch.pair-lit').count(), 1);
ok('開き括弧で相方が pair-lit(§3)');

// ---------------------------------------------------------------- 2. ペースト(警告 §4)
console.log('ペースト(構文警告 §4):');
await page.goto(BASE);
await paste('const a = 1;\nconst b = ;\nconsole.log(a);\n'); // 局所エラー: ratio ≈ 0.024
await page.waitForSelector('#intro.hidden', { state: 'attached' });
assert.match(await page.locator('.toast').innerText(), /SYNTAX WARNING/);
assert.match(await page.locator('.toast').innerText(), /javascript/);
ok('警告方式: 開始しつつトースト表示(§4)');
assert.ok((await page.locator('.ch.tk-keyword').count()) > 0);
ok('内容ヒューリスティックで javascript 判定(§2)');

// ---------------------------------------------------------------- 3. 拒否(§4)
console.log('拒否(ERROR率 50%超 §4):');
await page.goto(BASE);
const prose = 'This is definitely not code. Just a plain sentence with words! '.repeat(4);
await page.setInputFiles('#filePick', {
  name: 'prose.js', // 拡張子が言語を主張 → tree-sitter が ERROR まみれ → 拒否
  mimeType: 'text/javascript',
  buffer: Buffer.from(prose, 'utf-8'),
});
await page.waitForFunction(() => {
  const t = document.getElementById('loadNote')?.textContent ?? '';
  return t.includes('解析できません');
});
assert.ok(!(await page.locator('#intro').getAttribute('class')).includes('hidden'));
ok('拒否時はイントロに留まりメッセージ表示(§4)');

// ---------------------------------------------------------------- 4. 散文ペースト → plain
console.log('散文ペースト(plain フォールバック §2):');
await page.goto(BASE);
await paste(prose);
await page.waitForSelector('#intro.hidden', { state: 'attached' });
assert.equal(await page.locator('.ch[class*="tk-"]').count(), 0);
assert.match(await page.locator('#crumb').innerText(), /LINE 1\//);
ok('plain はハイライトなし・LINE n/m のみで写経可(§2)');

// ---------------------------------------------------------------- 5. Python ファイル
console.log('Python ファイル(拡張子判定 + 遅延ロード §2):');
await page.goto(BASE);
const py = '# フィボナッチ\ndef fib(n):\n    """memo"""\n    return n if n <= 1 else fib(n - 1) + fib(n - 2)\n';
await page.setInputFiles('#filePick', {
  name: 'fib.py',
  mimeType: 'text/x-python',
  buffer: Buffer.from(py, 'utf-8'),
});
await page.waitForSelector('#intro.hidden', { state: 'attached' });
assert.ok((await page.locator('.ch.tk-keyword').count()) > 0); // def / return / if / else
assert.match(await page.locator('#crumb').innerText(), /fib\(\)/);
ok('python.wasm 遅延ロード → ハイライト+クラム(§2, §9)');

const firstSkip = page.locator('.ch.skip').first();
assert.equal(await firstSkip.textContent(), '#');
ok('# コメント行が Tree-sitter 判定でスキップ表示');

// ---------------------------------------------------------------- 6. リザルト(P3 §6)
console.log('リザルト(補正スコア P3):');
await page.goto(BASE);
const short = 'const x = 1;\nconsole.log(x);\n';
await paste(short);
await page.waitForSelector('#intro.hidden', { state: 'attached' });
// 全文字をそのまま打鍵(インデント・コメントなし、閉じ括弧も自分で打つ)
await page.keyboard.type(short, { delay: 5 });
await page.waitForSelector('#result:not(.hidden)');
assert.match(await page.locator('#rScore').innerText(), /^\d+\.\d$/);
assert.match(
  await page.locator('#rScoreNote').innerText(),
  /WPM \d+(\.\d)? × DIFFICULTY \d\.\d{4} × LENGTH 0\.\d{4} — score v1/,
);
ok('補正スコア = WPM × DIFFICULTY × LENGTH と内訳表示(§6, scoreVersion 1)');

// plain(散文)は難易度算出不可 → スコア非表示(§2)
await page.goto(BASE);
const prosePlain = 'The quick brown fox jumps over the lazy dog\n';
await paste(prosePlain);
await page.waitForSelector('#intro.hidden', { state: 'attached' });
await page.keyboard.type(prosePlain, { delay: 5 });
await page.waitForSelector('#result:not(.hidden)');
assert.equal(await page.locator('#rScore').innerText(), '---');
assert.match(await page.locator('#rScoreNote').innerText(), /NO SCORE/);
assert.match(await page.locator('#rWpm').innerText(), /^\d+$/);
ok('plain はスコア非表示・統計のみ(§2, §6 ローカルリザルトは通常表示)');

// ---------------------------------------------------------------- 7. サウンド配線(P4 §8)
console.log('サウンド配線(P4 §8):');
const sndPage = await browser.newPage();
const pageErrors = [];
sndPage.on('pageerror', (e) => pageErrors.push(String(e)));
sndPage.on('console', (m) => {
  // 外部リソース(Web フォント等)の読み込み失敗はネットワーク環境依存なので除外
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    pageErrors.push(m.text());
  }
});
// AudioContext の生成回数を数える(ユーザー操作起点の遅延生成を確認する)
await sndPage.addInitScript(() => {
  const Orig = window.AudioContext;
  window.__acCount = 0;
  window.AudioContext = class extends Orig {
    constructor(...a) { super(...a); window.__acCount++; }
  };
});
await sndPage.goto(BASE);
await sndPage.click('#startBtn');
await sndPage.waitForSelector('#intro.hidden', { state: 'attached' });
assert.equal(await sndPage.evaluate(() => window.__acCount), 0);
ok('AudioContext は打鍵まで生成されない(自動再生ポリシー §8)');

await sndPage.locator('#code').click();
// 一定リズムで打鍵 → コンボ→ドローン積層、リズム安定→アルペジオの経路を通す
await sndPage.keyboard.type('function fib(n, memo = {}) {', { delay: 120 });
assert.ok((await sndPage.evaluate(() => window.__acCount)) >= 1);
ok('打鍵で AudioContext 生成(hit/bold/perc 音色の経路)');

// ミス経路: 次の正解は Enter なので 'z' はミス(不協和音+ドローン濁り+剥がれ)
await sndPage.keyboard.press('z');
await sndPage.keyboard.press('Enter'); // 復帰(enter 音の経路)
await sndPage.waitForTimeout(300); // アルペジオ/ドローンのスケジューラを一拍走らせる
assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
ok('hit/miss/enter/ドローン/アルペジオ経路でエラーなし(§8)');

await sndPage.click('#sndBtn');
assert.equal(await sndPage.locator('#sndBtn').innerText(), 'SOUND: OFF');
await sndPage.locator('#code').click();
await sndPage.keyboard.type('  if', { delay: 30 }); // OFF 中の打鍵(早期 return 経路)
await sndPage.click('#sndBtn');
assert.equal(await sndPage.locator('#sndBtn').innerText(), 'SOUND: ON');
assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
ok('サウンドトグル OFF(ドローン即時解放)→ ON 復帰でエラーなし');
await sndPage.close();

// ---------------------------------------------------------------- 8. リプレイ/ゴースト(P5 §10, §11)
console.log('リプレイ/ゴースト(P5 §10, §11):');
const pasteIn = (pg, text) =>
  pg.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);

const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const pA = await ctxA.newPage();
const text5 = 'const x = 1;\nconsole.log(x);\n';
await pA.goto(BASE);
await pasteIn(pA, text5);
await pA.waitForSelector('#intro.hidden', { state: 'attached' });
await pA.keyboard.type(text5, { delay: 5 });
await pA.waitForSelector('#result:not(.hidden)');
await pA.waitForFunction(() =>
  (document.getElementById('rGhostNote')?.textContent ?? '').includes('GHOST SAVED'));
ok('完走でローカル履歴+自己ベストゴースト保存(§11)');

await pA.click('#rShare');
await pA.waitForFunction(() => document.getElementById('rShare')?.textContent === 'COPIED!');
const shareUrl = await pA.evaluate(() => navigator.clipboard.readText());
assert.match(shareUrl, /#r=[A-Za-z0-9_-]+$/);
ok('COPY GHOST URL: 圧縮+Base64URL を # 以降に埋め込み(§11)');

// 同一端末(localStorage 保持)での再挑戦 → 自己ベストゴーストと並走
await pA.goto(BASE);
await pasteIn(pA, text5);
await pA.waitForSelector('#intro.hidden', { state: 'attached' });
assert.match(
  await pA.locator('.toast', { hasText: 'GHOST RACE' }).innerText(),
  /自己ベスト/,
);
await pA.waitForSelector('.ch.ghost-cur', { timeout: 5000 });
ok('再挑戦で GHOST RACE(自己ベスト)+ゴーストカーソル並走(§10)');

// 共有 URL を「別端末」(localStorage なしの新コンテキスト)で開く
const ctxB = await browser.newContext();
const pB = await ctxB.newPage();
await pB.goto(shareUrl);
await pB.waitForFunction(() =>
  (document.getElementById('loadNote')?.textContent ?? '').includes('共有ゴースト'));
ok('#r= URL から共有ゴーストを復号・検出(§11)');

await pasteIn(pB, text5);
await pB.waitForSelector('#intro.hidden', { state: 'attached' });
assert.match(
  await pB.locator('.toast', { hasText: 'GHOST RACE' }).innerText(),
  /共有ゴースト/,
);
await pB.waitForSelector('.ch.ghost-cur', { timeout: 5000 });
ok('同じコードの読み込みで共有ゴーストとレース(sourceHash 照合 §10)');

await ctxA.close();
await ctxB.close();

await browser.close();
console.log(`\n全 ${n} 項目パス`);