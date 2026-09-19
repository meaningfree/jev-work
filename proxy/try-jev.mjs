/**
 * Jev の実 API をコマンドラインから 1 回だけ試すスクリプト。
 * 画面と同じ質問定義・同じ読み取りロジックを使う。
 *
 *   TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs "夫婦と子ども2人。いま2LDKで手狭..."
 *   TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs --json "..."   # 生レスポンスを出す
 */
import { buildQuestions, buildState, AXES } from '../public/assets/questions.js';
import { interpret, openQuestions, summaryText, pct } from '../public/assets/interpret.js';

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TEXT =
  '夫婦と子ども2人（4歳・1歳）。いま2LDKの賃貸で手狭になってきたので購入を検討中。' +
  '夫の職場は品川で、電車で40分くらいまでなら許容。子どもを走らせられる公園が近くにあって、' +
  '静かな住宅地がいい。車も買う予定。予算はあまり余裕がない。';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const text = args.filter((a) => a !== '--json').join(' ') || DEFAULT_TEXT;

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error('TYPESAFE_API_KEY が設定されていません。');
  process.exit(1);
}

const started = Date.now();
const res = await fetch(UPSTREAM, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'jev-latest', state: buildState(text), questions: buildQuestions() }),
});
const elapsed = Date.now() - started;
const body = await res.text();

if (!res.ok) {
  console.error(`HTTP ${res.status} (${elapsed}ms)`);
  console.error(body.slice(0, 800));
  if (res.status === 401) console.error('→ API キーを確認してください。');
  if (res.status === 402 || res.status === 403) console.error('→ クレジット残高・支払い設定を console.typesafe.ai で確認してください。');
  if (res.status === 429) console.error('→ レート制限。少し待って再実行してください。');
  process.exit(1);
}

const result = JSON.parse(body);
if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const interpreted = interpret(result);

console.log(`\n入力: ${text}\n`);
console.log(summaryText(interpreted));

console.log('\n【まだ聞けていないこと】');
const open = openQuestions(interpreted);
if (!open.length) console.log('- なし（条件はほぼ固まっている）');
for (const item of open) {
  console.log(
    item.kind === 'axis'
      ? `- ${item.label}: 「${item.first.label}」${pct(item.first.p)} と 「${item.second?.label ?? '—'}」${pct(item.second?.p)} で割れている`
      : `- ${item.label}: ${pct(item.p)}（入れるか要確認）`,
  );
}

console.log('\n【分布】');
for (const axis of AXES) {
  const read = interpreted.reads[axis.id];
  if (!read) continue;
  const dist = read.ordered.map((o) => `${o.label} ${pct(o.p)}`).join(' / ');
  console.log(`- ${axis.label}: ${dist}`);
}

console.log(
  `\nmodel=${result.model} latency=${elapsed}ms input_tokens=${result.usage?.input_tokens ?? '?'} ` +
  `cost≈$${(((result.usage?.input_tokens ?? 0) / 1e6) * 0.042).toFixed(6)}`,
);
