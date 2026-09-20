/**
 * エリア推薦（area.html）の実 API をコマンドラインから 1 回試すスクリプト。
 * 画面と同じ質問定義・同じ読み取りロジックを使う。
 *
 *   TYPESAFE_API_KEY=apikey_... node proxy/try-area.mjs "共働きの夫婦＋0歳の子ども。職場は大手町..."
 *   TYPESAFE_API_KEY=apikey_... node proxy/try-area.mjs --json "..."      # 生レスポンス
 *   node proxy/try-area.mjs --dry-run "..."                              # 投げずにリクエストだけ表示
 *
 * --dry-run はキー無しで動く。駅名以外を渡していないことの確認用。
 */
import { buildAreaRequests, mergeResults } from '../public/assets/area-questions.js';
import { interpretArea, areaSummaryText, topPrefSummary, spreadNote, pct } from '../public/assets/area-interpret.js';

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TEXT =
  '共働きの夫婦＋0歳の子ども。私の職場は大手町、妻は品川。保育園に入れたいので待機児童が少ないところがいい。' +
  '通勤はどちらも40分くらいまで。家賃は15万円くらいまで。休日に歩ける公園があると嬉しい。';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const text = args.filter((a) => !a.startsWith('--')).join(' ') || DEFAULT_TEXT;

const requests = buildAreaRequests(text);

if (flags.has('--dry-run')) {
  console.log(JSON.stringify(requests, null, 2));
  process.exit(0);
}

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error('TYPESAFE_API_KEY が設定されていません。（--dry-run ならキー無しで動きます）');
  process.exit(1);
}

async function post(body) {
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error(raw.slice(0, 800));
    if (res.status === 401) console.error('→ API キーを確認してください。');
    if (res.status === 402 || res.status === 403) console.error('→ クレジット残高・支払い設定を console.typesafe.ai で確認してください。');
    if (res.status === 422) console.error('→ 1 リクエストあたりの質問数が多すぎる可能性があります。area-questions.js の CHUNK_SIZE を下げてください。');
    if (res.status === 429) console.error('→ レート制限。少し待って再実行してください。');
    process.exit(1);
  }
  return JSON.parse(raw);
}

const started = Date.now();
// 画面と同じく並列に投げる（CHUNK_SIZE ごとに分割されている）。
const result = mergeResults(await Promise.all(requests.map(post)));
const elapsed = Date.now() - started;

if (flags.has('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const interpreted = interpretArea(result);

console.log(`\n入力: ${text}\n`);
console.log(areaSummaryText(interpreted));

console.log('\n【都県ごとの最上位】');
for (const { pref, rows } of interpreted.byPref) {
  const head = rows.slice(0, 3).map((r) => `${r.name} ${pct(r.p)}`).join(' / ');
  console.log(`- ${pref}: ${head}`);
}

console.log('\n【下位（すすめられないと判断された駅）】');
console.log(interpreted.ranked.slice(-8).map((r) => `${r.name} ${pct(r.p)}`).join(' / '));

const { max, min, median, q25, q75, answered, count } = interpreted.stats;
console.log(
  `\n分布: 最高 ${pct(max)} / 上位25% ${pct(q75)} / 中央値 ${pct(median)} / 下位25% ${pct(q25)} / 最低 ${pct(min)} ` +
  `/ 回答のあった駅 ${answered}/${count}`,
);
console.log(spreadNote(interpreted));
console.log(`上位の内訳: ${topPrefSummary(interpreted)}`);
console.log(
  `model=${result.model} requests=${requests.length} latency=${elapsed}ms ` +
  `input_tokens=${result.usage?.input_tokens ?? '?'} ` +
  `cost≈$${(((result.usage?.input_tokens ?? 0) / 1e6) * 0.042).toFixed(6)}`,
);
