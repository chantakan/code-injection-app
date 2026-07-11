<?php
/**
 * server/rank.php — ランキング受け口(§11, §12, P7)
 *
 * GET  : 全言語ぶんのランキング一覧を返す({ok:true, updatedAt, rankings:{lang:[...]}})
 * POST : 1件投稿。リプレイ(打鍵イベント列)から WPM/正確率を再計算して申告値と
 *        照合し、改ざん耐性を持たせる(§13「リプレイからスコア再計算して一致確認、
 *        が基本線」)。difficulty 値そのもの(Tree-sitter 依存で PHP 側では再現不可。
 *        §11 の「原文をサーバーに送らない」設計とも整合)は信頼するが、
 *        妥当範囲チェックと typableCount との整合チェック(hits+通過数==typableCount)
 *        で粗い改ざんは弾く。
 *
 * データは JSON 1 ファイル(data/rankings.json)。flock で排他制御し、
 * 言語ごとに上位 TOP_N 件のみ保持する(§11)。
 *
 * 動作要件: PHP 7.4+ / mbstring 拡張。さくらのレンタルサーバーの PHP バージョンは
 * コントロールパネルで選択可能なものを利用すること。
 */

header('Content-Type: application/json; charset=utf-8');
// 同一オリジン配置(dist/ と server/ を同じドメイン配下)が前提。
// 別オリジンから叩く運用にする場合はここで Access-Control-Allow-Origin を追加する。

const SUPPORTED_LANGUAGES = [
    'javascript', 'typescript', 'python', 'c', 'rust', 'go', 'haskell', 'lean4',
];
const MIN_TYPABLE = 300;           // §6 投稿資格(LIMITS.minTypableForRanking と一致させる)
const TOP_N = 100;                 // §11「上位N件のみ保持」(暫定値。要調整 §13相当)
const SUPPORTED_SCORE_VERSION = 1; // difficulty-engine SCORE_VERSION(P3)と一致させる
const DIFFICULTY_MIN = 0.05;       // サニティ範囲(実測レンジは 0.9〜1.5 程度 §13)
const DIFFICULTY_MAX = 5.0;
const MAX_WPM = 400;                // 人間の実測上限を大きく超える値は改ざん/自動投稿とみなす(§13相当)
const NAME_MAX_LEN = 20;           // 表示名の上限(mb文字数)
const DATA_FILE = __DIR__ . '/data/rankings.json';

function fail($code, $message, $status = 400) {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function loadNgWords() {
    $words = require __DIR__ . '/ng_words.php';
    return array_map(function ($w) { return mb_strtolower((string) $w); }, $words);
}

/** name に NGワードが部分一致で含まれるか(大文字小文字を無視、全角スペース除去程度の軽い正規化) */
function containsNgWord($name) {
    $normalized = mb_strtolower(str_replace('　', '', $name));
    foreach (loadNgWords() as $w) {
        if ($w !== '' && mb_strpos($normalized, $w) !== false) {
            return true;
        }
    }
    return false;
}

function sanitizeName($raw) {
    // 改行・制御文字を除去し、前後空白を trim
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $raw);
    return trim($name === null ? '' : $name);
}

/**
 * リプレイのイベント列から WPM/正確率/経過ms/hits/misses/passed合計を再計算する(§13)。
 * クライアントの申告値(wpm/accuracy)は信用せず、ここで出した値のみを保存する。
 * 計算式は src/input.ts の stats()/result() と一致させること。
 */
function recomputeFromReplay($events) {
    $hits = 0;
    $misses = 0;
    $totalPassed = 0;
    $elapsedMs = 0;
    foreach ($events as $ev) {
        if (!is_array($ev)) fail('invalid-replay', 'リプレイの形式が不正です');
        $key = isset($ev['key']) ? $ev['key'] : null;
        $dt = isset($ev['dt']) ? $ev['dt'] : null;
        $ok = isset($ev['ok']) ? $ev['ok'] : null;
        $passed = isset($ev['passed']) ? $ev['passed'] : null;
        if (!is_string($key) || (mb_strlen($key) !== 1 && $key !== "\n")) {
            fail('invalid-replay', 'リプレイの形式が不正です(key)');
        }
        if (!is_numeric($dt) || $dt < 0) fail('invalid-replay', 'リプレイの形式が不正です(dt)');
        if (!is_bool($ok)) fail('invalid-replay', 'リプレイの形式が不正です(ok)');
        if (!is_numeric($passed) || $passed < 0) fail('invalid-replay', 'リプレイの形式が不正です(passed)');
        $elapsedMs += (float) $dt;
        if ($ok) {
            $hits++;
            $totalPassed += (int) $passed;
        } else {
            $misses++;
        }
    }
    $minutes = $elapsedMs / 60000.0;
    $wpm = $minutes > 0 ? ($hits / 5 / $minutes) : 0.0;
    $total = $hits + $misses;
    $accuracy = $total > 0 ? ($hits / $total * 100) : 100.0;
    return [
        'hits' => $hits,
        'misses' => $misses,
        'totalPassed' => $totalPassed,
        'elapsedMs' => $elapsedMs,
        'wpm' => $wpm,
        'accuracy' => $accuracy,
    ];
}

/** data/rankings.json を共有ロックで読む(なければ空配列) */
function readAll() {
    if (!file_exists(DATA_FILE)) return [];
    $fp = fopen(DATA_FILE, 'r');
    if ($fp === false) return [];
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    if ($raw === false || trim($raw) === '') return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function methodGet() {
    $all = readAll();
    $rankings = [];
    foreach (SUPPORTED_LANGUAGES as $lang) {
        $rankings[$lang] = isset($all[$lang]) ? $all[$lang] : [];
    }
    echo json_encode(['ok' => true, 'updatedAt' => (int) (microtime(true) * 1000), 'rankings' => $rankings], JSON_UNESCAPED_UNICODE);
}

function methodPost() {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw ? $raw : '', true);
    if (!is_array($body)) fail('invalid-body', 'リクエストの形式が不正です');

    $name = sanitizeName(isset($body['name']) ? (string) $body['name'] : '');
    $language = isset($body['language']) ? (string) $body['language'] : '';
    $difficulty = isset($body['difficulty']) ? $body['difficulty'] : null;
    $lengthFactor = isset($body['lengthFactor']) ? $body['lengthFactor'] : null;
    $typableCount = isset($body['typableCount']) ? $body['typableCount'] : null;
    $replay = isset($body['replay']) ? $body['replay'] : null;

    if ($name === '') fail('invalid-name', '名前を入力してください');
    if (mb_strlen($name) > NAME_MAX_LEN) fail('invalid-name', '名前は' . NAME_MAX_LEN . '文字以内にしてください');
    if (containsNgWord($name)) fail('ng-name', 'その名前は使用できません');

    if (!in_array($language, SUPPORTED_LANGUAGES, true)) fail('invalid-language', '対応言語ではありません');

    if (!is_array($difficulty) || !isset($difficulty['value']) || !isset($difficulty['scoreVersion'])) {
        fail('invalid-difficulty', '難易度スコアの形式が不正です');
    }
    $difficultyValue = (float) $difficulty['value'];
    $scoreVersion = (int) $difficulty['scoreVersion'];
    if ($scoreVersion !== SUPPORTED_SCORE_VERSION) fail('unsupported-score-version', '対応していないスコアバージョンです');
    if (!is_finite($difficultyValue) || $difficultyValue < DIFFICULTY_MIN || $difficultyValue > DIFFICULTY_MAX) {
        fail('invalid-difficulty', '難易度スコアが妥当な範囲を超えています');
    }

    if (!is_numeric($lengthFactor)) fail('invalid-length-factor', '長さ係数の形式が不正です');
    $lengthFactor = (float) $lengthFactor;
    if ($lengthFactor <= 0 || $lengthFactor > 1) fail('invalid-length-factor', '長さ係数が妥当な範囲を超えています');

    if (!is_numeric($typableCount)) fail('invalid-typable-count', 'typableCount の形式が不正です');
    $typableCount = (int) $typableCount;
    if ($typableCount < 0) fail('invalid-typable-count', 'typableCount の形式が不正です');
    if ($typableCount < MIN_TYPABLE) fail('not-eligible', '投稿資格(' . MIN_TYPABLE . '文字以上)を満たしていません');

    if (!is_array($replay)) fail('invalid-replay', 'リプレイの形式が不正です');
    if (!isset($replay['formatVersion']) || $replay['formatVersion'] !== 1) fail('invalid-replay', '対応していないリプレイ形式です');
    if (!isset($replay['mode']) || $replay['mode'] !== 'ranking') fail('invalid-replay', 'ランキング対象外のモードです(practice)');
    if (!isset($replay['language']) || $replay['language'] !== $language) fail('invalid-replay', 'リプレイと言語が一致しません');
    $sourceHash = isset($replay['sourceHash']) ? $replay['sourceHash'] : null;
    if (!is_string($sourceHash) || !preg_match('/^[0-9a-f]{64}$/', $sourceHash)) {
        fail('invalid-replay', 'リプレイの原文ハッシュが不正です');
    }
    $events = isset($replay['events']) ? $replay['events'] : null;
    if (!is_array($events) || count($events) === 0) fail('invalid-replay', 'リプレイが空です');

    $recomputed = recomputeFromReplay($events);
    // typableCount === hits + 通過数(完走していれば厳密一致するはず。§3の詰まる方式なら
    // 全セルは最終的に hit か pass で消費される)
    if ($recomputed['hits'] + $recomputed['totalPassed'] !== $typableCount) {
        fail('replay-mismatch', 'リプレイの内容が申告内容と一致しません');
    }
    if ($recomputed['wpm'] > MAX_WPM) {
        fail('replay-mismatch', 'WPM が現実的な範囲を超えています');
    }

    $score = round($recomputed['wpm'] * $difficultyValue * $lengthFactor, 2);

    $entry = [
        'name' => $name,
        'wpm' => round($recomputed['wpm'], 1),
        'accuracy' => round($recomputed['accuracy'], 1),
        'difficulty' => round($difficultyValue, 4),
        'score' => $score,
        'postedAt' => (int) (microtime(true) * 1000),
    ];

    // ここから読み取り→更新→書き込みを1つのロックで行う(競合投稿対策)
    $fp = fopen(DATA_FILE, 'c+');
    if ($fp === false) fail('server-error', 'サーバーエラーが発生しました', 500);
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        fail('server-error', 'サーバーエラーが発生しました', 500);
    }
    $raw = stream_get_contents($fp);
    $all = (is_string($raw) && trim($raw) !== '') ? json_decode($raw, true) : [];
    if (!is_array($all)) $all = [];

    $list = isset($all[$language]) && is_array($all[$language]) ? $all[$language] : [];
    $list[] = $entry;
    usort($list, function ($a, $b) { return $b['score'] <=> $a['score']; });
    $list = array_slice($list, 0, TOP_N);
    $all[$language] = array_values($list);

    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($all, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    $rank = null;
    foreach ($all[$language] as $i => $e) {
        if ($e['postedAt'] === $entry['postedAt'] && $e['name'] === $entry['name'] && $e['score'] === $entry['score']) {
            $rank = $i + 1;
            break;
        }
    }

    echo json_encode(['ok' => true, 'rank' => $rank, 'entries' => $all[$language]], JSON_UNESCAPED_UNICODE);
}

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'GET') {
    methodGet();
} elseif ($method === 'POST') {
    methodPost();
} else {
    fail('method-not-allowed', 'このメソッドは使用できません', 405);
}
