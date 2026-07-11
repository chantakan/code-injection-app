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
  HeatmapData,
  KeyResult,
  LiveStats,
  ReplayEvent,
  RhythmSeries,
  ScopeNode,
  SessionResult,
  TokenSpan,
} from './types';
import { buildHeatmap } from './heatmap';
import { buildRhythmSeries } from './rhythm';

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

/**
 * id で必須要素を引く(無ければ即例外 = 配線ミスを早期検出)。
 * 既定は HTMLElement だが、ヒートマップ/リズムグラフの svg 要素取得用に
 * T を Element まで緩めてある(SVGSVGElement は HTMLElement を継承しないため)
 */
function mustGet<T extends Element = HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`hud: 要素 #${id} が見つかりません(index.html を確認)`);
  return el as unknown as T;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K): SVGElementTagNameMap[K] {
  return doc.createElementNS(SVG_NS, tag);
}

/** 参照ハイライト対象のトークン種別(§9: 識別子と同名箇所) */
function isIdentLike(cls: TokenSpan['cls']): boolean {
  return cls === 'identifier' || cls === 'function' || cls === 'type';
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
  private readonly heatmapEl: SVGSVGElement;
  private readonly rhythmEl: SVGSVGElement;

  private model: CharModel | null = null;
  /** cells と同順の span 参照(モックの chars[].el 相当をこちら側で持つ) */
  private spans: HTMLSpanElement[] = [];
  private rows: HTMLElement[] = [];
  private lastCursor = 0;
  private curIndex: number | null = null;
  private ghostIndex: number | null = null;
  private lastCrumb = '';
  private readonly reducedMotion: boolean;

  // ---- P6 設定(§9): 既定はどちらも ON。main.ts が起動時に設定値で上書きする ----
  private scopeBgEnabled = true;
  private refHighlightEnabled = true;
  /** 現在ハイライト中のスコープ範囲(差分適用の基準) */
  private curScopeRange: { start: number; end: number } | null = null;
  /** 現在参照ハイライト中の識別子名(null = ハイライトなし) */
  private curRefName: string | null = null;
  private refHlTokens: TokenSpan[] = [];
  /** 識別子名 → 同名トークンの一覧(mount 時に 1 回構築 §9) */
  private identifierSpans: Map<string, TokenSpan[]> = new Map();

  constructor(doc: Document = document) {
    this.doc = doc;
    this.codeEl = mustGet(doc, 'code');
    this.crumbEl = mustGet(doc, 'crumb');
    this.wpmEl = mustGet(doc, 'wpm');
    this.accEl = mustGet(doc, 'acc');
    this.comboEl = mustGet(doc, 'combo');
    this.comboFillEl = mustGet(doc, 'comboFill');
    this.resultEl = mustGet(doc, 'result');
    this.heatmapEl = mustGet<SVGSVGElement>(doc, 'rHeatmap');
    this.rhythmEl = mustGet<SVGSVGElement>(doc, 'rRhythm');
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
    this.curScopeRange = null;
    this.curRefName = null;
    this.refHlTokens = [];
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
    this.buildIdentifierSpans(model);
  }

  /**
   * 参照ハイライト(§9)用の索引: 識別子・関数名・型名を名前でグルーピングする。
   * mount 時に 1 回だけ構築(O(n))。打鍵ごとの検索は Map 参照のみで済む
   */
  private buildIdentifierSpans(model: CharModel): void {
    const map = new Map<string, TokenSpan[]>();
    for (const t of model.analysis.tokens) {
      if (!isIdentLike(t.cls)) continue;
      const name = this.tokenText(model, t);
      if (name === '') continue;
      const arr = map.get(name);
      if (arr === undefined) map.set(name, [t]);
      else arr.push(t);
    }
    this.identifierSpans = map;
  }

  private tokenText(model: CharModel, t: TokenSpan): string {
    let s = '';
    for (let i = t.start; i < t.end; i++) s += model.cells[i]?.ch ?? '';
    return s;
  }

  /** cells インデックス → そのトークン(二分探索。tokens は昇順・非重複が契約 §9) */
  private findToken(index: number): TokenSpan | undefined {
    const tokens = this.model?.analysis.tokens;
    if (tokens === undefined) return undefined;
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = tokens[mid];
      if (t === undefined) break;
      if (index < t.start) hi = mid - 1;
      else if (index >= t.end) lo = mid + 1;
      else return t;
    }
    return undefined;
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
      this.clearScopeBg();
      this.clearRefHighlight();
      return;
    }
    const s = this.spans[index];
    const cell = this.model?.cells[index];
    if (s === undefined || cell === undefined) return;

    this.curIndex = index;
    s.classList.add('cur');
    this.rows[cell.line]?.classList.add('current');
    s.scrollIntoView({ block: 'center', behavior: this.reducedMotion ? 'auto' : 'smooth' });

    const { segs, leaf } = this.walkScopes(index, cell.line);
    this.paintCrumb(segs);
    this.applyScopeBg(leaf); // §9 スコープ背景
    this.updateRefHighlight(index); // §9 参照ハイライト
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
   * 構造ブレッドクラム(§9)とスコープ背景(§9)は同じ木の走査を共有する:
   * scopes(開始位置順の木)を根からカーソル位置で辿り、通過したノードのラベル列と
   * 最も深い(=現在のブロックの)ノードを一緒に返す
   */
  private walkScopes(index: number, line: number): { segs: string[]; leaf: ScopeNode | undefined } {
    const model = this.model;
    const segs: string[] = [`LINE ${line + 1}/${model?.lineCount ?? 0}`];
    if (model === null) return { segs, leaf: undefined };

    let nodes = model.analysis.scopes;
    let leaf: ScopeNode | undefined;
    while (true) {
      const hit = nodes.find((sc) => sc.start <= index && index < sc.end);
      if (hit === undefined) break;
      segs.push(hit.label);
      leaf = hit;
      nodes = hit.children;
    }
    return { segs, leaf };
  }

  /** `LINE n/m › fib() › if` の描画。ラベルはソース由来の文字列なので textContent で描く(innerHTML 不可) */
  private paintCrumb(segs: string[]): void {
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

  /**
   * スコープ背景(§9、設定 ON/OFF): 現在のブロック範囲(walkScopes の leaf)の背景を微着色。
   * 範囲が前回と同じなら何もしない(打鍵ごとの再クラス付けを避ける差分描画の方針)
   */
  private applyScopeBg(leaf: ScopeNode | undefined): void {
    if (!this.scopeBgEnabled) return; // OFF 中は setScopeBg(false) 側で既にクリア済み
    const range = leaf !== undefined ? { start: leaf.start, end: leaf.end } : null;
    const cur = this.curScopeRange;
    if (
      (range === null && cur === null) ||
      (range !== null && cur !== null && range.start === cur.start && range.end === cur.end)
    ) {
      return; // 変化なし
    }
    this.clearScopeBg();
    if (range === null) return;
    this.curScopeRange = range;
    for (let i = range.start; i < range.end && i < this.spans.length; i++) {
      this.spans[i]?.classList.add('scope-bg');
    }
  }

  private clearScopeBg(): void {
    const cur = this.curScopeRange;
    if (cur === null) return;
    for (let i = cur.start; i < cur.end && i < this.spans.length; i++) {
      this.spans[i]?.classList.remove('scope-bg');
    }
    this.curScopeRange = null;
  }

  /**
   * 参照ハイライト(§9、設定 ON/OFF): 打鍵中の識別子と同名箇所を薄く発光(名前一致ベース)。
   * identifierSpans(mount 時に構築)を引くだけなので毎打鍵呼んでも軽い
   */
  private updateRefHighlight(index: number): void {
    if (!this.refHighlightEnabled) return; // OFF 中は setRefHighlight(false) 側で既にクリア済み
    const model = this.model;
    if (model === null) return;
    const token = this.findToken(index);
    const name = token !== undefined && isIdentLike(token.cls) ? this.tokenText(model, token) : null;
    if (name === this.curRefName) return; // 変化なし(null=null も含む)

    this.clearRefHighlight();
    if (name === null) return;
    this.curRefName = name;
    const spans = this.identifierSpans.get(name) ?? [];
    this.refHlTokens = spans;
    for (const t of spans) {
      for (let i = t.start; i < t.end && i < this.spans.length; i++) {
        this.spans[i]?.classList.add('ref-hl');
      }
    }
  }

  private clearRefHighlight(): void {
    for (const t of this.refHlTokens) {
      for (let i = t.start; i < t.end && i < this.spans.length; i++) {
        this.spans[i]?.classList.remove('ref-hl');
      }
    }
    this.refHlTokens = [];
    this.curRefName = null;
  }

  /** 設定画面(§9)からの反映。無効化時は即座にクリアし、有効化時は現在位置で再計算する */
  setScopeBg(enabled: boolean): void {
    if (this.scopeBgEnabled === enabled) return;
    this.scopeBgEnabled = enabled;
    if (!enabled) {
      this.clearScopeBg();
      return;
    }
    if (this.curIndex !== null && this.model !== null) {
      const cell = this.model.cells[this.curIndex];
      if (cell !== undefined) this.applyScopeBg(this.walkScopes(this.curIndex, cell.line).leaf);
    }
  }

  /** 設定画面(§9)からの反映。無効化時は即座にクリアし、有効化時は現在位置で再計算する */
  setRefHighlight(enabled: boolean): void {
    if (this.refHighlightEnabled === enabled) return;
    this.refHighlightEnabled = enabled;
    if (!enabled) {
      this.clearRefHighlight();
      return;
    }
    if (this.curIndex !== null) this.updateRefHighlight(this.curIndex);
  }

  updateStats(stats: LiveStats): void {
    this.wpmEl.textContent = String(Math.round(stats.wpm));
    this.accEl.textContent = String(Math.round(stats.accuracy));
    this.comboEl.textContent = String(stats.combo);
    this.comboEl.classList.toggle('combo-hot', stats.combo >= 10);
    this.comboFillEl.style.width = `${Math.min(stats.combo * 2.5, 100)}%`;
  }

  /**
   * @param replayEvents このセッションの Replay.events(§11)。
   *   リズムグラフ(§7/§10)の描画に使う。engine.replay().events を同期で渡せばよい
   */
  showResult(r: SessionResult, score: ScoreInfo | null, replayEvents: readonly ReplayEvent[]): void {
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

    if (this.model !== null) this.renderHeatmap(buildHeatmap(this.model, r.missIndices));
    this.renderRhythm(buildRhythmSeries(replayEvents));

    this.resultEl.classList.remove('hidden');
  }

  // ------------------------------------------------------------ P6: リザルト可視化(§7)

  /** ミス箇所ヒートマップ(§7「回路基板風」)。ノードをスネーク順につないでトレースにする */
  private renderHeatmap(data: HeatmapData): void {
    const svg = this.heatmapEl;
    svg.textContent = '';
    mustGet(this.doc, 'rHeatmapNote').textContent =
      data.totalMisses === 0 ? 'ミスなし' : `MISSES: ${data.totalMisses}`;
    if (data.nodes.length === 0) return;

    const cell = 24;
    const pad = 12;
    const w = data.cols * cell + pad * 2;
    const h = data.rows * cell + pad * 2;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const center = (n: { col: number; row: number }): [number, number] => [
      pad + n.col * cell + cell / 2,
      pad + n.row * cell + cell / 2,
    ];

    // 基板のトレース: ノードをバケット順(=スネーク配列順)につなぐジグザグ配線
    const trace = svgEl(this.doc, 'polyline');
    trace.setAttribute('class', 'rheat-trace');
    trace.setAttribute('points', data.nodes.map((n) => center(n).join(',')).join(' '));
    svg.appendChild(trace);

    for (const n of data.nodes) {
      const [cx, cy] = center(n);
      const step = n.count === 0 ? 0 : Math.min(3, 1 + Math.floor(n.intensity * 3));
      const c = svgEl(this.doc, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(2.5 + step * 1.6));
      c.setAttribute('class', `rheat-node rheat-i${step}`);
      if (n.count > 0) {
        const title = svgEl(this.doc, 'title');
        title.textContent = `${n.count} miss${n.count > 1 ? 'es' : ''}`;
        c.appendChild(title);
      }
      svg.appendChild(c);
    }
  }

  /** リズムグラフ(§7/§10): 経過時間に対する打鍵速度の折れ線+ミス位置の赤点 */
  private renderRhythm(series: RhythmSeries): void {
    const svg = this.rhythmEl;
    svg.textContent = '';
    const W = 300;
    const H = 72;
    const PAD = 6;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const baseline = svgEl(this.doc, 'line');
    baseline.setAttribute('x1', '0');
    baseline.setAttribute('x2', String(W));
    baseline.setAttribute('y1', String(H - PAD));
    baseline.setAttribute('y2', String(H - PAD));
    baseline.setAttribute('class', 'rrhythm-base');
    svg.appendChild(baseline);

    if (series.points.length > 0) {
      const xy = (p: { t: number; v: number }): [number, number] => [
        p.t * W,
        PAD + (1 - p.v) * (H - PAD * 2),
      ];
      if (series.points.length >= 2) {
        const line = svgEl(this.doc, 'polyline');
        line.setAttribute('class', 'rrhythm-line');
        line.setAttribute('points', series.points.map((p) => xy(p).join(',')).join(' '));
        svg.appendChild(line);
      }
    }

    for (const t of series.misses) {
      const c = svgEl(this.doc, 'circle');
      c.setAttribute('cx', String(t * W));
      c.setAttribute('cy', String(H - PAD));
      c.setAttribute('r', '2.2');
      c.setAttribute('class', 'rrhythm-miss');
      svg.appendChild(c);
    }
  }
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}