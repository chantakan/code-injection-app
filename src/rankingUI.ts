/**
 * rankingUI.ts — ランキング画面の描画(§7, P7)
 *
 * DOM 操作はここに閉じる(hud.ts と同じ方針)。テーブルの値は必ず textContent で
 * 挿入する(innerHTML は使わない。投稿名はユーザー入力のため XSS 対策として重要)。
 * グローバルな `document` には依存せず、渡された要素の ownerDocument から生成する
 * (jsdom でのテスト・将来の複数 Document 対応を見込んだ hud.ts と同じ流儀)
 */

import type { LanguageId, RankingListEntry, RankingMap } from './types';

export const RANKING_LANGUAGES: readonly Exclude<LanguageId, 'plain'>[] = [
  'javascript',
  'typescript',
  'python',
  'c',
  'rust',
  'go',
  'haskell',
  'lean4',
];

const LANG_LABEL: Record<Exclude<LanguageId, 'plain'>, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  c: 'C',
  rust: 'RS',
  go: 'GO',
  haskell: 'HS',
  lean4: 'λ4',
};

/**
 * 言語タブを描画する。クリックで onSelect(lang) を呼ぶだけ
 * (データ取得・テーブル再描画は呼び出し側 main.ts の責務)
 */
export function renderRankingTabs(
  container: HTMLElement,
  active: Exclude<LanguageId, 'plain'>,
  onSelect: (lang: Exclude<LanguageId, 'plain'>) => void,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  for (const lang of RANKING_LANGUAGES) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ranking-tab' + (lang === active ? ' active' : '');
    btn.textContent = LANG_LABEL[lang];
    btn.setAttribute('aria-pressed', String(lang === active));
    btn.addEventListener('click', () => onSelect(lang));
    container.appendChild(btn);
  }
}

/** スコア順テーブルを描画する。0 件・未取得なら空メッセージを出す */
export function renderRankingTable(container: HTMLElement, entries: RankingListEntry[] | undefined): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (!entries || entries.length === 0) {
    const p = doc.createElement('p');
    p.className = 'ranking-empty';
    p.textContent = 'まだ記録がありません';
    container.appendChild(p);
    return;
  }
  const table = doc.createElement('table');
  table.className = 'ranking-table';

  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const label of ['#', 'NAME', 'SCORE', 'WPM', 'ACC', '難易度']) {
    const th = doc.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  entries.forEach((e, i) => {
    const tr = doc.createElement('tr');
    const cells = [
      String(i + 1),
      e.name,
      e.score.toFixed(2),
      e.wpm.toFixed(1),
      `${e.accuracy.toFixed(1)}%`,
      e.difficulty.toFixed(2),
    ];
    for (const text of cells) {
      const td = doc.createElement('td');
      td.textContent = text; // XSS 対策: 常に textContent(innerHTML は使わない)
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

/** RankingMap から指定言語ぶんの entries を安全に取り出す(未取得/欠損時は undefined) */
export function entriesFor(
  map: RankingMap | null,
  lang: Exclude<LanguageId, 'plain'>,
): RankingListEntry[] | undefined {
  return map?.[lang];
}
