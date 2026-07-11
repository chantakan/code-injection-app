/**
 * charModel.ts — テキスト → CharModel 構築(P2: SourceAnalysis 消費版)
 *
 * 責務:
 * - 改行正規化(CRLF / 単独 CR → LF)
 * - 1 文字 = 1 CharCell 化(コードポイント単位。サロゲートペアも 1 セル)
 * - 自動スキップ判定(§3): 行頭インデント / コメント(行内・ブロック対応)/ 文中タブ
 * - ペアリング(§3): 括弧 = スタック方式(文字列ノード内を除外)、
 *   クォート = StringSpan の開き/閉じデリミタ(開閉同一文字でも判定できる)
 *
 * P1 からの変更:
 * - コメント判定は正規表現(isCommentLine)から SourceAnalysis.comments へ置換。
 *   analysis 未指定なら simpleAnalyze にフォールバック(= P1 と同じ行頭判定)
 * - CharCell.pair を確定する(input.ts の閉じ判定は文字でなくこれを見る)
 *
 * DOM には一切依存しない。描画用の span 生成は hud.ts 側で cells と同順に行う。
 */

import type { CharCell, CharModel, LanguageId, SkipReason, SourceAnalysis } from './types';
import { simpleAnalyze } from './analyzer';

// ---------------------------------------------------------------- 括弧定義(§3)

/** type-over 対象の括弧。OPENERS[i] の相方が CLOSERS[i]。クォートは StringSpan 由来 */
export const OPENERS = '([{';
export const CLOSERS = ')]}';

export function isOpener(ch: string): boolean {
  return ch.length === 1 && OPENERS.includes(ch);
}

export function isCloser(ch: string): boolean {
  return ch.length === 1 && CLOSERS.includes(ch);
}

// ---------------------------------------------------------------- 正規化

/** 改行を LF に正規化(CRLF / 単独 CR の両対応)。モックv2 の CRLF バグ対策 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 直接打鍵できる文字か(確定事項 #9)。印字可能 ASCII(U+0020–U+007E)のみ true。
 * 改行・タブは呼び出し側で先に分岐している前提。
 * これ以外(CJK・全角記号・制御文字・絵文字等)は IME や特殊入力が必要で、
 * keydown の 1 文字判定に乗らず詰まる方式(§3)がソフトロックするため自動スキップする
 */
export function isTypeableChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp <= 0x7e;
}

// ---------------------------------------------------------------- 本体

/**
 * テキストから CharModel を構築する。
 * @param rawText  読み込んだ生テキスト(改行形式は問わない)
 * @param language 言語(analyzer.detectLanguage の結果)
 * @param analysis analyzer.analyze の結果。**LF 正規化済みの同一テキスト**に対する
 *                 ものであること(スパンは cells インデックス前提)。
 *                 未指定なら simpleAnalyze(P1 互換の行頭コメント判定のみ)
 */
export function buildCharModel(
  rawText: string,
  language: LanguageId = 'plain',
  analysis?: SourceAnalysis,
): CharModel {
  const source = normalizeNewlines(rawText);
  const a = analysis ?? simpleAnalyze(source, language);
  const chars = [...source]; // コードポイント単位(cells と 1:1)
  const n = chars.length;

  // ---- フラグ表(添字 = cells インデックス)
  const inComment = new Uint8Array(n);
  for (const c of a.comments) {
    for (let i = Math.max(0, c.start); i < Math.min(c.end, n); i++) inComment[i] = 1;
    // コメント直前の行内空白は巻き込んでスキップ(→ 確定事項候補 #7)。
    // `x = 1;  // メモ` の `;` と `//` の間の空白を打たせない(詰まる方式で
    // 「Enter を押したのにミス」になる罠を避ける)
    for (let i = c.start - 1; i >= 0 && (chars[i] === ' ' || chars[i] === '\t'); i--) {
      inComment[i] = 1;
    }
  }
  const inString = new Uint8Array(n);
  for (const s of a.strings) {
    for (let i = Math.max(0, s.start); i < Math.min(s.end, n); i++) inString[i] = 1;
  }

  // ---- セル構築
  const cells: CharCell[] = [];
  let line = 0;
  let col = 0;
  let atIndent = true; // 行頭の空白帯の中か
  let lineHasTypable = false;
  let lineHasComment = false;
  let lineHasNonascii = false;

  for (let i = 0; i < n; i++) {
    const ch = chars[i] ?? '';

    if (ch === '\n') {
      // 改行のスキップ判定(→ 確定事項 #3 の一般化 + #9):
      // - ブロックコメントの内側の改行 = コメントの一部としてスキップ
      // - 打鍵対象が 1 つも無く、コメントまたは打鍵不能文字を含む行 = 行ごとスキップ
      //   (全部日本語の行で Enter だけ打たされるのを避ける。空行の Enter は打つ)
      // - コードがある行(行内コメント含む)= Enter はユーザーが打つ(§3)
      const lineAllSkipped = !lineHasTypable && (lineHasComment || lineHasNonascii);
      const skip: SkipReason | null =
        inComment[i] === 1 || (lineAllSkipped && lineHasComment)
          ? 'comment'
          : lineAllSkipped
            ? 'nonascii'
            : null;
      cells.push({ ch, line, col, skip, match: -1, pair: null });
      line++;
      col = 0;
      atIndent = true;
      lineHasTypable = false;
      lineHasComment = false;
      lineHasNonascii = false;
      continue;
    }

    const isSpace = ch === ' ' || ch === '\t';
    if (!isSpace) atIndent = false;

    let skip: SkipReason | null = null;
    if (inComment[i] === 1) {
      skip = 'comment';
      lineHasComment = true;
    } else if (atIndent && isSpace) {
      skip = 'indent';
    } else if (ch === '\t') {
      skip = 'tab'; // 文中タブ: Tab キー無視(§3)とのソフトロック回避(確定事項 #2)
    } else if (!isTypeableChar(ch)) {
      skip = 'nonascii'; // 打鍵不能文字(確定事項 #9): IME 必須の CJK・制御文字等
      lineHasNonascii = true;
    } else {
      lineHasTypable = true;
    }

    cells.push({ ch, line, col, skip, match: -1, pair: null });
    col++;
  }

  pairBrackets(cells, inString);
  pairQuotes(cells, a);

  return {
    cells,
    source,
    lineCount: line + 1,
    typableCount: cells.reduce((m, c) => (c.skip === null ? m + 1 : m), 0),
    language,
    analysis: a,
  };
}

// ---------------------------------------------------------------- ペアリング(§3)

/**
 * 括弧: スタック方式で match / pair を埋める。
 * - スキップ対象(コメント内等)と文字列ノード内(§3)は対象外
 * - 閉じ役(pair='close')はペア不成立でも付与する(P1 の isCloser 走査と同じく、
 *   type-over の run は種類不一致の閉じ括弧も貪欲に巻き込む)
 */
function pairBrackets(cells: CharCell[], inString: Uint8Array): void {
  const stack: Array<{ index: number; closer: string }> = [];

  cells.forEach((cell, i) => {
    if (cell.skip !== null || inString[i] === 1) return;

    const oi = OPENERS.indexOf(cell.ch);
    if (oi >= 0) {
      cell.pair = 'open';
      stack.push({ index: i, closer: CLOSERS.charAt(oi) });
      return;
    }

    if (isCloser(cell.ch)) {
      cell.pair = 'close';
      const top = stack[stack.length - 1];
      if (top !== undefined && top.closer === cell.ch) {
        stack.pop();
        const opener = cells[top.index];
        if (opener !== undefined) opener.match = i;
        cell.match = top.index;
      }
    }
  });
}

/**
 * クォート: StringSpan の開き/閉じデリミタに pair を付与し、先頭セル同士を match で結ぶ。
 * 開閉が同一文字のため文字マッチでは判定できない(§3)— ノード情報だけを信じる。
 * 未終端(closeStart === end)やデリミタ不明(openEnd === start)はペア化しない
 * (文字列内の括弧除外は inString 経由ですでに効いている)
 */
function pairQuotes(cells: CharCell[], analysis: SourceAnalysis): void {
  for (const s of analysis.strings) {
    if (!(s.start < s.openEnd && s.openEnd <= s.closeStart && s.closeStart < s.end)) continue;

    const open = cells[s.start];
    const close = cells[s.closeStart];
    if (open === undefined || close === undefined) continue;
    if (open.skip !== null || close.skip !== null) continue; // 安全弁(通常来ない)

    for (let i = s.start; i < s.openEnd; i++) {
      const c = cells[i];
      if (c !== undefined && c.skip === null) c.pair = 'open';
    }
    for (let i = s.closeStart; i < s.end; i++) {
      const c = cells[i];
      if (c !== undefined && c.skip === null) c.pair = 'close';
    }
    open.match = s.closeStart;
    close.match = s.start;
  }
}