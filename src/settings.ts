/**
 * settings.ts — 設定画面の永続化(P6、§7/§9)
 *
 * storage.ts(LocalStore)と同じ設計方針:
 * - Storage 注入式(Node テスト可能)。既定はブラウザの localStorage
 * - 全操作 no-throw(localStorage 無効・quota 超過でも設定操作でプレイを壊さない)
 * - 壊れた保存値・キー欠損・型不一致は既定値にフォールバック(部分的な旧形式も許容)
 */

import type { EffectLevel, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';

const SETTINGS_KEY = 'codeinject.settings.v1';

/** localStorage 互換の最小インターフェース(テスト注入用。storage.ts と共通の形） */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const EFFECT_LEVELS: readonly EffectLevel[] = ['off', 'low', 'normal'];

function isEffectLevel(v: unknown): v is EffectLevel {
  return typeof v === 'string' && (EFFECT_LEVELS as readonly string[]).includes(v);
}

/** 保存値の形状検証(壊れた値は既定値でフォールバック。全滅なら DEFAULT_SETTINGS) */
function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const o = raw as Record<string, unknown>;
  return {
    effectLevel: isEffectLevel(o['effectLevel']) ? o['effectLevel'] : DEFAULT_SETTINGS.effectLevel,
    scopeBg: typeof o['scopeBg'] === 'boolean' ? o['scopeBg'] : DEFAULT_SETTINGS.scopeBg,
    refHighlight:
      typeof o['refHighlight'] === 'boolean' ? o['refHighlight'] : DEFAULT_SETTINGS.refHighlight,
  };
}

export class SettingsStore {
  private readonly s: StorageLike | null;
  /** 直近の get() 結果をキャッシュ(毎打鍵は呼ばれないが、頻繁な参照でも JSON.parse を避ける) */
  private cache: Settings | null = null;

  /** @param storage 省略時はブラウザの localStorage(無い環境では null = 常に既定値) */
  constructor(storage?: StorageLike | null) {
    this.s =
      storage !== undefined
        ? storage
        : typeof localStorage === 'undefined'
          ? null
          : localStorage;
  }

  /** 現在の設定(壊れている/未保存なら DEFAULT_SETTINGS) */
  get(): Settings {
    if (this.cache !== null) return this.cache;
    const raw = this.getRaw();
    const settings = raw === null ? { ...DEFAULT_SETTINGS } : sanitize(this.tryParse(raw));
    this.cache = settings;
    return settings;
  }

  /** 部分更新して保存し、更新後の全体を返す(保存失敗時もメモリ上の値は反映される) */
  set(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.get(), ...patch };
    this.cache = next;
    this.setRaw(JSON.stringify(next));
    return next;
  }

  private tryParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private getRaw(): string | null {
    try {
      return this.s?.getItem(SETTINGS_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private setRaw(value: string): void {
    try {
      this.s?.setItem(SETTINGS_KEY, value);
    } catch {
      // 容量超過等。設定は保存されないがプレイは続行(§11 と同じ no-throw 方針)
    }
  }
}
