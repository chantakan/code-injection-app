/**
 * hud.ts — 描画レイヤ(HUD / コード表示 / リザルト)
 *
 * DOM 操作はこのファイルに集約する。エンジン(input.ts)の KeyResult と
 * カーソル移動量から差分だけを描画する(全再描画しない)。
 *
 * クラス名・演出はモックv2準拠(styles.css に移植):
 * - .done 入力済みシアン / .passed type-over通過の中抜き / .pair-lit 相方点灯
 * - .cur ブロック型点滅カーソル / .hint 3連続ミス救済の黄色強調(§3)
 * - .misshit 赤グリッチ + body.shake 画面微振動
 *
 * P2 で有効化(§9):
 * - 薄字シンタックスハイライト: model.analysis.tokens を tk-* クラスとして span に付与
 *   (:where() で指定度を落としてあるので done/passed/cur 等の状態色が常に勝つ)
 * - 構造ブレッドクラム: model.analysis.scopes をカーソル位置で辿る
 *   (`LINE n/m › fib() › if`)。scopes が空(plain/簡易解析)なら LINE n/m のみ
 */

import type {
  CharModel,
  DifficultyBreakdown,
  KeyResult,
  LiveStats,
  SessionResult,
} from './types';

/**
 * リザルトに渡す補正スコア一式(§6、P3)。main.ts が組み立てる。
 * null = 難易度算出不可(plain / 簡易フォールバック §2)→ スコアは非表示、
 * WPM/ACC 等の統計のみ通常表示(ローカルリザルトは有効 §6)
 */
export interface ScoreInfo {
  difficulty: DifficultyBreakdown;
  /** 長さ係数 min(1, √(typableCount/2000))(§6) */
  lengthFactor: number;
  /** 補正スコア = rankingScore(wpm, difficulty, lengthFactor)(§6) */
  score: number;
}

/** id で必須要素を引く(無ければ即例外 = 配線ミスを早期検出) */
function mustGet<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`hud: 要素 #${id} が見つかりません(index.html を確認)`);
  return el as T;
}

export class Hud {
  private readonly doc: Document;
  private readonly codeEl: HTMLElement;
  private readonly crumbEl: HTMLElement;
  private readonly wpmEl: HTMLElement;
  private readonly accEl: HTMLElement;
  private readonly comboEl: HTMLElement;
  private readonly comboFillEl: HTMLElement;
  private readonly resultEl: HTMLElement;

  private model: CharModel | null = null;
  /** cells と同順の span 参照(モックの chars[].el 相当をこちら側で持つ) */
  private spans: HTMLSpanElement[] = [];
  private rows: HTMLElement[] = [];
  private lastCursor = 0;
  private curIndex: number | null = null;
  private ghostIndex: number | null = null;
  private lastCrumb = '';
  private readonly reducedMotion: boolean;

  constructor(doc: Document = document) {
    this.doc = doc;
    this.codeEl = mustGet(doc, 'code');
    this.crumbEl = mustGet(doc, 'crumb');
    this.wpmEl = mustGet(doc, 'wpm');
    this.accEl = mustGet(doc, 'acc');
    this.comboEl = mustGet(doc, 'combo');
    this.comboFillEl = mustGet(doc, 'comboFill');
    this.resultEl = mustGet(doc, 'result');
    this.reducedMotion =
      doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  // ------------------------------------------------------------ コード構築

  /** CharModel からコード表示 DOM を構築する */
  mount(model: CharModel): void {
    this.model = model;
    this.spans = [];
    this.rows = [];
    this.lastCursor = 0;
    this.curIndex = null;
    this.ghostIndex = null;
    this.lastCrumb = '';
    this.codeEl.textContent = '';

    const frag = this.doc.createDocumentFragment();
    let row = this.newRow();

    for (const cell of model.cells) {
      const s = this.doc.createElement('span');
      if (cell.ch === '\n') {
        s.className = 'ch newline-mark';
        s.textContent = '⏎';
      } else {
        s.className = 'ch';
        s.textContent = cell.ch;
      }
      if (cell.skip !== null) s.classList.add('skip');
      row.appendChild(s);
      this.spans.push(s);

      if (cell.ch === '\n') {
        frag.appendChild(row);
        this.rows.push(row);
        row = this.newRow();
      }
    }
    frag.appendChild(row);
    this.rows.push(row);
    this.codeEl.appendChild(frag);

    this.paintTokens(model);
  }

  /**
   * 薄字シンタックスハイライト(§9)。未入力トークンを低彩度で色分けする。
   * コメント(skip)は .skip の「通電しない暗さ」(§7)を優先し、改行マークも除外
   */
  private paintTokens(model: CharModel): void {
    for (const t of model.analysis.tokens) {
      if (t.cls === 'plain' || t.cls === 'identifier') continue; // 既定色のまま
      for (let i = t.start; i < Math.min(t.end, this.spans.length); i++) {
        const cell = model.cells[i];
        if (cell === undefined || cell.skip !== null || cell.ch === '\n') continue;
        this.spans[i]?.classList.add(`tk-${t.cls}`);
      }
    }
  }

  private newRow(): HTMLElement {
    const row = this.doc.createElement('span');
    row.className = 'row';
    return row;
  }

  focus(): void {
    this.codeEl.focus();
  }

  // ------------------------------------------------------------ 打鍵反映

  /** プレイ開始時。先頭のスキップ(コメント行等)を消化してカーソルを置く */
  begin(cursor: number): void {
    this.advanceTo(cursor, null, null);
  }

  /**
   * KeyResult を描画に反映する。
   * @param res        エンジンの判定結果
   * @param newCursor  処理後の engine.cursor
   * @param hintActive 救済ヒント(§3)を表示すべきか
   */
  apply(res: KeyResult, newCursor: number, hintActive: boolean): void {
    switch (res.kind) {
      case 'hit':
        this.advanceTo(newCursor, res.index, null);
        break;
      case 'pass':
        this.advanceTo(newCursor, res.hitIndex, new Set(res.passed));
        break;
      case 'miss':
        this.missEffect(res.index, hintActive);
        break;
      case 'ignored':
        break;
    }
  }

  /**
   * [lastCursor, newCursor) を消化して描画。
   * - hitIndex: 通常ヒットの1文字(フラッシュ演出)
   * - passed:   type-over 通過セル(中抜き表示)。それ以外は自動スキップ分(done)
   */
  private advanceTo(newCursor: number, hitIndex: number | null, passed: Set<number> | null): void {
    for (let i = this.lastCursor; i < newCursor; i++) {
      const s = this.spans[i];
      if (s === undefined) continue;
      s.classList.remove('cur', 'hint', 'pair-lit');
      s.classList.add(passed?.has(i) === true ? 'passed' : 'done');
      if (i === hitIndex) this.retrigger(s, 'flash');
    }

    // 開き役(括弧/クォート)を打った → 相方の閉じ役を点灯(省略可サイン §3)
    // P2: cell.pair 判定でクォートにも対応(開閉同一文字でも相方が分かる)
    if (hitIndex !== null && this.model !== null) {
      const cell = this.model.cells[hitIndex];
      if (cell !== undefined && cell.pair === 'open' && cell.match >= 0) {
        this.spans[cell.match]?.classList.add('pair-lit');
      }
    }

    this.lastCursor = newCursor;
    this.setCursor(newCursor);
  }

  private setCursor(index: number): void {
    if (this.curIndex !== null) this.spans[this.curIndex]?.classList.remove('cur');
    for (const r of this.rows) r.classList.remove('current');

    if (index >= this.spans.length) {
      this.curIndex = null; // 完了。リザルト表示は main.ts が行う
      return;
    }
    const s = this.spans[index];
    const cell = this.model?.cells[index];
    if (s === undefined || cell === undefined) return;

    this.curIndex = index;
    s.classList.add('cur');
    this.rows[cell.line]?.classList.add('current');
    s.scrollIntoView({ block: 'center', behavior: this.reducedMotion ? 'auto' : 'smooth' });
    this.setCrumb(index, cell.line);
  }

  /**
   * ゴーストカーソル(§10, P5): 本走カーソルと独立に並走する 2 本目のカーソル。
   * null または範囲外(完走)で非表示。スクロールは本走カーソルだけが握る
   */
  setGhost(index: number | null): void {
    const next = index !== null && index < this.spans.length ? index : null;
    if (next === this.ghostIndex) return;
    if (this.ghostIndex !== null) this.spans[this.ghostIndex]?.classList.remove('ghost-cur');
    this.ghostIndex = next;
    if (next !== null) this.spans[next]?.classList.add('ghost-cur');
  }

  private missEffect(index: number, hintActive: boolean): void {
    const s = this.spans[index];
    if (s === undefined) return;
    this.retrigger(s, 'misshit');
    if (hintActive) s.classList.add('hint'); // 3連続ミス救済(§3)
    const body = this.doc.body;
    body.classList.add('shake');
    setTimeout(() => body.classList.remove('shake'), 130);
  }

  /** CSS アニメーションを再発火させる(連打対応) */
  private retrigger(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow で animation をリセット
    el.classList.add(cls);
  }

  // ------------------------------------------------------------ HUD / リザルト

  /**
   * 構造ブレッドクラム(§9): `LINE n/m › fib() › if`。
   * scopes(開始位置順の木)を根からカーソル位置で辿る。ラベルはソース由来の
   * 文字列なので textContent で描く(innerHTML 不可)
   */
  private setCrumb(index: number, line: number): void {
    const model = this.model;
    if (model === null) return;

    const segs: string[] = [`LINE ${line + 1}/${model.lineCount}`];
    let nodes = model.analysis.scopes;
    while (true) {
      const hit = nodes.find((sc) => sc.start <= index && index < sc.end);
      if (hit === undefined) break;
      segs.push(hit.label);
      nodes = hit.children;
    }

    const key = segs.join('\n');
    if (key === this.lastCrumb) return; // 打鍵ごとの再構築を抑制(差分描画の方針)
    this.lastCrumb = key;

    this.crumbEl.textContent = '';
    segs.forEach((label, i) => {
      if (i > 0) {
        const sep = this.doc.createElement('span');
        sep.className = 'sep';
        sep.textContent = '›';
        this.crumbEl.appendChild(sep);
      }
      const seg = this.doc.createElement('span');
      seg.className = 'seg';
      seg.textContent = label;
      this.crumbEl.appendChild(seg);
    });
  }

  updateStats(stats: LiveStats): void {
    this.wpmEl.textContent = String(Math.round(stats.wpm));
    this.accEl.textContent = String(Math.round(stats.accuracy));
    this.comboEl.textContent = String(stats.combo);
    this.comboEl.classList.toggle('combo-hot', stats.combo >= 10);
    this.comboFillEl.style.width = `${Math.min(stats.combo * 2.5, 100)}%`;
  }

  showResult(r: SessionResult, score: ScoreInfo | null): void {
    const set = (id: string, v: string): void => {
      mustGet(this.doc, id).textContent = v;
    };
    const wpm = Math.round(r.wpm);
    const acc = Math.round(r.accuracy);
    // 補正スコア = WPM × 難易度 × 長さ係数(§6。P1 仮式を置換)
    if (score === null) {
      // plain / 簡易フォールバック: 難易度算出不可(§2)。統計のみ表示
      set('rScore', '---');
      set('rScoreNote', 'NO SCORE — 難易度算出不可のためランキング対象外(プレーンテキスト)');
    } else {
      set('rScore', (Math.round(score.score * 10) / 10).toFixed(1));
      set(
        'rScoreNote',
        `WPM ${r.wpm.toFixed(1)} × DIFFICULTY ${score.difficulty.value.toFixed(4)} ` +
          `× LENGTH ${score.lengthFactor.toFixed(4)} — score v${score.difficulty.scoreVersion}`,
      );
    }
    set('rWpm', String(wpm));
    set('rAcc', `${acc}%`);
    set('rMax', String(r.maxCombo));
    set('rPass', String(r.passedCount));
    set('rTime', formatTime(r.elapsedMs));
    this.resultEl.classList.remove('hidden');
  }
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}