import { buildQuestions, buildState } from './questions.js';
import { interpret, summaryText, openQuestions, pct, CONF_LOW, FLAG_ON } from './interpret.js';
import { mockEvaluate } from './mock.js';
import { EXAMPLES } from './examples.js';

// Worker で配信しているときは同じオリジンの /jev が中継になる。
// 中継が無い静的配信（GitHub Pages など）ではデモモードに落ちる。
const SAME_ORIGIN = new URL('jev', document.baseURI).href;

const $ = (id) => document.getElementById(id);
const el = {
  hearing: $('hearing'), run: $('run'), clear: $('clear'), status: $('status'),
  result: $('result'), summary: $('summary-chips'),
  flagChips: $('flag-chips'), axes: $('axes'),
  flags: $('flags'), raw: $('raw'), copy: $('copy'), copyNote: $('copy-note'),
};

let lastResult = null;

/* ---------- 接続先 ---------- */

let endpoint = '';   // 空文字ならデモモード

async function resolveEndpoint() {
  try {
    const res = await fetch(SAME_ORIGIN, { method: 'GET' });
    const body = res.ok ? await res.json() : null;
    endpoint = body?.service === 'jev-proxy' && body?.configured === true ? SAME_ORIGIN : '';
  } catch {
    endpoint = '';   // 静的配信なら 404 か JSON でない応答になる
  }
}

const ready = resolveEndpoint();

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
  const top = read.value;
  return read.ordered
    .map(({ label, p }) => `
      <div class="bar-row ${label === top ? 'top' : ''}">
        <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${label}</span>
        <span class="bar-val">${pct(p)}</span>
      </div>`)
    .join('');
}

function askItem(item) {
  if (item.kind === 'flag') {
    return `
      <li>
        <span class="ask-label">${item.label}</span>
        <span class="ask-detail">必要かどうか決めきれていません（${pct(item.p)}）</span>
      </li>`;
  }
  const first = item.first ? `${item.first.label}（${pct(item.first.p)}）` : '';
  const second = item.second ? ` と ${item.second.label}（${pct(item.second.p)}）` : '';
  return `
    <li>
      <span class="ask-label">${item.label}</span>
      <span class="ask-detail">${first}${second} で割れています</span>
    </li>`;
}

// 軸は奇数個になることが多く（賃料と価格はどちらか一方だけ出る）、2列グリッドの
// 最後に空きができる。そこを「確率が割れていて聞き足りない項目」で埋める。
function askCard(interpreted, columnLeftOver) {
  const items = openQuestions(interpreted);
  const body = items.length
    ? `<ul class="ask-list">${items.map(askItem).join('')}</ul>`
    : '<p class="note">確率が割れている項目はありません。入力だけで一通り決めきれています。</p>';
  return `
    <article class="axis ask ${columnLeftOver ? '' : 'wide'}">
      <header><h3>もう少し聞きたいこと</h3></header>
      <p class="hint">確認できると、検索条件の精度が上がる項目です。</p>
      ${body}
    </article>`;
}

function renderAxes(interpreted) {
  const { axes, reads } = interpreted;
  const cards = axes.map((axis) => {
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
        ${axis.hint ? `<p class="hint">${axis.hint}</p>` : ''}
        <div class="bars">${bars(read)}</div>
      </article>`;
  }).filter(Boolean);

  el.axes.innerHTML = cards.join('') + askCard(interpreted, cards.length % 2 === 1);
}

function renderSummary(axes, reads) {
  el.summary.innerHTML = axes.map((axis) => {
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

function render(result) {
  const interpreted = interpret(result);
  renderSummary(interpreted.axes, interpreted.reads);
  renderFlags(interpreted.flagRows);
  renderAxes(interpreted);
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
      ? `デモモードの結果です（${ms}ms）。`
      : `Jev から取得しました（${ms}ms${tokens ? ` / 入力 ${tokens} トークン` : ''}）。`;
    el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    el.status.textContent = `失敗しました: ${error.message}`;
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
