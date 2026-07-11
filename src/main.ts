/**
 * main.ts — エントリポイント(配線のみ)
 *
 * 役割:
 * - loader(ファイル/ペースト/サンプル)からテキストを受け取り launch() する
 * - P2: 言語判定 → Tree-sitter 解析(遅延ロード §2)→ ERROR 率チェック(§4)
 *   → CharModel 構築、の非同期フロー
 * - KeyboardEvent の正規化(Enter→'\n'、Tab は無視 §3、修飾キー付きはブラウザに委譲)
 * - engine(input.ts)→ hud / sound への結果の分配
 * - 完了・リトライ・サウンドトグルの UI 制御
 */

import './styles.css';
// Vite が web-tree-sitter ランタイム wasm を配信 URL に解決する(analyzer へ注入)
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
// 難易度エンジン wasm(P3)も同様に URL 解決して difficulty へ注入する(§5)
import difficultyWasmUrl from './wasm/difficulty/difficulty_engine_bg.wasm?url';
import type {
  CharModel,
  DifficultyBreakdown,
  KeyResult,
  Replay,
  SessionResult,
} from './types';
import { SYNTAX_CHECK } from './types';
import { buildCharModel, normalizeNewlines } from './charModel';
import { analyze, detectLanguage, initAnalyzer } from './analyzer';
import { InputEngine } from './input';
import { Hud } from './hud';
import type { ScoreInfo } from './hud';
import { Sound } from './sound';
import { tokenClassAt } from './soundModel';
import { initLoader } from './loader';
import {
  computeDifficulty,
  initDifficulty,
  lengthFactor,
  preloadDifficulty,
  rankingScore,
} from './difficulty';
import { decodeReplay, encodeReplay, hashSource } from './replay';
import { LocalStore } from './storage';
import { GhostPlayer } from './ghost';

initAnalyzer({ runtimeWasmPath: treeSitterWasmUrl });
initDifficulty({ wasmUrl: difficultyWasmUrl });

// ファイルを用意しなくても試せる組み込みサンプル(モックv2と同一)
const SAMPLE = `// フィボナッチ数列をメモ化で計算する
function fib(n, memo = {}) {
  if (n <= 1) return n;
  // キャッシュ済みなら即返す
  if (memo[n]) return memo[n];
  memo[n] = fib(n - 1, memo) + fib(n - 2, memo);
  return memo[n];
}

const result = fib(40);
console.log(\`fib(40) = \${result}\`);`;

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`main: 要素 #${id} が見つかりません`);
  return el;
}

// ------------------------------------------------------------ セッション

interface Session {
  model: CharModel;
  engine: InputEngine;
  /**
   * ファイル固有の難易度(§6: 「全文字を打った場合」で固定、プレイ内容に非依存)。
   * null = 算出不可(plain / 簡易フォールバック §2、またはエンジンロード失敗)
   */
  difficulty: DifficultyBreakdown | null;
  /** 原文の SHA-256(P5 §11)。履歴・ゴースト・共有 URL の鍵 */
  sourceHash: string;
  fileName: string | null;
  /** ゴーストレース(§10)。null = 並走相手なし */
  ghost: GhostPlayer | null;
  /** engine.start に渡した performance.now()(ゴーストの経過時間計算用) */
  startedAt: number;
}

const hud = new Hud();
const sound = new Sound();
const store = new LocalStore();
let session: Session | null = null;
/** URL ハッシュ(#r=…)から復号した共有リプレイ(§11)。同じ原文を読み込むと発動 */
let sharedReplay: Replay | null = null;
/** リザルトの COPY GHOST URL 用(finish 時に確定) */
let shareUrl: string | null = null;

/** テキスト確定 → 写経開始(loader / サンプルボタンの合流点)。async の呼び口 */
function launch(text: string, fileName: string | null): void {
  launchAsync(text, fileName).catch((e: unknown) => {
    console.error('[CODE://INJECT] launch failed:', e);
    mustGet('loadNote').textContent = '開始に失敗しました(コンソールを確認)';
  });
}

async function launchAsync(text: string, fileName: string | null): Promise<void> {
  const note = mustGet('loadNote');
  note.textContent = '解析中…'; // 初回は文法 wasm の遅延 fetch(§2)が入る

  // 難易度エンジン wasm(P3)は解析と並行して温めておく。
  // 失敗はここでは握りつぶし、computeDifficulty 側で改めて拾う
  void preloadDifficulty().catch(() => {});

  const source = normalizeNewlines(text); // analyze と CharModel は同一の正規化テキストが前提
  const detection = detectLanguage(fileName, source);
  const analysis = await analyze(source, detection.language, fileName ?? undefined);

  // §4 構文チェック(警告方式): 極端(50%超)な場合のみ拒否
  if (analysis.errorRatio > SYNTAX_CHECK.rejectErrorRatio) {
    note.textContent =
      `${detection.language} として解析できません(ERROR率 ${pct(analysis.errorRatio)})。` +
      'コードファイルか確認してください';
    return; // イントロに留まる
  }
  note.textContent = '';

  const model = buildCharModel(source, detection.language, analysis);

  // 難易度スコア(§6): プレイ前に確定しファイル固有に固定する。
  // plain / 簡易フォールバックは算出不可(§2)→ null(リザルトはスコア非表示)
  let difficulty: DifficultyBreakdown | null = null;
  try {
    difficulty = await computeDifficulty(model);
  } catch (e) {
    console.warn('[CODE://INJECT] difficulty engine unavailable:', e);
    toast('DIFFICULTY ENGINE OFFLINE — スコアなしで続行します');
  }

  // ゴースト(§10): 共有リプレイ(URL 由来)が同じ原文なら優先、無ければ自己ベスト
  const sourceHash = await hashSource(source);
  let ghost: GhostPlayer | null = null;
  let ghostLabel: string | null = null;
  if (sharedReplay !== null && sharedReplay.sourceHash === sourceHash) {
    ghost = new GhostPlayer(model, sharedReplay);
    ghostLabel = '共有ゴースト';
  } else {
    const rec = store.ghost(sourceHash);
    if (rec !== null) {
      try {
        ghost = new GhostPlayer(model, await decodeReplay(rec.encoded));
        ghostLabel = `自己ベスト(${Math.round(rec.wpm)} WPM)`;
      } catch (e) {
        console.warn('[CODE://INJECT] ghost decode failed:', e); // 壊れた保存物は無視
      }
    }
  }

  const engine = new InputEngine(model, 'ranking'); // P2 も詰まる方式のみ(§3)
  const startedAt = performance.now();
  session = { model, engine, difficulty, sourceHash, fileName, ghost, startedAt };

  hud.mount(model);
  mustGet('intro').classList.add('hidden');

  if (analysis.errorRatio > SYNTAX_CHECK.warnErrorRatio) {
    toast(`SYNTAX WARNING: ERROR率 ${pct(analysis.errorRatio)}(言語判定: ${detection.language})`);
  }
  if (ghostLabel !== null) toast(`GHOST RACE: ${ghostLabel}と並走(§10)`);

  engine.start(startedAt);
  hud.begin(engine.cursor);

  if (engine.done) {
    // 全文コメント等、開始即完了の縁ケース
    finish(session, performance.now());
    return;
  }
  hud.focus();
}

function pct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

/** §4 警告方式のトースト(表示のみ。開始は止めない)。6 秒で消える */
function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function finish(s: Session, now: number): void {
  sound.quiet(); // ドローン/アルペジオを穏やかに解放(§8)
  const result = s.engine.result(now);
  // 補正スコア = WPM × 難易度 × 長さ係数(§6)。難易度なし(§2)はスコア非表示
  let score: ScoreInfo | null = null;
  if (s.difficulty !== null) {
    // difficulty 取得済み = wasm ロード済みなので lengthFactor は同期で呼べる
    const lf = lengthFactor(s.model.typableCount);
    score = {
      difficulty: s.difficulty,
      lengthFactor: lf,
      score: rankingScore(result.wpm, s.difficulty, lf),
    };
  }
  hud.showResult(result, score);
  hud.setGhost(null);
  // 保存・共有(P5 §11)は非同期で続行(失敗してもリザルト表示は既に出ている)
  persistResult(s, result, score).catch((e: unknown) => {
    console.warn('[CODE://INJECT] persist failed:', e);
    mustGet('rGhostNote').textContent = '保存に失敗しました(localStorage 無効?)';
  });
  // ランキング投稿(P7)は score !== null かつ
  // typableCount >= LIMITS.minTypableForRanking が資格条件(§6)
}

/**
 * リザルト確定後の永続化(P5 §10/§11):
 * ローカル履歴に追記 → 自己ベストならゴースト上書き → 共有 URL を組み立て
 */
async function persistResult(
  s: Session,
  result: SessionResult,
  score: ScoreInfo | null,
): Promise<void> {
  const encoded = await encodeReplay(s.engine.replay(s.sourceHash));
  store.addHistory({
    finishedAt: result.finishedAt,
    language: result.language,
    fileName: s.fileName,
    wpm: result.wpm,
    accuracy: result.accuracy,
    score: score?.score ?? null,
    sourceHash: s.sourceHash,
    typableCount: s.model.typableCount,
  });
  const isBest = store.saveGhostIfBetter(s.sourceHash, encoded, result.wpm, result.finishedAt);
  shareUrl = `${location.origin}${location.pathname}#r=${encoded}`;
  mustGet('rGhostNote').textContent = isBest
    ? 'GHOST SAVED — 自己ベスト更新。次回このコードでゴーストレース(§10)'
    : 'ゴーストは自己ベストのまま(今回は未更新)';
}

// ------------------------------------------------------------ キー入力

document.addEventListener('keydown', (e) => {
  const s = session;
  if (s === null || !s.engine.isStarted || s.engine.done) return;
  // ブラウザショートカット(Cmd+R 等)は妨げない
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Tab は打鍵不要・フォーカス移動も抑止(§3)
  if (e.key === 'Tab') {
    e.preventDefault();
    return;
  }

  const key = e.key === 'Enter' ? '\n' : e.key;
  // 'Shift' や 'F5' など 1 文字でないキーは無視(コードポイント単位で判定)
  if (key !== '\n' && [...key].length !== 1) return;
  e.preventDefault(); // スペースでのスクロール等を抑止

  const now = performance.now();
  const res = s.engine.handleKey(key, now);
  hud.apply(res, s.engine.cursor, s.engine.hintActive);
  playFor(s.model, res);
  const st = s.engine.stats(now);
  hud.updateStats(st);
  sound.setCombo(st.combo); // ドローン積層/剥がれ(§8)。ミスで combo=0 → 全層リリース

  if (s.engine.done) finish(s, now);
});

/**
 * KeyResult → 効果音(§8)。通過はゴーストノート+着地音。
 * P4: hit の音色はトークン種別で変える(識別子=柔/記号=パーカッシブ/キーワード=太)。
 * cls は analysis.tokens から二分探索(tokenClassAt)。plain/簡易解析は tokens が
 * 空 or comment のみなので自動的に 'plain'=柔 に落ちる
 */
function playFor(model: CharModel, res: KeyResult): void {
  const tokens = model.analysis.tokens;
  const playCell = (index: number): void => {
    const cell = model.cells[index];
    if (cell === undefined) return;
    if (cell.ch === '\n') sound.play('enter', cell.col);
    else sound.play('hit', cell.col, tokenClassAt(tokens, index));
  };
  switch (res.kind) {
    case 'hit':
      playCell(res.index);
      break;
    case 'pass': {
      const first = model.cells[res.passed[0] ?? res.hitIndex];
      sound.play('ghost', first?.col ?? 0);
      playCell(res.hitIndex);
      break;
    }
    case 'miss': {
      const cell = model.cells[res.index];
      sound.play('miss', cell?.col ?? 0);
      break;
    }
    case 'ignored':
      break;
  }
}

// ------------------------------------------------------------ UI ボタン / 定期更新

initLoader({ onReady: launch });
mustGet('startBtn').addEventListener('click', () => launch(SAMPLE, 'sample.js'));
mustGet('rRetry').addEventListener('click', () => location.reload());

mustGet('sndBtn').addEventListener('click', (e) => {
  const on = sound.toggle();
  const btn = e.currentTarget as HTMLButtonElement;
  btn.dataset['on'] = String(on);
  btn.textContent = `SOUND: ${on ? 'ON' : 'OFF'}`;
  hud.focus();
});

// COPY GHOST URL(§11 リプレイ共有)。クリップボード不可の環境は URL を直接表示
mustGet('rShare').addEventListener('click', () => {
  const url = shareUrl;
  const btn = mustGet('rShare');
  if (url === null) {
    btn.textContent = 'NO URL(保存処理中/失敗)';
    return;
  }
  navigator.clipboard.writeText(url).then(
    () => {
      btn.textContent = 'COPIED!';
      setTimeout(() => (btn.textContent = 'COPY GHOST URL'), 1500);
    },
    () => {
      mustGet('rGhostNote').textContent = url; // フォールバック: 手動コピー用に表示
    },
  );
});

// 共有 URL(#r=…)で開かれた場合: 復号して保持(§11)。同じ原文の読み込みで発動(§10)
{
  const m = /^#r=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m !== null && m[1] !== undefined) {
    decodeReplay(m[1]).then(
      (r) => {
        sharedReplay = r;
        mustGet('loadNote').textContent =
          '共有ゴーストを検出 — 同じコードを読み込む/ペーストするとゴーストレースになります';
      },
      () => {
        mustGet('loadNote').textContent = '共有ゴーストを読み取れません(URL が不完全です)';
      },
    );
  }
}

// ゴーストカーソルの並走(§10)。100ms 刻みで経過時間ぶんのイベントを消化
setInterval(() => {
  const s = session;
  if (s?.ghost != null && s.engine.isStarted && !s.engine.done) {
    hud.setGhost(s.ghost.cursorAt(performance.now() - s.startedAt));
  }
}, 100);

// WPM は打鍵が止まっていても下がるので毎秒更新
setInterval(() => {
  const s = session;
  if (s !== null && s.engine.isStarted && !s.engine.done) {
    hud.updateStats(s.engine.stats(performance.now()));
  }
}, 1000);