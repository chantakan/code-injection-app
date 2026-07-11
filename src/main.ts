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
  EffectLevel,
  HistoryEntry,
  KeyResult,
  LanguageId,
  RankingEntry,
  RankingMap,
  Replay,
  SessionResult,
} from './types';
import { LIMITS, SYNTAX_CHECK } from './types';
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
import { SettingsStore } from './settings';
import { BackgroundFX } from './background';
import { fetchRankings, initRanking, submitRanking } from './ranking';
import { entriesFor, renderRankingTable, renderRankingTabs } from './rankingUI';

initAnalyzer({ runtimeWasmPath: treeSitterWasmUrl });
initDifficulty({ wasmUrl: difficultyWasmUrl });
// VITE_RANKING_API_URL 未設定時は ranking.ts の既定(同一オリジン相対パス './server/rank.php')
// をそのまま使う(§11: dist/ と server/ を同じドメイン配下に置く配置が前提)
{
  const apiUrl = import.meta.env['VITE_RANKING_API_URL'];
  if (typeof apiUrl === 'string' && apiUrl.length > 0) initRanking({ endpoint: apiUrl });
}

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
const settingsStore = new SettingsStore();
let settings = settingsStore.get();
hud.setScopeBg(settings.scopeBg); // §9(既定 ON。設定画面で変更)
hud.setRefHighlight(settings.refHighlight);

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const bg = new BackgroundFX(mustGet('bgfx') as HTMLCanvasElement, {
  getLevel: () => settings.effectLevel,
  reducedMotion,
});
bg.start(); // §7: 背景アニメはメニュー/リザルトのみ。イントロは初期表示状態なので開始する

let session: Session | null = null;
/** URL ハッシュ(#r=…)から復号した共有リプレイ(§11)。同じ原文を読み込むと発動 */
let sharedReplay: Replay | null = null;
/** リザルトの COPY GHOST URL 用(finish 時に確定) */
let shareUrl: string | null = null;

// ------------------------------------------------------------ P7: ランキング(§6, §11)

/** plain はランキング対象外(§2)。RankingEntry.language の型と一致させる絞り込み */
function isRankingLanguage(lang: LanguageId): lang is Exclude<LanguageId, 'plain'> {
  return lang !== 'plain';
}

/**
 * 投稿資格を満たしたリザルトの投稿待ちペイロード(§6: score !== null && typableCount >= 300)。
 * name はフォーム送信時に付与するのでここでは含めない
 */
let pendingSubmission: Omit<RankingEntry, 'name'> | null = null;
let rankingData: RankingMap | null = null;
let rankingActiveLang: Exclude<LanguageId, 'plain'> = 'javascript';

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
  bg.stop(); // §7: プレイ中は背景アニメを止める(静のベース)

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
  // リズムグラフ(§7/§10)は replay() を同期で読めば十分(encode は persistResult 側で別途行う)
  hud.showResult(result, score, s.engine.replay().events);
  hud.setGhost(null);
  bg.start(); // §7: リザルトは背景アニメ対象
  // 保存・共有(P5 §11)は非同期で続行(失敗してもリザルト表示は既に出ている)
  persistResult(s, result, score).catch((e: unknown) => {
    console.warn('[CODE://INJECT] persist failed:', e);
    mustGet('rGhostNote').textContent = '保存に失敗しました(localStorage 無効?)';
  });

  // ランキング投稿(§6, §11, P7): score !== null かつ typableCount >= 300 が資格条件
  const submitEl = mustGet('rankingSubmit');
  const nameEl = mustGet('rName') as HTMLInputElement;
  const submitBtn = mustGet('rSubmitBtn') as HTMLButtonElement;
  const noteEl = mustGet('rSubmitNote');
  if (score !== null && s.model.typableCount >= LIMITS.minTypableForRanking && isRankingLanguage(s.model.language)) {
    pendingSubmission = {
      language: s.model.language,
      difficulty: { value: score.difficulty.value, scoreVersion: score.difficulty.scoreVersion },
      lengthFactor: score.lengthFactor,
      typableCount: s.model.typableCount,
      replay: s.engine.replay(s.sourceHash),
    };
    submitEl.classList.remove('hidden');
    nameEl.value = '';
    submitBtn.disabled = false;
    noteEl.textContent = '';
    noteEl.className = 'ranking-submit-note';
  } else {
    pendingSubmission = null;
    submitEl.classList.add('hidden');
  }
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
  renderHistory(); // §7 ホーム一覧(次にホームへ戻ったとき最新化されている)
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

// ------------------------------------------------------------ P6: ホーム履歴(§7, §11)

/** 言語アイコン(§7)と同じ短縮表記。履歴一覧の言語列に使う */
const LANG_LABEL: Record<LanguageId, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  c: 'C',
  rust: 'RS',
  go: 'GO',
  haskell: 'HS',
  lean4: 'λ4',
  plain: 'TXT',
};

function renderHistory(): void {
  const list = mustGet('historyList');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  for (const h of store.history()) {
    frag.appendChild(historyItem(h));
  }
  list.appendChild(frag);
}

function historyItem(h: HistoryEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'history-item';

  const lang = document.createElement('span');
  lang.className = 'hi-lang';
  lang.textContent = LANG_LABEL[h.language];

  const file = document.createElement('span');
  file.className = 'hi-file';
  file.textContent = h.fileName ?? '(ペースト)';

  const wpm = document.createElement('span');
  wpm.className = 'hi-wpm';
  wpm.textContent = `${Math.round(h.wpm)} WPM`;

  const score = document.createElement('span');
  score.className = 'hi-score';
  score.textContent = h.score === null ? '—' : (Math.round(h.score * 10) / 10).toFixed(1);

  const date = document.createElement('span');
  date.className = 'hi-date';
  date.textContent = new Date(h.finishedAt).toLocaleDateString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
  });

  li.append(lang, file, wpm, score, date);
  return li;
}

renderHistory(); // 起動時: 前回までの履歴を表示(§11、端末内 localStorage)

// ------------------------------------------------------------ P6: 設定画面(§7, §9)

function syncSettingsUI(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="effectLevel"]')) {
    el.checked = el.value === settings.effectLevel;
  }
  (mustGet('scopeBgToggle') as HTMLInputElement).checked = settings.scopeBg;
  (mustGet('refHighlightToggle') as HTMLInputElement).checked = settings.refHighlight;
}

mustGet('settingsBtn').addEventListener('click', () => {
  syncSettingsUI();
  mustGet('settings').classList.remove('hidden');
});
mustGet('settingsClose').addEventListener('click', () => {
  mustGet('settings').classList.add('hidden');
  hud.focus();
});

for (const el of document.querySelectorAll<HTMLInputElement>('input[name="effectLevel"]')) {
  el.addEventListener('change', (e) => {
    const value = (e.currentTarget as HTMLInputElement).value as EffectLevel;
    settings = settingsStore.set({ effectLevel: value });
  });
}
(mustGet('scopeBgToggle') as HTMLInputElement).addEventListener('change', (e) => {
  const on = (e.currentTarget as HTMLInputElement).checked;
  settings = settingsStore.set({ scopeBg: on });
  hud.setScopeBg(on);
});
(mustGet('refHighlightToggle') as HTMLInputElement).addEventListener('change', (e) => {
  const on = (e.currentTarget as HTMLInputElement).checked;
  settings = settingsStore.set({ refHighlight: on });
  hud.setRefHighlight(on);
});

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

// ------------------------------------------------------------ P7: ランキング画面(§7, §11)

function renderRankingScreen(): void {
  renderRankingTabs(mustGet('rankingTabs'), rankingActiveLang, (lang) => {
    rankingActiveLang = lang;
    renderRankingScreen();
  });
  renderRankingTable(mustGet('rankingTable'), entriesFor(rankingData, rankingActiveLang));
}

mustGet('rankingBtn').addEventListener('click', () => {
  const s = session;
  if (s !== null && isRankingLanguage(s.model.language)) rankingActiveLang = s.model.language;
  mustGet('ranking').classList.remove('hidden');
  renderRankingScreen();
  const noteEl = mustGet('rankingNote');
  noteEl.textContent = rankingData === null ? '読み込み中…' : '';
  fetchRankings().then(
    (data) => {
      rankingData = data;
      noteEl.textContent = '';
      renderRankingScreen();
    },
    (e: unknown) => {
      console.warn('[CODE://INJECT] fetchRankings failed:', e);
      noteEl.textContent = 'ランキングを取得できませんでした(通信環境を確認してください)';
    },
  );
});
mustGet('rankingClose').addEventListener('click', () => {
  mustGet('ranking').classList.add('hidden');
  hud.focus();
});

// ランキング投稿(§6, §11, P7)。wpm/accuracy/score はサーバーが replay から再計算するため送らない(§13)
mustGet('rSubmitBtn').addEventListener('click', () => {
  const pending = pendingSubmission;
  const nameEl = mustGet('rName') as HTMLInputElement;
  const submitBtn = mustGet('rSubmitBtn') as HTMLButtonElement;
  const noteEl = mustGet('rSubmitNote');
  if (pending === null) return;
  const name = nameEl.value.trim();
  if (name === '') {
    noteEl.textContent = '名前を入力してください';
    noteEl.className = 'ranking-submit-note err';
    return;
  }
  submitBtn.disabled = true;
  noteEl.textContent = '送信中…';
  noteEl.className = 'ranking-submit-note';
  submitRanking({ ...pending, name })
    .then((res) => {
      if (res.ok) {
        noteEl.textContent =
          res.rank !== null ? `RANK IN! 現在 ${res.rank} 位` : 'ランキングに投稿しました(上位圏外)';
        noteEl.className = 'ranking-submit-note ok';
        rankingData = { ...(rankingData ?? {}), [pending.language]: res.entries };
        if (rankingActiveLang === pending.language) renderRankingScreen();
        // 連投防止: 成功後は同一リザルトからの再送信を禁止(ボタンは無効のまま)
      } else {
        noteEl.textContent = res.message;
        noteEl.className = 'ranking-submit-note err';
        submitBtn.disabled = false;
      }
    })
    .catch((e: unknown) => {
      console.warn('[CODE://INJECT] submitRanking failed:', e);
      noteEl.textContent = '通信に失敗しました(オフライン?)';
      noteEl.className = 'ranking-submit-note err';
      submitBtn.disabled = false;
    });
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