/**
 * sound.ts — Web Audio API 版サウンド(P4 フル拡張。§8)
 *
 * 実装段階は §8 の第1段階(Web Audio API)。レイテンシ/途切れが問題になったら
 * AudioWorklet+WASM へ移行する(§5。P4 時点では問題未発生のため見送り)。
 *
 * P4 で追加(§8):
 * - 音色: トークン種別で変える(識別子=柔 soft / 記号=パーカッシブ perc / キーワード=太 bold)
 * - コンボ: ドローン(持続低音)が積層(combo 閾値で root/5度/oct/oct+5度 が重なる)
 * - リズム安定でアルペジオ追加(打鍵間隔の変動係数で判定、テンポは打鍵の中央値に追従)
 * - ミス: 不協和音(短2度のうなり)+ドローン濁り(デチューン揺れ)+コンボ楽器剥がれ
 *   (combo リセット → setCombo(0) で全層リリース)
 * P1 から維持:
 * - Enter: シンバル的アクセント / type-over 通過: 極小音量ゴーストノート
 * - AudioContext はユーザー操作起点の play() 内で遅延生成(自動再生ポリシー対応)
 *
 * 判断ロジック(音程・音色写像・層数・リズム判定)は soundModel.ts(純粋・テスト済み)。
 * このファイルはそれを Web Audio ノードに写像するだけに保つ。
 */

import type { SoundKind, TokenClass } from './types';
import type { Timbre } from './soundModel';
import {
  DRONE,
  RhythmTracker,
  arpeggioSemitone,
  droneFreq,
  droneLayersForCombo,
  pitchForCol,
  timbreForClass,
} from './soundModel';

/** 出音パラメータ(§13 扱い。耳で調整する初期値) */
const LEVEL = {
  soft: 0.06,
  bold: 0.05, // ×2 オシレータ
  perc: 0.07,
  percTick: 0.035,
  ghost: 0.025,
  miss: 0.09, // ×2 オシレータ(短2度)
  enter: 0.05,
  droneLayer: 0.02,
  arp: 0.018,
} as const;

interface DroneLayer {
  osc: OscillatorNode;
  gain: GainNode;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private droneLayers: DroneLayer[] = [];
  private readonly rhythm = new RhythmTracker();
  private lastKeyAtMs: number | null = null;
  private arpTimer: ReturnType<typeof setInterval> | null = null;
  private arpNextTime = 0;
  private arpStep = 0;

  enabled = true;

  /** ON/OFF を切り替え、新しい状態を返す。OFF ではドローン/アルペジオも即時停止 */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled) this.quiet(0.1);
    return this.enabled;
  }

  /**
   * 効果音を鳴らす。
   * @param kind 音の種類
   * @param col  行内桁位置(hit/ghost の音程に使用 §8)
   * @param cls  打った文字のトークン種別(hit の音色に使用 §8)。省略時は 'plain'=柔
   */
  play(kind: SoundKind, col = 0, cls: TokenClass = 'plain'): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;

    switch (kind) {
      case 'hit':
        this.feedRhythm();
        this.playHit(ctx, t, timbreForClass(cls), pitchForCol(col));
        break;
      case 'enter':
        this.feedRhythm();
        this.playEnter(ctx, t);
        break;
      case 'ghost':
        // type-over 通過(§8: メロディ連続性維持の極小音)。打鍵ではないのでリズムに入れない
        this.tone(ctx, t, { type: 'triangle', freq: pitchForCol(col), vol: LEVEL.ghost, dur: 0.08 });
        break;
      case 'miss':
        // §8: ミス = 不協和音 + ドローン濁り。リズムも断ち切る(コンボ剥がれは setCombo(0) 経由)
        this.rhythm.reset();
        this.lastKeyAtMs = null;
        this.playMiss(ctx, t);
        this.dirtyDrone(ctx, t);
        break;
    }
    this.updateArp();
  }

  /**
   * コンボ値の反映(§8: ドローン積層)。main.ts が打鍵処理のたびに呼ぶ。
   * combo が閾値を跨ぐと層をスロー攻撃で追加、下がると(ミス=0 で全層)リリース=剥がれ
   */
  setCombo(combo: number): void {
    const ctx = this.ctx; // まだ一度も鳴らしていなければ何もしない(自動再生ポリシー)
    if (!this.enabled || ctx === null) return;
    const target = droneLayersForCombo(combo);
    while (this.droneLayers.length < target) this.addDroneLayer(ctx);
    while (this.droneLayers.length > target) this.removeDroneLayer(ctx, 0.3);
    this.updateArp();
  }

  /** プレイ終了(リザルト表示)時。ドローンを穏やかに解放しアルペジオを止める */
  quiet(releaseSec = 1.2): void {
    const ctx = this.ctx;
    if (ctx !== null) {
      while (this.droneLayers.length > 0) this.removeDroneLayer(ctx, releaseSec);
    }
    this.stopArp();
    this.rhythm.reset();
    this.lastKeyAtMs = null;
  }

  // ------------------------------------------------------------ セットアップ

  private ensure(): AudioContext {
    if (this.ctx === null) {
      this.ctx = new AudioContext();
      // 打鍵音+ドローン+アルペジオが重なってもクリップしないよう軽くまとめる
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp).connect(this.ctx.destination);
      // ドローンは専用バス(ローパスで奥に置く)
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 340;
      this.droneBus = this.ctx.createGain();
      this.droneBus.connect(lp).connect(this.master);
    }
    return this.ctx;
  }

  private out(): GainNode {
    // ensure() 後にしか呼ばれない
    if (this.master === null) throw new Error('sound: master 未初期化');
    return this.master;
  }

  // ------------------------------------------------------------ 打鍵音(§8 音色)

  /** 単発トーンの共通ヘルパ */
  private tone(
    ctx: AudioContext,
    t: number,
    p: { type: OscillatorType; freq: number; vol: number; dur: number; detune?: number; dest?: AudioNode },
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = p.type;
    osc.frequency.value = p.freq;
    if (p.detune !== undefined) osc.detune.value = p.detune;
    gain.gain.setValueAtTime(p.vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);
    osc.connect(gain).connect(p.dest ?? this.out());
    osc.start(t);
    osc.stop(t + p.dur + 0.05);
  }

  /** トークン種別ごとの音色(§8: 識別子=柔/記号=パーカッシブ/キーワード=太) */
  private playHit(ctx: AudioContext, t: number, timbre: Timbre, freq: number): void {
    switch (timbre) {
      case 'soft':
        this.tone(ctx, t, { type: 'triangle', freq, vol: LEVEL.soft, dur: 0.12 });
        break;
      case 'bold': {
        // 2 オシレータを僅かにデチューンした矩形波をローパスに通す=太く
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        lp.connect(this.out());
        this.tone(ctx, t, { type: 'square', freq, vol: LEVEL.bold, dur: 0.18, detune: -6, dest: lp });
        this.tone(ctx, t, { type: 'square', freq, vol: LEVEL.bold, dur: 0.18, detune: 6, dest: lp });
        break;
      }
      case 'perc':
        // 極短トーン+高域ノイズのティック=パーカッシブ
        this.tone(ctx, t, { type: 'triangle', freq, vol: LEVEL.perc, dur: 0.05 });
        this.noiseBurst(ctx, t, { hp: 4000, vol: LEVEL.percTick, dur: 0.03 });
        break;
    }
  }

  /** ミス(§8: 不協和音)。短2度でぶつけた 2 本の鋸波=うなり */
  private playMiss(ctx: AudioContext, t: number): void {
    this.tone(ctx, t, { type: 'sawtooth', freq: 92, vol: LEVEL.miss, dur: 0.25 });
    this.tone(ctx, t, { type: 'sawtooth', freq: 98, vol: LEVEL.miss, dur: 0.25 });
  }

  /** Enter 用のシンバル的アクセント(ハイパスノイズ §8) */
  private playEnter(ctx: AudioContext, t: number): void {
    this.noiseBurst(ctx, t, { hp: 6000, vol: LEVEL.enter, dur: 0.25 });
  }

  private noiseBurst(
    ctx: AudioContext,
    t: number,
    p: { hp: number; vol: number; dur: number },
  ): void {
    if (this.noiseBuffer === null) {
      const len = Math.floor(ctx.sampleRate * 0.3);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = p.hp;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(p.vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);
    src.connect(hp).connect(gain).connect(this.out());
    src.start(t);
    src.stop(t + 0.3);
  }

  // ------------------------------------------------------------ ドローン(§8)

  private addDroneLayer(ctx: AudioContext): void {
    if (this.droneBus === null) return;
    const layer = this.droneLayers.length;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth'; // ローパス(droneBus)で丸まる
    osc.frequency.value = droneFreq(layer);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(LEVEL.droneLayer, t + 0.9); // スロー攻撃=積層感
    osc.connect(gain).connect(this.droneBus);
    osc.start(t);
    this.droneLayers.push({ osc, gain });
  }

  /** 末尾の層から剥がす(§8: コンボ楽器剥がれ)。releaseSec で剥がれの速さを変える */
  private removeDroneLayer(ctx: AudioContext, releaseSec: number): void {
    const layer = this.droneLayers.pop();
    if (layer === undefined) return;
    const t = ctx.currentTime;
    layer.gain.gain.cancelScheduledValues(t);
    layer.gain.gain.setValueAtTime(Math.max(layer.gain.gain.value, 0.0001), t);
    layer.gain.gain.exponentialRampToValueAtTime(0.0001, t + releaseSec);
    layer.osc.stop(t + releaseSec + 0.1);
  }

  /** ミス時のドローン濁り(§8): 全層を一瞬デチューンで揺らして戻す */
  private dirtyDrone(_ctx: AudioContext, t: number): void {
    this.droneLayers.forEach((layer, i) => {
      const d = layer.osc.detune;
      d.cancelScheduledValues(t);
      d.setValueAtTime(d.value, t);
      d.linearRampToValueAtTime(i % 2 === 0 ? 35 : -35, t + 0.06); // 層ごとに逆方向=濁る
      d.linearRampToValueAtTime(0, t + 0.4);
    });
  }

  // ------------------------------------------------------------ アルペジオ(§8)

  /** 打鍵間隔をリズムトラッカーへ供給する(hit / enter のみ。通過・ミスは含めない §3) */
  private feedRhythm(): void {
    const now = performance.now();
    if (this.lastKeyAtMs !== null) this.rhythm.push(now - this.lastKeyAtMs);
    this.lastKeyAtMs = now;
  }

  /**
   * アルペジオの起動/停止判定(§8: リズム安定で追加)。
   * 条件: 有効 && ドローンが 1 層以上 && リズム安定。テンポは打鍵中央値に追従
   */
  private updateArp(): void {
    const active =
      this.enabled && this.droneLayers.length > 0 && this.rhythm.arpIntervalMs !== null;
    if (active && this.arpTimer === null) {
      const ctx = this.ctx;
      if (ctx === null) return;
      this.arpNextTime = ctx.currentTime + 0.05;
      this.arpTimer = setInterval(() => this.arpTick(), 60);
    } else if (!active && this.arpTimer !== null) {
      this.stopArp();
    }
  }

  private stopArp(): void {
    if (this.arpTimer !== null) {
      clearInterval(this.arpTimer);
      this.arpTimer = null;
    }
  }

  /** 60ms ごとのルックアヘッドで次のアルペジオ音を予約する */
  private arpTick(): void {
    const ctx = this.ctx;
    const interval = this.rhythm.arpIntervalMs;
    if (ctx === null || interval === null || this.droneLayers.length === 0 || !this.enabled) {
      this.stopArp();
      return;
    }
    const sec = interval / 1000;
    if (this.arpNextTime < ctx.currentTime) this.arpNextTime = ctx.currentTime + 0.01;
    while (this.arpNextTime < ctx.currentTime + 0.15) {
      const freq =
        DRONE.rootFreq * 4 * Math.pow(2, arpeggioSemitone(this.arpStep) / 12);
      this.tone(ctx, this.arpNextTime, { type: 'sine', freq, vol: LEVEL.arp, dur: 0.09 });
      this.arpStep++;
      this.arpNextTime += sec;
    }
  }
}