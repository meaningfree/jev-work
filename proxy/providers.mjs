/**
 * Jev と汎用 LLM（OpenAI / Gemini）を、同じ入出力で呼ぶための層。
 *
 * このリポジトリの質問定義（questions.js / area-questions.js）は Jev の
 * 「型つき質問」そのものだが、それを OpenAI / Gemini の structured output に
 * 機械的に変換すれば、同じ問いを同じ state で投げて確率を突き合わせられる。
 *
 *   choice → 選択肢ごとの確率（合計 1.0）を持つオブジェクト
 *   score  → レベル番号ごとの確率（合計 1.0）を持つオブジェクト
 *   noul   → true である確率ひとつ（0〜1）
 *
 * 返す形は Jev のレスポンス（answers / usage / model）にそろえてあるので、
 * interpret.js・area-interpret.js はどのモデルの結果でもそのまま読める。
 *
 * ＊ Jev は「確率を出すために学習されたモデル」で、OpenAI / Gemini は
 *   「文章生成モデルに確率を書かせている」ので、出てくる数字の性質は違う。
 *   比較で見たいのはまさにその差なので、プロンプト側で寄せる細工はしていない
 *   （質問文・criteria は Jev に渡しているものと同一）。
 */
import { callJev } from './upstream.mjs';

/* ---------- プロバイダとモデルの一覧 ---------- */

// 選べるモデルはここに書いたものだけ。公開した /jev は誰でも叩けるので、
// リクエストで任意のモデル ID を指定できてしまうと、高いモデルを勝手に
// 使われてこちらのクレジットが減る。だから許可リストにしてある。
//
// price は 100 万トークンあたりの USD（2026/09 時点の公表価格。概算表示用）。
// モデルも値段も入れ替わりが早いので、増やす・直すときはここだけ触ればよい。
// 一覧に無いモデルを試したいときは OPENAI_MODEL / GEMINI_MODEL / JEV_MODEL で指定する
// （環境変数で指定したものは選択肢の先頭に並び、単価は不明として扱う）。
export const PROVIDERS = {
  jev: {
    label: 'Jev',
    keyVar: 'TYPESAFE_API_KEY',
    modelVar: 'JEV_MODEL',
    note: '型つき質問に確率で答える専用モデル',
    models: [
      { id: 'jev-latest', short: 'Jev', label: 'jev-latest', price: { input: 0.042, output: 0 } },
    ],
  },
  openai: {
    label: 'OpenAI',
    keyVar: 'OPENAI_API_KEY',
    modelVar: 'OPENAI_MODEL',
    note: 'structured output（json_schema・strict）で同じ質問に確率を書かせる',
    models: [
      { id: 'gpt-5.6-luna', short: 'GPT-5.6 luna', label: 'GPT-5.6 luna（軽量）', price: { input: 0.2, output: 1.2 } },
      { id: 'gpt-5.6-terra', short: 'GPT-5.6 terra', label: 'GPT-5.6 terra（中位）', price: { input: 2, output: 12 } },
      { id: 'gpt-5.6-sol', short: 'GPT-5.6 sol', label: 'GPT-5.6 sol（上位）', price: { input: 4, output: 20 } },
    ],
  },
  gemini: {
    label: 'Gemini',
    keyVar: 'GEMINI_API_KEY',
    modelVar: 'GEMINI_MODEL',
    note: 'responseSchema で同じ質問に確率を書かせる',
    models: [
      // 3.8 Flash の単価は 2026/12/31 までの導入価格（以降は倍になる）。
      { id: 'gemini-3.8-flash', short: 'Gemini 3.8 Flash', label: 'Gemini 3.8 Flash', price: { input: 0.75, output: 3.75 } },
      { id: 'gemini-3.5-flash-lite', short: 'Gemini 3.5 Lite', label: 'Gemini 3.5 Flash-Lite（軽量）', price: { input: 0.3, output: 2.5 } },
      { id: 'gemini-3.1-pro-preview', short: 'Gemini 3.1 Pro', label: 'Gemini 3.1 Pro（preview・上位）', price: { input: 2, output: 12 } },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * そのプロバイダで選べるモデルの一覧。
 * 環境変数でモデルが指定されていれば、それも（単価不明として）先頭に足す。
 */
export function modelsOf(id, env = {}) {
  const provider = PROVIDERS[id];
  const override = env[provider.modelVar];
  const listed = provider.models;
  if (!override || listed.some((m) => m.id === override)) return listed;
  return [{ id: override, short: override, label: `${override}（環境変数）`, price: null }, ...listed];
}

const defaultModelOf = (id, env) => modelsOf(id, env)[0].id;

/** 画面が「どのモデルを選ばせてよいか」を知るための一覧。キーそのものは出さない。 */
export function providerStatus(env) {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    note: PROVIDERS[id].note,
    configured: Boolean(env[PROVIDERS[id].keyVar]),
    models: modelsOf(id, env),
  }));
}

/** リクエストボディの検証。問題なければ null、あればエラー文字列を返す。 */
export function validateRequest(payload, env = {}) {
  if (!payload || typeof payload !== 'object') return 'invalid JSON';
  if (!payload.state || !payload.questions) return 'state and questions are required';

  const id = payload.provider || 'jev';
  if (!PROVIDERS[id]) return `unknown provider: ${id}（${PROVIDER_IDS.join(' / ')}）`;

  const allowed = modelsOf(id, env).map((m) => m.id);
  if (payload.model && !allowed.includes(payload.model)) {
    return `unknown model: ${payload.model}（${id} で使えるのは ${allowed.join(' / ')}）`;
  }
  return null;
}

/* ---------- 質問定義 → JSON スキーマ ---------- */

const levelKeys = (q) => q.criteria.map((_, i) => String(i));
const choiceKeys = (q) => Object.keys(q.criteria);
const keysOf = (q) => (q.type === 'choice' ? choiceKeys(q) : levelKeys(q));

/** 1 問ぶんのスキーマ。noul は数値ひとつ、それ以外は確率の入ったオブジェクト。 */
function questionSchema(q) {
  if (q.type === 'noul') return { type: 'number', description: 'true である確率（0〜1）' };
  const keys = keysOf(q);
  return {
    type: 'object',
    description: '各選択肢の確率。合計は 1.0',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'number' }])),
    required: keys,
    additionalProperties: false,
  };
}

/** questions マップ全体を 1 つのオブジェクトスキーマにする。 */
export function answersSchema(questions) {
  const properties = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, questionSchema(q)]),
  );
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Gemini の responseSchema は additionalProperties を受け付けないので落とす。 */
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    out[key] = typeof value === 'object' ? toGeminiSchema(value) : value;
  }
  if (out.type === 'object' && out.properties) out.propertyOrdering = Object.keys(out.properties);
  return out;
}

/* ---------- 質問定義 → プロンプト ---------- */

const SYSTEM = [
  'あなたは、与えられた状況について較正された確率を出すための推論エンジンです。',
  '文章での説明はせず、指定された JSON スキーマに従う数値だけを返してください。',
].join('\n');

/** Jev に渡しているのと同じ instructions / criteria を、そのまま文章に展開する。 */
export function buildPrompt(state, questions) {
  const lines = [
    '以下の状況を読み、それぞれの質問に確率で答えてください。',
    '',
    '規則:',
    '- 選択肢のある質問は、全選択肢の確率の合計をちょうど 1.0 にすること。',
    '- true/false の質問は、true である確率を 0〜1 の数値ひとつで答えること。',
    '- 判断材料が状況に書かれていない項目は、無理に高い確率を付けないこと。',
    '- あてずっぽうで 1 つに決めず、迷っている度合いをそのまま確率に反映すること。',
    '',
    '# 状況',
    JSON.stringify(state, null, 2),
    '',
    '# 質問',
  ];

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      lines.push('', `## ${id} — true である確率をひとつ`, q.instructions);
      if (q.criteria?.true) lines.push(`- true とする条件: ${q.criteria.true}`);
      if (q.criteria?.false) lines.push(`- false とする条件: ${q.criteria.false}`);
    } else if (q.type === 'choice') {
      lines.push('', `## ${id} — 選択肢ごとの確率（合計 1.0）`, q.instructions);
      for (const [label, desc] of Object.entries(q.criteria)) {
        lines.push(desc ? `- 「${label}」: ${desc}` : `- 「${label}」`);
      }
    } else {
      lines.push('', `## ${id} — レベルごとの確率（合計 1.0・キーはレベル番号）`, q.instructions);
      q.criteria.forEach((label, i) => lines.push(`- ${i}: 「${label}」`));
    }
  }
  return lines.join('\n');
}

/* ---------- レスポンス → Jev と同じ形 ---------- */

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0);
const round = (n, digits = 4) => Number(n.toFixed(digits));

/** 合計が 1.0 からずれて返ってくることがあるので、ここで正規化する。 */
function normalizeDistribution(keys, pick) {
  const raw = keys.map((k) => Math.max(Number(pick(k)) || 0, 0));
  const total = raw.reduce((a, b) => a + b, 0);
  const probabilities = {};
  keys.forEach((k, i) => (probabilities[k] = round(total > 0 ? raw[i] / total : 1 / keys.length)));
  return probabilities;
}

/** 生成モデルの JSON を、Jev の answers と同じ形に直す。 */
export function normalizeAnswers(questions, raw) {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const value = raw?.[id];

    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: round(clamp01(Number(value))) };
      continue;
    }

    const keys = keysOf(q);
    const probabilities = normalizeDistribution(keys, (k) => value?.[k]);
    const best = keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));

    if (q.type === 'choice') {
      answers[id] = { type: 'choice', choice: best, probabilities };
    } else {
      const legend = Object.fromEntries(keys.map((k, i) => [k, q.criteria[i]]));
      const score = keys.reduce((acc, k, i) => acc + probabilities[k] * i, 0);
      answers[id] = { type: 'score', score: round(score, 3), legend, probabilities };
    }
  }
  return answers;
}

/* ---------- 各プロバイダの呼び出し ---------- */

const fail = (status, error, detail) => ({
  status,
  text: JSON.stringify(detail ? { error, detail: String(detail).slice(0, 400) } : { error }),
});

const ok = (body) => ({ status: 200, text: JSON.stringify(body) });

/** JSON が前後の文字ごと返ってきても拾えるようにしておく。 */
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('JSON として読めない応答が返りました');
    return JSON.parse(text.slice(start, end + 1));
  }
}

const postOpenAI = (env, request) =>
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

async function callOpenAI(env, payload) {
  const model = payload.model || defaultModelOf('openai', env);
  const request = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(payload.state, payload.questions) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answers', strict: true, schema: answersSchema(payload.questions) },
    },
    // 比べるたびに数字が動くと差が読めないので、下げられるモデルでは下げる。
    temperature: 0,
  };

  let res = await postOpenAI(env, request);
  let text = await res.text();

  // temperature を受け付けないモデル（推論系など）があるので、断られたら外して 1 回だけやり直す。
  if (res.status === 400 && text.includes('temperature')) {
    delete request.temperature;
    res = await postOpenAI(env, request);
    text = await res.text();
  }

  if (!res.ok) return fail(res.status, `OpenAI がエラーを返しました（HTTP ${res.status}）`, text);

  const data = parseJsonLoose(text);
  const message = data.choices?.[0]?.message;
  if (message?.refusal) return fail(422, 'OpenAI が回答を拒否しました', message.refusal);
  if (!message?.content) return fail(502, 'OpenAI の応答に本文がありません', text);

  return ok({
    model: data.model || model,
    provider: 'openai',
    answers: normalizeAnswers(payload.questions, parseJsonLoose(message.content)),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? null,
      output_tokens: data.usage?.completion_tokens ?? null,
    },
  });
}

async function callGemini(env, payload) {
  const model = payload.model || defaultModelOf('gemini', env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: buildPrompt(payload.state, payload.questions) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(answersSchema(payload.questions)),
        // 思考トークンは出力として課金されるうえ遅くなるので、絞りたいときは
        // GEMINI_THINKING_BUDGET で上限を指定する（未指定ならモデルの既定のまま）。
        ...(env.GEMINI_THINKING_BUDGET
          ? { thinkingConfig: { thinkingBudget: Number(env.GEMINI_THINKING_BUDGET) } }
          : {}),
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) return fail(res.status, `Gemini がエラーを返しました（HTTP ${res.status}）`, text);

  const data = parseJsonLoose(text);
  const candidate = data.candidates?.[0];
  const body = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  if (!body) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown';
    return fail(502, `Gemini の応答が空でした（finishReason: ${reason}）`, text);
  }

  // 思考トークン（thoughtsTokenCount）も出力として課金されるので足しておく。
  const usage = data.usageMetadata || {};
  const output = usage.candidatesTokenCount == null && usage.thoughtsTokenCount == null
    ? null
    : (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

  return ok({
    model: data.modelVersion || model,
    provider: 'gemini',
    answers: normalizeAnswers(payload.questions, parseJsonLoose(body)),
    usage: { input_tokens: usage.promptTokenCount ?? null, output_tokens: output },
  });
}

async function callJevProvider(env, payload) {
  const res = await callJev(env.TYPESAFE_API_KEY, { ...payload, model: payload.model || defaultModelOf('jev', env) });
  const text = await res.text();
  if (!res.ok) return { status: res.status, text };
  // Jev はもともとこの形で返すので、どのモデルの結果かだけ足して素通しする。
  try {
    return ok({ provider: 'jev', ...parseJsonLoose(text) });
  } catch {
    return { status: res.status, text };
  }
}

const CALLERS = { jev: callJevProvider, openai: callOpenAI, gemini: callGemini };

/**
 * provider を選んで呼ぶ。返すのは { status, text } で、text は常に JSON 文字列。
 * どのプロバイダでもエラーの形（{ error, detail }）はそろえてある。
 */
export async function callProvider(env, payload) {
  const id = payload.provider || 'jev';
  const provider = PROVIDERS[id];
  if (!provider) return fail(400, `unknown provider: ${id}`);
  if (!env[provider.keyVar]) return fail(500, `${provider.keyVar} が設定されていません`);

  try {
    return await CALLERS[id](env, payload);
  } catch (error) {
    return fail(502, `${provider.label} の呼び出しに失敗しました`, error);
  }
}
