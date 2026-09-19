import { AXES, FLAGS, buildQuestions, buildState } from './questions.js';
import { mockEvaluate } from './mock.js';

const LS_KEY = 'jev-search-generator.endpoint';
const CONF_LOW = 0.45;   // これ未満は「迷っている」扱い
const FLAG_ON = 0.5;     // これ以上のこだわり条件はチェックを入れる
const FLAG_MAYBE = 0.3;  // これ以上なら確認したい

const EXAMPLES = {
  family:
    '夫婦と子ども2人（4歳・1歳）。いま2LDKの賃貸で手狭になってきたので購入を検討中。夫の職場は品川で、電車で40分くらいまでなら許容。子どもを走らせられる公園が近くにあって、静かな住宅地がいい。車も買う予定。予算はあまり余裕がない。',
  single:
    '来月から社会人で初めての一人暮らしです。職場は渋谷。通勤時間は短くしたいけど家賃は抑えたい。自炊はあまりしないので広さより駅からの近さ重視。荷物は少なめ。',
  senior:
    '実家の母（78歳）と同居することになり、いまの家では階段がつらそうなので住み替えを考えています。私は夫婦2人＋母の3人。母の通院先が近いほうがいい。買い物が歩いて行ける範囲にあると助かります。急いではいません。',
  remote:
    '夫婦ともフルリモートで、通勤はほぼありません。都心にこだわらないので、自然が近くて広い家に住みたい。それぞれ仕事部屋が欲しいです。犬を飼っているので庭があると嬉しい。中古をリノベするのもあり。',
};

const $ = (id) => document.getElementById(id);
const el = {
  hearing: $('hearing'), run: $('run'), clear: $('clear'), status: $('status'),
  mode: $('mode-badge'), result: $('result'), summary: $('summary-chips'),
  flagChips: $('flag-chips'), askmore: $('askmore'), axes: $('axes'),
  flags: $('flags'), raw: $('raw'), copy: $('copy'), copyNote: $('copy-note'),
  endpoint: $('endpoint'), settings: $('settings-details'),
};

let lastResult = null;

/* ---------- 接続先 ---------- */

const getEndpoint = () => (localStorage.getItem(LS_KEY) || '').trim();

function refreshMode() {
  const endpoint = getEndpoint();
  el.endpoint.value = endpoint;
  if (endpoint) {
    el.mode.textContent = 'Jev API に接続（プロキシ経由）';
    el.mode.classList.remove('demo');
  } else {
    el.mode.textContent = 'デモモード（API キー未設定）';
    el.mode.classList.add('demo');
  }
}

/* ---------- 推論 ---------- */

const pct = (n) => `${Math.round(n * 100)}%`;

function errorMessage(status, body) {
  const detail = body ? `（${body.slice(0, 200)}）` : '';
  if (status === 401) return `API キーが無効か、プロキシに設定されていません${detail}`;
  if (status === 422) return `リクエストの形式が Jev に受け付けられませんでした${detail}`;
  if (status === 429) return 'レート制限に達しました。少し待って再試行してください';
  if (status === 529) return 'Jev 側が混み合っています。少し待って再試行してください';
  return `プロキシがエラーを返しました（HTTP ${status}）${detail}`;
}

async function evaluate(text) {
  const endpoint = getEndpoint();
  if (!endpoint) return mockEvaluate(text);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: buildState(text),
      questions: buildQuestions(),
    }),
  });
  if (!res.ok) throw new Error(errorMessage(res.status, await res.text().catch(() => '')));
  return res.json();
}

/* ---------- 回答の読み取り ---------- */

// choice / score のどちらでも「表示ラベル・確率・順位つき候補」を同じ形で扱う。
function readAxis(axis, answer) {
  if (!answer) return null;
  if (answer.type === 'choice') {
    const entries = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]);
    const value = answer.choice ?? entries[0]?.[0];
    return {
      kind: 'choice',
      value,
      probability: answer.probabilities?.[value] ?? 0,
      confidence: answer.confidence,
      ranked: entries.map(([label, p]) => ({ label, p })),
      ordered: Object.keys(axis.question.criteria).map((label) => ({
        label,
        p: answer.probabilities?.[label] ?? 0,
      })),
    };
  }
  const levels = axis.question.criteria;
  const labelOf = (i) => answer.legend?.[String(i)] ?? levels[i];
  const ordered = levels.map((_, i) => ({ label: labelOf(i), p: answer.probabilities?.[String(i)] ?? 0 }));
  // おすすめ値は最も確率の高いレベル（期待値の丸めだと確率の低いレベルを指すことがある）。
  // 期待値のほうはカード側で score として併記する。
  const ranked = [...ordered].sort((a, b) => b.p - a.p);
  return {
    kind: 'score',
    value: ranked[0]?.label,
    probability: ranked[0]?.p ?? 0,
    confidence: answer.confidence,
    score: answer.score,
    ranked,
    ordered,
  };
}

/* ---------- 描画 ---------- */

function bars(read) {
  const top = read.ranked[0]?.label;
  return read.ordered
    .map(({ label, p }) => `
      <div class="bar-row ${label === top ? 'top' : ''}">
        <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${label}</span>
        <span class="bar-val">${pct(p)}</span>
      </div>`)
    .join('');
}

function renderAxes(reads) {
  el.axes.innerHTML = AXES.map((axis) => {
    const read = reads[axis.id];
    if (!read) return '';
    const conf = read.confidence != null ? `確信度 ${pct(read.confidence)}` : '';
    const score = read.kind === 'score' && read.score != null ? ` / score ${read.score.toFixed(2)}` : '';
    return `
      <article class="axis">
        <header>
          <h3>${axis.label}</h3>
          <span class="conf">${conf}${score}</span>
        </header>
        <p class="hint">${axis.hint}</p>
        <div class="bars">${bars(read)}</div>
      </article>`;
  }).join('');
}

function renderSummary(reads) {
  el.summary.innerHTML = AXES.map((axis) => {
    const read = reads[axis.id];
    if (!read) return '';
    const loose = read.probability < CONF_LOW ? 'loose' : '';
    return `<span class="cond ${loose}"><span class="k">${axis.label}</span><span class="v">${read.value}</span><span class="p">${pct(read.probability)}</span></span>`;
  }).join('');
}

function renderFlags(answers) {
  const rows = FLAGS.map((flag) => ({ flag, p: answers[`flag_${flag.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.p - a.p);

  el.flags.innerHTML = rows.map(({ flag, p }) => `
    <div class="bar-row ${p >= FLAG_ON ? 'top' : ''}">
      <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${flag.label}</span>
      <span class="bar-val">${pct(p)}</span>
    </div>`).join('');

  const on = rows.filter((r) => r.p >= FLAG_ON);
  el.flagChips.innerHTML = on.length
    ? on.map(({ flag, p }) => `<span class="cond"><span class="v">${flag.label}</span><span class="p">${pct(p)}</span></span>`).join('')
    : '<span class="note">はっきり必要と読み取れたこだわり条件はありませんでした。</span>';

  return rows;
}

function renderAskMore(reads, flagRows) {
  const items = [];

  for (const axis of AXES) {
    const read = reads[axis.id];
    if (!read || read.probability >= CONF_LOW) continue;
    const [first, second] = read.ranked;
    items.push(`<strong>${axis.label}</strong>：「${first.label}」と「${second?.label ?? '—'}」で割れています（${pct(first.p)} / ${pct(second?.p ?? 0)}）
      <span class="q">→ どちらに近いか確認したい</span>`);
  }

  for (const { flag, p } of flagRows) {
    if (p >= FLAG_MAYBE && p < FLAG_ON) {
      items.push(`<strong>${flag.label}</strong>：必要そうだが読み切れません（${pct(p)}）<span class="q">→ 条件に入れるか確認したい</span>`);
    }
  }

  el.askmore.innerHTML = items.length
    ? items.map((t) => `<li>${t}</li>`).join('')
    : '<li>大きく割れている項目はありません。この条件でそのまま検索してよさそうです。</li>';
}

function summaryText(reads, flagRows) {
  const lines = ['【おすすめ検索条件】'];
  for (const axis of AXES) {
    const read = reads[axis.id];
    if (read) lines.push(`- ${axis.label}: ${read.value}（${pct(read.probability)}）`);
  }
  const on = flagRows.filter((r) => r.p >= FLAG_ON);
  lines.push('', '【チェックを入れる条件】');
  lines.push(on.length ? on.map(({ flag, p }) => `- ${flag.label}（${pct(p)}）`).join('\n') : '- なし');
  return lines.join('\n');
}

function render(result) {
  const reads = {};
  for (const axis of AXES) reads[axis.id] = readAxis(axis, result.answers?.[axis.id]);

  renderSummary(reads);
  const flagRows = renderFlags(result.answers || {});
  renderAskMore(reads, flagRows);
  renderAxes(reads);
  el.raw.textContent = JSON.stringify(result, null, 2);
  lastResult = { reads, flagRows };
  el.result.hidden = false;
}

/* ---------- イベント ---------- */

async function run() {
  const text = el.hearing.value.trim();
  if (text.length < 10) {
    el.status.textContent = 'もう少し詳しく書いてください（10文字以上）。';
    el.hearing.focus();
    return;
  }

  el.run.disabled = true;
  el.status.textContent = getEndpoint() ? 'Jev に問い合わせ中…' : 'デモモードで推定中…';
  const started = performance.now();

  try {
    const result = await evaluate(text);
    render(result);
    const ms = Math.round(performance.now() - started);
    const tokens = result.usage?.input_tokens;
    el.status.textContent = result._demo
      ? `デモモードの結果です（${ms}ms）。実際の確率は Jev の API キーを設定すると出ます。`
      : `Jev から取得しました（${ms}ms${tokens ? ` / 入力 ${tokens} トークン` : ''}）。`;
    el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const hint = getEndpoint() ? '' : '\nプロキシ URL を設定するか、空欄にしてデモモードで試してください。';
    el.status.textContent = `失敗しました: ${error.message}${hint}`;
    el.settings.open = true;
  } finally {
    el.run.disabled = false;
  }
}

el.run.addEventListener('click', run);
el.hearing.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
});

el.clear.addEventListener('click', () => {
  el.hearing.value = '';
  el.status.textContent = '';
  el.result.hidden = true;
  el.hearing.focus();
});

for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    el.hearing.value = EXAMPLES[button.dataset.example];
    el.hearing.focus();
  });
}

el.copy.addEventListener('click', async () => {
  if (!lastResult) return;
  const text = summaryText(lastResult.reads, lastResult.flagRows);
  try {
    await navigator.clipboard.writeText(text);
    el.copyNote.textContent = 'コピーしました。';
  } catch {
    el.copyNote.textContent = 'コピーできませんでした。JSON から手動で控えてください。';
  }
  setTimeout(() => (el.copyNote.textContent = ''), 3000);
});

$('save-endpoint').addEventListener('click', () => {
  const value = el.endpoint.value.trim();
  if (value) localStorage.setItem(LS_KEY, value);
  else localStorage.removeItem(LS_KEY);
  refreshMode();
  el.status.textContent = value ? '接続先を保存しました。' : 'デモモードに戻しました。';
});

$('forget-endpoint').addEventListener('click', () => {
  localStorage.removeItem(LS_KEY);
  refreshMode();
  el.status.textContent = 'デモモードに戻しました。';
});

refreshMode();
