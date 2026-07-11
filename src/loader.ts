/**
 * loader.ts — テキスト入力の受け付け(§3 入力仕様 / §4 制限・バリデーション)
 *
 * - File API によるローカル読み込みのみ(サーバー送信なし §3)。UTF-8 として読む
 * - ペースト入力(イントロ表示中のみ)
 * - 上限チェック: 5000 行 / 20 万文字(§4)。超過時は拒否ではなく
 *   「先頭 N 行だけ写経」を提案し、承諾されたら切り出しテキストで開始する
 *
 * 構文チェック(ERROR ノード率の警告 §4)は Tree-sitter が入る P2 で追加。
 */

import type { LoadCheck } from './types';
import { LIMITS } from './types';
import { normalizeNewlines } from './charModel';

/** コードポイント数(charModel のセル数え方と一致させる) */
const cpLen = (s: string): number => [...s].length;

// ------------------------------------------------------------ 上限チェック(純関数)

export function checkLimits(rawText: string): LoadCheck {
  const text = normalizeNewlines(rawText);
  const lines = text.split('\n');
  const chars = cpLen(text);

  if (lines.length <= LIMITS.maxLines && chars <= LIMITS.maxChars) {
    return { ok: true, text };
  }

  // 行数・文字数の両上限を満たす最大の先頭 n 行を求める
  let n = 0;
  let cum = 0;
  for (let i = 0; i < lines.length && n < LIMITS.maxLines; i++) {
    const add = cpLen(lines[i] ?? '') + (i < lines.length - 1 ? 1 : 0); // 改行分を含む
    if (cum + add > LIMITS.maxChars) break;
    cum += add;
    n++;
  }

  let suggestedLines: number;
  let truncatedText: string;
  if (n === 0) {
    // 1 行目単独で文字数上限を超える極端なケース: 1 行目を上限まで切り詰める
    suggestedLines = 1;
    truncatedText = [...(lines[0] ?? '')].slice(0, LIMITS.maxChars).join('');
  } else {
    suggestedLines = n;
    truncatedText = lines.slice(0, n).join('\n');
  }

  return { ok: false, reason: 'too-large', lines: lines.length, chars, suggestedLines, truncatedText };
}

// ------------------------------------------------------------ ファイル読み込み

export async function readTextFile(file: File): Promise<string> {
  return file.text();
}

// ------------------------------------------------------------ イントロ画面の配線

export interface LoaderCallbacks {
  /**
   * テキスト確定(上限内 or「先頭N行」承諾後)。ここから写経開始。
   * fileName は言語判定(§2 拡張子)用。ペースト入力は null
   */
  onReady: (text: string, fileName: string | null) => void;
}

export function initLoader(cb: LoaderCallbacks): void {
  const intro = mustGet('intro');
  const dropzone = mustGet('dropzone');
  const filePick = mustGet('filePick') as HTMLInputElement;
  const note = mustGet('loadNote');

  const introActive = (): boolean => !intro.classList.contains('hidden');
  const showNote = (msg: string): void => {
    note.textContent = msg;
  };

  /** 上限超過の提案 UI(§4: 拒否ではなく先頭N行の切り出しを提案) */
  const propose = (check: Extract<LoadCheck, { ok: false }>, fileName: string | null): void => {
    note.textContent = '';
    const msg = document.createElement('div');
    msg.textContent =
      `上限(${LIMITS.maxLines.toLocaleString()}行 / ${LIMITS.maxChars.toLocaleString()}文字)を超えています: ` +
      `${check.lines.toLocaleString()}行 / ${check.chars.toLocaleString()}文字`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'truncBtn';
    btn.textContent = `先頭 ${check.suggestedLines.toLocaleString()} 行だけ写経する`;
    btn.addEventListener('click', () => cb.onReady(check.truncatedText, fileName));
    note.append(msg, btn);
  };

  const handleText = (raw: string, fileName: string | null): void => {
    if (raw.trim().length === 0) {
      showNote('テキストが空です');
      return;
    }
    const check = checkLimits(raw);
    if (check.ok) cb.onReady(check.text, fileName);
    else propose(check, fileName);
  };

  const handleFile = (file: File): void => {
    readTextFile(file)
      .then((text) => handleText(text, file.name))
      .catch(() => showNote('ファイルを読み込めませんでした'));
  };

  // クリック / キーボードでファイル選択ダイアログ
  dropzone.addEventListener('click', () => filePick.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      filePick.click();
    }
  });
  filePick.addEventListener('change', () => {
    const f = filePick.files?.[0];
    if (f !== undefined) handleFile(f);
    filePick.value = ''; // 同じファイルをもう一度選べるように
  });

  // ドラッグ&ドロップ(既定のファイル表示遷移を抑止して受け取る)
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (introActive()) dropzone.classList.add('drag');
  });
  document.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (!introActive()) return;
    const f = e.dataTransfer?.files[0];
    if (f !== undefined) handleFile(f);
  });

  // ペースト入力(§3)。イントロ表示中のみ有効
  document.addEventListener('paste', (e) => {
    if (!introActive()) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.length > 0) {
      e.preventDefault();
      handleText(text, null); // ペーストは拡張子なし → 内容ヒューリスティック(§2)
    }
  });
}

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`loader: 要素 #${id} が見つかりません(index.html を確認)`);
  return el;
}