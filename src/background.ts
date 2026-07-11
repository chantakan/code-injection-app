/**
 * background.ts — メニュー/リザルト背景アニメ(P6、§7)
 *
 * §7 確定事項:
 * - 背景アニメはメニュー/リザルトのみ(プレイ中は静のベース §7 演出原則)。
 *   呼び出し側(main.ts)が #intro / #result の表示に合わせて start()/stop() する
 * - 設定「演出強度: OFF/弱/標準」を反映する
 * - prefers-reduced-motion を尊重する(OS/ブラウザ設定が演出強度より優先)
 *
 * 設計:
 * - frameParams() は DOM 非依存の純関数(Node テスト可能)。演出強度と reduced-motion から
 *   「描画するか/速度/不透明度」を導出するだけで、canvas 描画そのものは持たない
 * - BackgroundFX が canvas 2D 描画 + requestAnimationFrame ループを持つ薄い層。
 *   「基板のノードが淡く明滅しながら微かに漂う」程度の控えめな演出(§7: 発光はイベント時
 *   のみが原則の中で、メニュー/リザルトだけ許される背景動作)
 */

import type { EffectLevel } from './types';

export interface FrameParams {
  /** false = 何も描画しない(演出強度 OFF) */
  visible: boolean;
  /** アニメーション速度係数。0 = 静止(reduced-motion 時、または弱でも静止相当) */
  speed: number;
  /** 描画全体の不透明度係数(弱 < 標準) */
  opacity: number;
}

/** 演出強度 × reduced-motion → 描画パラメータ(純関数)。reduced-motion は常に速度を殺す */
export function frameParams(level: EffectLevel, reducedMotion: boolean): FrameParams {
  if (level === 'off') return { visible: false, speed: 0, opacity: 0 };
  const speed = reducedMotion ? 0 : level === 'low' ? 0.4 : 1;
  const opacity = level === 'low' ? 0.5 : 1;
  return { visible: true, speed, opacity };
}

interface Node {
  x: number;
  y: number;
  phase: number;
}

export class BackgroundFX {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly getLevel: () => EffectLevel;
  private readonly reducedMotion: boolean;
  private nodes: Node[] = [];
  private raf: number | null = null;
  private t = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, opts: { getLevel: () => EffectLevel; reducedMotion: boolean }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getLevel = opts.getLevel;
    this.reducedMotion = opts.reducedMotion;
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  start(): void {
    if (this.raf !== null || this.ctx === null) return;
    const loop = (ts: number): void => {
      this.frame(ts);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  destroy(): void {
    this.stop();
    this.resizeObserver?.disconnect();
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.nodes = this.buildNodes(w, h);
  }

  /** 基板風の格子ノード(§7 ヒートマップと同系統の見た目に揃える) */
  private buildNodes(w: number, h: number): Node[] {
    const gap = 64;
    const cols = Math.max(2, Math.ceil(w / gap));
    const rows = Math.max(2, Math.ceil(h / gap));
    const nodes: Node[] = [];
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        nodes.push({ x: c * gap, y: r * gap, phase: (c * 13 + r * 7) % 17 });
      }
    }
    return nodes;
  }

  private frame(ts: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { visible, speed, opacity } = frameParams(this.getLevel(), this.reducedMotion);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (!visible) return;

    // speed=0(静止/reduced-motion)でも t を進めず固定位相で 1 回描くだけにする
    if (speed > 0) this.t = ts * 0.00006 * speed;

    ctx.save();
    ctx.globalAlpha = opacity;
    for (const n of this.nodes) {
      const glow = (Math.sin(this.t * Math.PI * 2 + n.phase) + 1) / 2; // 0..1
      const alpha = 0.04 + glow * 0.10;
      ctx.fillStyle = `rgba(0, 240, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
