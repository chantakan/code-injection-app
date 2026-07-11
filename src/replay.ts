/**
 * replay.ts — リプレイの識別・符号化(P5、§11)
 *
 * 役割:
 * - sourceHash: 正規化済み原文の SHA-256(hex)。ゴースト照合・投稿検証(P7)の鍵
 * - encodeReplay / decodeReplay: Replay ⇔ 「圧縮(deflate-raw)+ Base64URL」文字列。
 *   URL ハッシュ(#r=…)埋め込みと localStorage 保存の両方でこの文字列を使う(§11)
 *
 * 設計:
 * - DOM 非依存。crypto.subtle / CompressionStream はブラウザと Node 18+ の両方にある
 *   (Node 単体テスト可能)
 * - 圧縮前の中間表現はイベント列を列指向に分解したコンパクト JSON(PackedReplay)。
 *   キー列は連結文字列、dt は数値配列、ミスと通過は疎な添字リスト
 *   (正解率が高いほど・通過が稀なほど縮む。数千打鍵で数 KB 想定 §11)
 * - decode は形状を全検証する。共有 URL は外部入力なので信用しない
 *   (不正なら例外 → 呼び出し側が無視する)
 */

import type { LanguageId, PlayMode, Replay, ReplayEvent } from './types';

// ---------------------------------------------------------------- sourceHash

/** LF 正規化済み原文 → SHA-256(hex 64桁)。CharModel.source を渡すこと */
export async function hashSource(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- 中間表現

const LANGS: readonly LanguageId[] = [
  'javascript', 'typescript', 'python', 'c', 'rust', 'go', 'haskell', 'lean4', 'plain',
];
const MODES: readonly PlayMode[] = ['ranking', 'practice'];

/**
 * 列指向のコンパクト表現(圧縮前)。
 * k: 全イベントのキー連結(コードポイント単位で 1 イベント 1 文字、Enter は '\n')
 * d: dt(ms 整数)列 / x: ok=false のイベント添字(昇順)/ p: [添字, 通過数] の疎リスト
 */
interface PackedReplay {
  f: 1;
  l: LanguageId;
  m: PlayMode;
  h: string;
  k: string;
  d: number[];
  x: number[];
  p: Array<[number, number]>;
}

function pack(r: Replay): PackedReplay {
  const keys: string[] = [];
  const d: number[] = [];
  const x: number[] = [];
  const p: Array<[number, number]> = [];
  r.events.forEach((ev, i) => {
    keys.push(ev.key);
    d.push(ev.dt);
    if (!ev.ok) x.push(i);
    if (ev.passed !== 0) p.push([i, ev.passed]);
  });
  return {
    f: 1,
    l: r.language,
    m: r.mode,
    h: r.sourceHash ?? '',
    k: keys.join(''),
    d,
    x,
    p,
  };
}

function unpack(o: PackedReplay): Replay {
  const keys = [...o.k]; // コードポイント単位に戻す
  const missSet = new Set(o.x);
  const passedMap = new Map(o.p);
  const events: ReplayEvent[] = keys.map((key, i) => ({
    key,
    dt: o.d[i] ?? 0,
    ok: !missSet.has(i),
    passed: passedMap.get(i) ?? 0,
  }));
  return {
    formatVersion: 1,
    language: o.l,
    mode: o.m,
    ...(o.h !== '' ? { sourceHash: o.h } : {}),
    events,
  };
}

/** 外部入力(URL ハッシュ)を信用しないための形状検証 */
function validatePacked(o: unknown): PackedReplay {
  const fail = (why: string): never => {
    throw new Error(`replay: 復号データが不正です(${why})`);
  };
  if (typeof o !== 'object' || o === null) fail('not object');
  const r = o as Record<string, unknown>;
  if (r['f'] !== 1) fail('format version');
  if (typeof r['l'] !== 'string' || !LANGS.includes(r['l'] as LanguageId)) fail('language');
  if (typeof r['m'] !== 'string' || !MODES.includes(r['m'] as PlayMode)) fail('mode');
  if (typeof r['h'] !== 'string' || !/^([0-9a-f]{64})?$/.test(r['h'])) fail('sourceHash');
  if (typeof r['k'] !== 'string') fail('keys');
  const n = [...(r['k'] as string)].length;
  const d: unknown = r['d'];
  if (!Array.isArray(d) || d.length !== n) fail('dt 列長');
  if (!(d as unknown[]).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
    fail('dt 値');
  }
  const x = r['x'];
  if (!Array.isArray(x) || !x.every((v) => Number.isInteger(v) && v >= 0 && v < n)) fail('miss 添字');
  const p = r['p'];
  if (
    !Array.isArray(p) ||
    !p.every(
      (e) =>
        Array.isArray(e) && e.length === 2 &&
        Number.isInteger(e[0]) && e[0] >= 0 && e[0] < n &&
        Number.isInteger(e[1]) && e[1] > 0,
    )
  ) {
    fail('passed リスト');
  }
  return o as PackedReplay;
}

// ---------------------------------------------------------------- 圧縮 + Base64URL

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // 引数展開の上限対策
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('replay: Base64URL 形式ではありません');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Replay → URL ハッシュ/保存用文字列(deflate-raw + Base64URL §11) */
export async function encodeReplay(r: Replay): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(pack(r)));
  return toBase64Url(await pipeBytes(json, new CompressionStream('deflate-raw')));
}

/** 保存/共有文字列 → Replay。不正な入力は例外(呼び出し側で無視する) */
export async function decodeReplay(s: string): Promise<Replay> {
  const json = await pipeBytes(fromBase64Url(s), new DecompressionStream('deflate-raw'));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(json));
  return unpack(validatePacked(parsed));
}