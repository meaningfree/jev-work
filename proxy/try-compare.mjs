/**
 * 同じヒアリング文・同じ質問定義を Jev / OpenAI / Gemini に投げて比べる CLI。
 * 画面（compare.html）と同じ質問定義・同じ突き合わせロジックを使う。
 *
 *   TYPESAFE_API_KEY=apikey_... OPENAI_API_KEY=sk-... GEMINI_API_KEY=... \
 *     node proxy/try-compare.mjs "夫婦と子ども2人。いま2LDKで手狭..."
 *
 *   node proxy/try-compare.mjs --models jev,openai "..."   # 使うモデルを選ぶ
 *   node proxy/try-compare.mjs --json "..."                # 各モデルの生レスポンス
 *   node proxy/try-compare.mjs --prompt                    # 生成モデルに渡すプロンプトを表示（キー不要）
 *
 * キーが設定されていないモデルは自動で外れる。
 * モデル ID は OPENAI_MODEL / GEMINI_MODEL / JEV_MODEL で差し替えられる。
 */
import { buildQuestions, buildState } from '../public/assets/questions.js';
import { compareRuns, compareSummaryText, costOf, formatCost, pct } from '../public/assets/compare.js';
import { PROVIDERS, buildPrompt, callProvider, providerStatus } from './providers.mjs';

const DEFAULT_TEXT =
  '夫婦と子ども2人（4歳・1歳）。いま2LDKの賃貸で手狭になってきたので購入を検討中。' +
  '夫の職場は品川で、電車で40分くらいまでなら許容。子どもを走らせられる公園が近くにあって、' +
  '静かな住宅地がいい。車も買う予定。予算はあまり余裕がない。';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const optionValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const only = optionValue('models')?.split(',').map((s) => s.trim()).filter(Boolean);
const text = args
  .filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--models')
  .join(' ') || DEFAULT_TEXT;

const state = buildState(text);
const questions = buildQuestions();

if (flags.has('--prompt')) {
  console.log(buildPrompt(state, questions));
  process.exit(0);
}

const available = providerStatus(process.env)
  .filter((p) => p.configured)
  .filter((p) => !only || only.includes(p.id));

if (only) {
  for (const id of only) {
    if (!PROVIDERS[id]) console.error(`不明なモデル: ${id}（jev / openai / gemini）`);
    else if (!available.some((p) => p.id === id)) console.error(`${id}: ${PROVIDERS[id].keyVar} が未設定なので外しました。`);
  }
}
if (available.length < 2) {
  console.error('比較には 2 つ以上のモデルのキーが要ります。');
  console.error('  TYPESAFE_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY のうち 2 つ以上を設定してください。');
  process.exit(1);
}

async function runOne(provider) {
  const started = Date.now();
  const { status, text: body } = await callProvider(process.env, { provider: provider.id, state, questions });
  const elapsed = Date.now() - started;
  const run = { id: provider.id, label: provider.label, price: provider.price, ms: elapsed, result: null, error: null };
  if (status !== 200) {
    const parsed = JSON.parse(body);
    run.error = [parsed.error, parsed.detail].filter(Boolean).join(' / ').slice(0, 300);
  } else {
    run.result = JSON.parse(body);
  }
  return run;
}

const runs = await Promise.all(available.map(runOne));

if (flags.has('--json')) {
  console.log(JSON.stringify(Object.fromEntries(runs.map((r) => [r.id, r.error ? { error: r.error } : r.result])), null, 2));
  process.exit(0);
}

const cmp = compareRuns(runs);

console.log(`\n入力: ${text}\n`);
console.log(compareSummaryText(cmp));

if (cmp.highlights.length) {
  console.log('\n■ 食い違いが大きい順');
  const labelOf = (id) => cmp.done.find((r) => r.id === id)?.label ?? id;
  for (const h of cmp.highlights.slice(0, 8)) {
    console.log(`- ${h.label}: ${h.cells.map((c) => `${labelOf(c.runId)}=${c.text}`).join(' / ')}`);
  }
}

console.log('\n■ こだわり条件（ばらつきの大きい順・上位8件）');
for (const row of cmp.flags.slice(0, 8)) {
  const cells = row.cells.map((c) => `${cmp.done.find((r) => r.id === c.runId)?.label}=${pct(c.p)}${c.on ? '◯' : '×'}`).join(' / ');
  console.log(`- ${row.flag.label}: ${cells}`);
}

const totalCost = runs.reduce((acc, run) => acc + (run.result ? costOf(run.result.usage, run.price) ?? 0 : 0), 0);
console.log(`\n合計コスト（この 1 回）: ${formatCost(totalCost)}`);
if (runs.some((r) => r.error)) process.exitCode = 1;
