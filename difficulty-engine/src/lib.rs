//! CODE://INJECT — 難易度エンジン(P3、handoff.md §5/§6/§12)
//!
//! 絶対条件(§6): 決定的・再現可能。
//! - f64 固定・文書順の逐次和のみ(並列化・SIMD なし。wasm の f64 は IEEE 754
//!   準拠で環境非依存 → 同じ入力なら全ブラウザ・Node で bit 単位に同じ結果)
//! - 乱数・時刻・ロケール・HashMap の反復順など、環境依存の要素を一切使わない
//!   (識別子の集合は BTreeSet)
//! - 式・係数・コスト表・長さ係数カーブのいずれかを変えたら SCORE_VERSION を
//!   必ず上げる(旧スコアと混在させない §6)。ランキング公開前のチューニング
//!   (§13)は version 1 のまま行う
//! - 出力は 1e-4 に丸める(round4)。保存・照合(P7 のスコア再計算検証)を
//!   安定させるため。丸め自体も決定的
//!
//! JS 側との契約(difficulty.ts が組み立てる):
//! - 入力はセル(= コードポイント)単位の平行配列。CharModel.cells と 1:1。
//!   - `text`    LF 正規化済み原文(CharModel.source)。`chars()` がセルと 1:1 対応
//!   - `cls`     TokenClass の u8 コード(types.ts の TOKEN_CLASS_CODE と一致必須)
//!   - `depth`   スコープ深度(ScopeNode 木での深さ。トップレベル = 0)
//!   - `typable` 1 = 打鍵対象(CharCell.skip === null)/ 0 = 自動スキップ
//! - 難易度は「全文字を打った場合」で算出しファイル固有に固定(§6)。
//!   type-over 通過などプレイ内容は入力に含めない

use serde::Serialize;
use wasm_bindgen::prelude::*;

mod cost;
use cost::{finger, key_cost, resets_chain, unshift};

/// 式バージョン(§6)。式・係数・コスト表・長さ係数のどれを変えても必ず上げる
pub const SCORE_VERSION: u32 = 1;

// ---------------------------- 係数(§6 の初期値を §13 の実測チューニングで更新済み)
//
// チューニング根拠(2026-07-09、P3 完了メモ参照): 調整目標「Python 入門 ≒ 1.0 /
// 正規表現まみれ ≒ 1.5」に対し、実測サンプル(beginner.py 1.0054 / validators.js
// 1.4984)で達成。あわせて次の 2 点を実測に基づき変更:
// - 記号密度: トークン種別ベース → 「文字が ASCII 記号か」ベース
//   (正規表現・文字列内の記号がトークン種別では拾えず、記号まみれコードの
//    密度が過小評価されていたため)
// - 識別子反復率: 0.5 でクリップ(長文ほど反復率が構造的に上がり、
//    難易度を不当に下げる長さバイアスの緩和)

/// 記号密度の重み: 1 + 1.5×記号密度
const W_SYMBOL: f64 = 1.5;
/// 正規化ネスト深度の重み: + 0.2×正規化ネスト深度
const W_NEST: f64 = 0.2;
/// 識別子反復率の重み: − 0.2×min(識別子反復率, 0.5)
const W_IDENT: f64 = 0.2;
/// 識別子反復率のクリップ上限(長文バイアス緩和)
const IDENT_REP_CAP: f64 = 0.5;
/// 正規化定数: 「Python 入門コード = 1.0」のアンカー(§6 調整目標)
const NORM: f64 = 1.42;
/// 同指連続打鍵ペアの倍率(後続キー側に掛ける)
const SAME_FINGER: f64 = 1.2;
/// ネスト深度のクリップ上限(確認事項 #5: min(depth,8)/8 で 0–1 に正規化)
const NEST_CAP: u16 = 8;
/// 長さ係数が 1.0 に達する typableCount(§6: 約 2000 文字まで逓減)
const LENGTH_FULL: f64 = 2000.0;

/// types.ts の TOKEN_CLASS_CODE と一致させること(変更時は両側を同時に更新)
mod token_class {
    pub const KEYWORD: u8 = 0;
    pub const IDENTIFIER: u8 = 1;
    pub const FUNCTION: u8 = 2;
    pub const TYPE: u8 = 3;
    pub const STRING: u8 = 4;
    pub const NUMBER: u8 = 5;
    pub const COMMENT: u8 = 6;
    pub const OPERATOR: u8 = 7;
    pub const PUNCTUATION: u8 = 8;
    pub const PLAIN: u8 = 9;
}
// 式で直接使うのは IDENTIFIER/FUNCTION/TYPE(識別子反復率)のみ。
// 残りは契約(types.ts との写像)として列挙しておく
#[allow(dead_code)]
const _CONTRACT: [u8; 7] = [
    token_class::KEYWORD,
    token_class::STRING,
    token_class::NUMBER,
    token_class::COMMENT,
    token_class::OPERATOR,
    token_class::PUNCTUATION,
    token_class::PLAIN,
];

/// 難易度の内訳(types.ts の DifficultyBreakdown と一致)。
/// value / scoreVersion が DifficultyScore 相当、残りは §13 の係数チューニング用因子
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DifficultyBreakdown {
    pub value: f64,
    pub score_version: u32,
    /// 平均打鍵コスト(基本 1.0 / 数字段 1.3 / Shift 1.6 / 遠い記号 1.8 / 同指連続 ×1.2)
    pub avg_keystroke_cost: f64,
    /// 記号密度 0–1(打鍵対象セルのうち ASCII 記号の比率。文字ベース §13)
    pub symbol_density: f64,
    /// 正規化ネスト深度 0–1
    pub nest_depth_norm: f64,
    /// 識別子反復率 0–1(1 − ユニーク識別子数 ÷ 出現総数)。
    /// breakdown は生値。式には min(生値, 0.5) を使う(§13 クリップ)
    pub ident_repetition: f64,
}

/// JS 側が保存前に scoreVersion を照合できるよう単独でも公開する
#[wasm_bindgen(js_name = scoreVersion)]
pub fn score_version() -> u32 {
    SCORE_VERSION
}

/// 難易度スコア(§6)。wasm-bindgen ラッパ。実体は compute_core(ネイティブテスト可能)
#[wasm_bindgen(js_name = computeDifficulty)]
pub fn compute_difficulty(
    text: &str,
    cls: &[u8],
    depth: &[u16],
    typable: &[u8],
) -> Result<JsValue, JsValue> {
    let breakdown = compute_core(text, cls, depth, typable).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&breakdown).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 長さ係数(§6)。wasm-bindgen ラッパ
#[wasm_bindgen(js_name = lengthFactor)]
pub fn length_factor(typable_count: u32) -> f64 {
    length_factor_core(typable_count)
}

// ------------------------------------------------------------------ 実装(pure Rust)

/// 難易度(§6 の骨格 + §13 チューニング):
///
/// ```text
/// 難易度 = 平均打鍵コスト
///        × (1 + 1.5×記号密度 + 0.2×正規化ネスト深度 − 0.2×min(識別子反復率, 0.5))
///        ÷ 1.42
/// ```
pub fn compute_core(
    text: &str,
    cls: &[u8],
    depth: &[u16],
    typable: &[u8],
) -> Result<DifficultyBreakdown, String> {
    // 契約チェック: 平行配列はセル数(コードポイント数)と一致していること
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if cls.len() != n || depth.len() != n || typable.len() != n {
        return Err(format!(
            "difficulty: 配列長がセル数と不一致 (text={} cls={} depth={} typable={})",
            n,
            cls.len(),
            depth.len(),
            typable.len()
        ));
    }

    // ---- 打鍵対象セルを文書順に 1 パス走査(確定事項: 母数 = typable セル全部)
    let mut typable_count = 0usize;
    let mut cost_sum = 0.0_f64;
    let mut symbol_count = 0usize;
    let mut depth_sum = 0.0_f64;
    // 同指連続(確認事項 #3): 打鍵対象列の隣接ペアで判定(スキップセルは詰める)。
    // スペース/Enter で連鎖リセット
    let mut prev_finger: Option<u8> = None;
    for i in 0..n {
        if typable[i] == 0 {
            continue;
        }
        typable_count += 1;
        let ch = chars[i];
        let mut c = key_cost(ch);
        if resets_chain(ch) {
            prev_finger = None;
        } else {
            let f = finger(unshift(ch));
            if f.is_some() && f == prev_finger {
                c *= SAME_FINGER;
            }
            prev_finger = f;
        }
        cost_sum += c;
        // 記号密度は文字ベース(§13 チューニング): ASCII 記号(!-/:-@[-`{-~)。
        // トークン種別だと正規表現・文字列内の記号を拾えない
        if ch.is_ascii() && ch.is_ascii_punctuation() {
            symbol_count += 1;
        }
        depth_sum += f64::from(depth[i].min(NEST_CAP));
    }
    if typable_count == 0 {
        return Err("difficulty: 打鍵対象が 0 文字".to_string());
    }
    let tc = typable_count as f64;
    let avg_cost = cost_sum / tc;
    let symbol_density = symbol_count as f64 / tc;
    let nest_norm = depth_sum / tc / f64::from(NEST_CAP);
    let ident_rep = ident_repetition(&chars, cls);

    // 式にはクリップ後の反復率を使う。breakdown には生値を返す(チューニング情報)
    let value = avg_cost
        * (1.0 + W_SYMBOL * symbol_density + W_NEST * nest_norm
            - W_IDENT * ident_rep.min(IDENT_REP_CAP))
        / NORM;

    Ok(DifficultyBreakdown {
        value: round4(value),
        score_version: SCORE_VERSION,
        avg_keystroke_cost: round4(avg_cost),
        symbol_density: round4(symbol_density),
        nest_depth_norm: round4(nest_norm),
        ident_repetition: round4(ident_rep),
    })
}

/// 長さ係数カーブ(確認事項 #7): min(1, √(typableCount/2000))
pub fn length_factor_core(typable_count: u32) -> f64 {
    round4((f64::from(typable_count) / LENGTH_FULL).sqrt().min(1.0))
}

/// 識別子反復率(確認事項 #6): 1 −(ユニーク識別子数 ÷ 出現総数)。
/// 識別子 = cls が IDENTIFIER/FUNCTION/TYPE の連続 run(cls が変わったら区切る)。
/// 出現 0 なら 0。集合は BTreeSet(HashMap の反復順に依存しない)
fn ident_repetition(chars: &[char], cls: &[u8]) -> f64 {
    fn is_ident(c: u8) -> bool {
        matches!(
            c,
            token_class::IDENTIFIER | token_class::FUNCTION | token_class::TYPE
        )
    }
    let mut idents: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_cls = u8::MAX;
    for (i, &ch) in chars.iter().enumerate() {
        if is_ident(cls[i]) && (cur.is_empty() || cls[i] == cur_cls) {
            cur.push(ch);
            cur_cls = cls[i];
        } else {
            if !cur.is_empty() {
                idents.push(std::mem::take(&mut cur));
            }
            if is_ident(cls[i]) {
                cur.push(ch);
                cur_cls = cls[i];
            }
        }
    }
    if !cur.is_empty() {
        idents.push(cur);
    }
    let total = idents.len();
    if total == 0 {
        return 0.0;
    }
    let unique = idents.iter().collect::<std::collections::BTreeSet<_>>().len();
    1.0 - unique as f64 / total as f64
}

/// 1e-4 への丸め(決定的)。出力の保存・照合を安定させる
fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

// ------------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    const I: u8 = token_class::IDENTIFIER;
    const OP: u8 = token_class::OPERATOR;
    const NUM: u8 = token_class::NUMBER;
    const PUNC: u8 = token_class::PUNCTUATION;
    const PL: u8 = token_class::PLAIN;

    fn calc(text: &str, cls: &[u8]) -> DifficultyBreakdown {
        let n = text.chars().count();
        compute_core(text, cls, &vec![0; n], &vec![1; n]).unwrap()
    }

    #[test]
    fn cost_table_representatives() {
        assert_eq!(key_cost('a'), 1.0);
        assert_eq!(key_cost(';'), 1.0);
        assert_eq!(key_cost(' '), 1.0);
        assert_eq!(key_cost('\n'), 1.0);
        assert_eq!(key_cost('5'), 1.3);
        assert_eq!(key_cost('='), 1.3);
        assert_eq!(key_cost('['), 1.3);
        assert_eq!(key_cost('A'), 1.6);
        assert_eq!(key_cost('('), 1.6);
        assert_eq!(key_cost(':'), 1.6);
        assert_eq!(key_cost('_'), 1.6);
        assert_eq!(key_cost('`'), 1.8);
        assert_eq!(key_cost('~'), 1.8);
        assert_eq!(key_cost('\\'), 1.8);
        assert_eq!(key_cost('|'), 1.8);
        assert_eq!(key_cost('あ'), 1.8); // 表外 = 1.8【要確認】
    }

    #[test]
    fn basic_letters() {
        // 'ab\n': 全部 1.0、同指なし(a=左小指, b=左人差指)、識別子 "ab"×1 → 反復 0
        let bd = calc("ab\n", &[I, I, PL]);
        assert_eq!(bd.value, 0.7042); // 1.0 / 1.42(正規化)
        assert_eq!(bd.avg_keystroke_cost, 1.0);
        assert_eq!(bd.symbol_density, 0.0);
        assert_eq!(bd.ident_repetition, 0.0);
    }

    #[test]
    fn same_finger_pair() {
        // 'de': d,e とも左中指 → e に ×1.2 → avg=(1.0+1.2)/2=1.1
        let bd = calc("de", &[I, I]);
        assert_eq!(bd.avg_keystroke_cost, 1.1);
        // 'd e': スペースで連鎖リセット → 全部 1.0
        let bd = calc("d e", &[I, PL, I]);
        assert_eq!(bd.avg_keystroke_cost, 1.0);
        // 同一文字連続 'll' も同指 → (1.0+1.2)/2=1.1
        let bd = calc("ll", &[I, I]);
        assert_eq!(bd.avg_keystroke_cost, 1.1);
    }

    #[test]
    fn symbol_density_and_digits() {
        // 'x=1;' → コスト 1.0+1.3+1.3+1.0=4.6 avg=1.15、記号密度(文字ベース)
        // は '=' と ';' の 2/4=0.5。value = 1.15×(1+1.5×0.5)/1.42 = 1.4173
        let bd = calc("x=1;", &[I, OP, NUM, PUNC]);
        assert_eq!(bd.avg_keystroke_cost, 1.15);
        assert_eq!(bd.symbol_density, 0.5);
        assert_eq!(bd.value, 1.4173);
    }

    #[test]
    fn ident_repetition_rate() {
        // 'aa aa' → run "aa"×2、ユニーク 1 → 反復率 0.5(クリップ上限と同値)
        // コスト: a,a(同指1.2), 空白, a,a(同指1.2) = 1+1.2+1+1+1.2 = 5.4 avg=1.08
        // value = 1.08×(1−0.2×0.5)/1.42 = 0.972/1.42 = 0.6845
        let bd = calc("aa aa", &[I, I, PL, I, I]);
        assert_eq!(bd.ident_repetition, 0.5);
        assert_eq!(bd.avg_keystroke_cost, 1.08);
        assert_eq!(bd.value, 0.6845);
    }

    #[test]
    fn nest_depth_clipped() {
        // depth=4 → 4/8=0.5 → value = 1.0×(1+0.2×0.5)/1.42 = 0.7746
        let bd = compute_core("ab", &[I, I], &[4, 4], &[1, 1]).unwrap();
        assert_eq!(bd.nest_depth_norm, 0.5);
        assert_eq!(bd.value, 0.7746);
        // depth=20 → クリップ 8 → 1.0 → value = 1.2/1.42 = 0.8451
        let bd = compute_core("ab", &[I, I], &[20, 20], &[1, 1]).unwrap();
        assert_eq!(bd.nest_depth_norm, 1.0);
        assert_eq!(bd.value, 0.8451);
    }

    #[test]
    fn skipped_cells_excluded_and_adjacency_collapsed() {
        // 'd' + (スキップされる 'x') + 'e':スキップを詰めて d→e は同指ペア
        let bd = compute_core("dxe", &[I, I, I], &[0, 0, 0], &[1, 0, 1]).unwrap();
        assert_eq!(bd.avg_keystroke_cost, 1.1);
    }

    #[test]
    fn far_symbols() {
        // '\`' はどちらも 1.8(\=右小指, `=左小指 → 同指なし)、記号密度 1.0
        // value = 1.8×(1+1.5)/1.42 = 4.5/1.42 = 3.169
        let bd = calc("\\`", &[OP, OP]);
        assert_eq!(bd.avg_keystroke_cost, 1.8);
        assert_eq!(bd.value, 3.169);
    }

    #[test]
    fn surrogate_pair_is_one_cell() {
        // '𝒳'(サロゲートペア)= 1 セル。表外 1.8。非 ASCII は記号密度に数えない
        let bd = calc("𝒳", &[I]);
        assert_eq!(bd.avg_keystroke_cost, 1.8);
        assert_eq!(bd.symbol_density, 0.0);
        assert_eq!(bd.value, 1.2676); // 1.8/1.42
    }

    #[test]
    fn full_pipeline_case_a() {
        // test-difficulty.mjs の手組みケースと同一(JS 側と値が一致すること)
        // 'a(b) {\n  c;\n}\n' 記号5/12、nest 17/96、識別子 a,b,c ユニーク
        let cls: [u8; 14] = [2, 8, 1, 8, 9, 8, 9, 9, 9, 1, 8, 9, 8, 9];
        let depth: [u16; 14] = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0];
        let typable: [u8; 14] = [1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1];
        let bd = compute_core("a(b) {\n  c;\n}\n", &cls, &depth, &typable).unwrap();
        assert_eq!(bd.value, 1.4032);
        assert_eq!(bd.avg_keystroke_cost, 1.2);
        assert_eq!(bd.symbol_density, 0.4167);
        assert_eq!(bd.nest_depth_norm, 0.1771);
        assert_eq!(bd.ident_repetition, 0.0);
    }

    #[test]
    fn contract_errors() {
        assert!(compute_core("ab", &[I], &[0, 0], &[1, 1]).is_err());
        assert!(compute_core("a", &[I], &[0], &[0]).is_err());
    }

    #[test]
    fn deterministic_bitwise() {
        let text = "def fib(n):\n    return fib(n-1) + fib(n-2)\n";
        let n = text.chars().count();
        let cls = vec![PL; n];
        let depth = vec![1u16; n];
        let typable = vec![1u8; n];
        let a = compute_core(text, &cls, &depth, &typable).unwrap();
        let b = compute_core(text, &cls, &depth, &typable).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.value.to_bits(), b.value.to_bits());
    }

    #[test]
    fn length_factor_curve() {
        assert_eq!(length_factor_core(0), 0.0);
        assert_eq!(length_factor_core(300), 0.3873); // 投稿下限
        assert_eq!(length_factor_core(500), 0.5);
        assert_eq!(length_factor_core(2000), 1.0);
        assert_eq!(length_factor_core(200_000), 1.0);
    }
}