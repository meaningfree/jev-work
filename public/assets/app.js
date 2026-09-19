import { AXES, buildQuestions, buildState } from './questions.js';
import { interpret, openQuestions, summaryText, pct, CONF_LOW, FLAG_ON } from './interpret.js';
import { mockEvaluate } from './mock.js';

const LS_KEY = 'jev-search-generator.endpoint';
const DEMO = 'demo';
// Worker で配信しているときは同じオリジンの /jev が中継になる。
const SAME_ORIGIN = new URL('jev', document.baseURI).href;

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

/* ---------- 接続先 ----------

   保存値なし        → 同じオリジンの /jev を試し、応答すればそこに繋ぐ（Worker 配信）
   保存値が URL      → その中継に繋ぐ
   保存値が 'demo'   → 明示的にデモモード
   同じオリジンに中継が無い（GitHub Pages などの静的配信）→ デモモード
*/

let endpoint = '';   // 実際に使う接続先。空文字ならデモモード。

const savedEndpoint = () => (localStorage.getItem(LS_KEY) || '').trim();

async function sameOriginProxyReady() {
  try {
    const res = await fetch(SAME_ORIGIN, { method: 'GET' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.service === 'jev-proxy' && body?.configured === true;
  } catch {
    return false;   // 静的配信なら 404 か JSON でない応答になる
  }
}

async function refreshMode() {
  const saved = savedEndpoint();
  el.endpoint.value = saved === DEMO ? '' : saved;

  if (saved === DEMO) endpoint = '';
  else if (saved) endpoint = saved;
  else endpoint = (await sameOriginProxyReady()) ? SAME_ORIGIN : '';

  if (endpoint) {
    el.mode.textContent = endpoint === SAME_ORIGIN && !saved
      ? 'Jev API に接続（このサーバー経由）'
      : 'Jev API に接続（中継サーバー経由）';
    el.mode.classList.remove('demo');
  } else {
    el.mode.textContent = saved === DEMO ? 'デモモード（手動で選択中）' : 'デモモード（中継サーバーなし）';
    el.mode.classList.add('demo');
  }
}

let ready = refreshMode();

/* ---------- 推論 ---------- */

function errorMessage(status, body) {
  const detail = body ? `（${body.slice(0, 200)}）` : '';
  if (status === 401) return `API キーが無効か、プロキシに設定されていません${detail}`;
  if (status === 422) return `リクエストの形式が Jev に受け付けられませんでした${detail}`;
  if (status === 429) return 'レート制限に達しました。少し待って再試行してください';
  if (status === 529) return 'Jev 側が混み合っています。少し待って再試行してください';
  return `プロキシがエラーを返しました（HTTP ${status}）${detail}`;
}

async function evaluate(text) {
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

function renderFlags(rows) {
  el.flags.innerHTML = rows.map(({ flag, p }) => `
    <div class="bar-row ${p >= FLAG_ON ? 'top' : ''}">
      <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${flag.label}</span>
      <span class="bar-val">${pct(p)}</span>
    </div>`).join('');

  const on = rows.filter((r) => r.p >= FLAG_ON);
  el.flagChips.innerHTML = on.length
    ? on.map(({ flag, p }) => `<span class="cond"><span class="v">${flag.label}</span><span class="p">${pct(p)}</span></span>`).join('')
    : '<span class="note">はっきり必要と読み取れたこだわり条件はありませんでした。</span>';
}

function renderAskMore(interpreted) {
  const items = openQuestions(interpreted).map((item) =>
    item.kind === 'axis'
      ? `<strong>${item.label}</strong>：「${item.first.label}」と「${item.second?.label ?? '—'}」で割れています（${pct(item.first.p)} / ${pct(item.second?.p)}）
         <span class="q">→ どちらに近いか確認したい</span>`
      : `<strong>${item.label}</strong>：必要そうだが読み切れません（${pct(item.p)}）<span class="q">→ 条件に入れるか確認したい</span>`);

  el.askmore.innerHTML = items.length
    ? items.map((t) => `<li>${t}</li>`).join('')
    : '<li>大きく割れている項目はありません。この条件でそのまま検索してよさそうです。</li>';
}

function render(result) {
  const interpreted = interpret(result);
  renderSummary(interpreted.reads);
  renderFlags(interpreted.flagRows);
  renderAskMore(interpreted);
  renderAxes(interpreted.reads);
  el.raw.textContent = JSON.stringify(result, null, 2);
  lastResult = interpreted;
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

  await ready;   // 起動直後は接続先の判定を待つ

  el.run.disabled = true;
  el.status.textContent = endpoint ? 'Jev に問い合わせ中…' : 'デモモードで推定中…';
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
    const hint = endpoint ? '' : '\n中継サーバーの URL を設定するか、デモモードで試してください。';
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
  const text = summaryText(lastResult);
  try {
    await navigator.clipboard.writeText(text);
    el.copyNote.textContent = 'コピーしました。';
  } catch {
    el.copyNote.textContent = 'コピーできませんでした。JSON から手動で控えてください。';
  }
  setTimeout(() => (el.copyNote.textContent = ''), 3000);
});

function applyEndpoint(value, message) {
  if (value) localStorage.setItem(LS_KEY, value);
  else localStorage.removeItem(LS_KEY);
  ready = refreshMode();
  el.status.textContent = message;
}

$('save-endpoint').addEventListener('click', () => {
  const value = el.endpoint.value.trim();
  applyEndpoint(value, value ? '接続先を保存しました。' : '自動判定に戻しました。');
});

$('auto-endpoint').addEventListener('click', () => {
  applyEndpoint('', '自動判定に戻しました。');
});

$('demo-endpoint').addEventListener('click', () => {
  applyEndpoint(DEMO, 'デモモードに切り替えました。');
});
