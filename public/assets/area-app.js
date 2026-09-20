import { buildAreaRequests, mergeResults } from './area-questions.js';
import { interpretArea, areaSummaryText, topPrefSummary, spreadNote, pct } from './area-interpret.js';
import { mockAreaEvaluate } from './area-mock.js';

// index.html と同じく、同一オリジンの /jev があればそれを中継に使う。
const SAME_ORIGIN = new URL('jev', document.baseURI).href;

const EXAMPLES = {
  dual:
    '共働きの夫婦＋0歳の子ども。私の職場は大手町、妻は品川。保育園に入れたいので待機児童が少ないところがいい。通勤はどちらも40分くらいまで。家賃は15万円くらいまで。休日に歩ける公園があると嬉しい。',
  single:
    '来月から社会人で初めての一人暮らし。職場は新宿。家賃は9万円まで。通勤は30分以内にしたい。外食や買い物に困らない、ひとりでも暮らしやすい街がいい。',
  buy:
    '夫婦と子ども2人（6歳・3歳）。そろそろマンションを買いたい。夫の職場は東京駅で、電車50分くらいまでなら通える。小学校の評判と、子どもを遊ばせられる場所を重視したい。予算は5,000万円台。',
  remote:
    '夫婦ともフルリモートで出社は月数回。都心にこだわらないので、広い部屋と静かさを優先したい。犬を飼っているので散歩できる緑があるとうれしい。家賃は12万円くらいまで。たまに都心に出られればいい。',
};

const $ = (id) => document.getElementById(id);
const el = {
  hearing: $('hearing'), run: $('run'), clear: $('clear'), status: $('status'),
  result: $('result'), rank: $('rank'), stats: $('stats'), axes: $('axes'),
  all: $('all-stations'), request: $('request'), raw: $('raw'),
  copy: $('copy'), copyNote: $('copy-note'),
};

let lastInterpreted = null;

/* ---------- 接続先 ---------- */

let endpoint = '';   // 空文字ならデモモード

async function resolveEndpoint() {
  try {
    const res = await fetch(SAME_ORIGIN, { method: 'GET' });
    const body = res.ok ? await res.json() : null;
    endpoint = body?.service === 'jev-proxy' && body?.configured === true ? SAME_ORIGIN : '';
  } catch {
    endpoint = '';
  }
}

const ready = resolveEndpoint();

/* ---------- 推論 ---------- */

function errorMessage(status, body) {
  const detail = body ? `（${body.slice(0, 200)}）` : '';
  if (status === 401) return `API キーが無効か、プロキシに設定されていません${detail}`;
  if (status === 413) return `リクエストが大きすぎます${detail}`;
  if (status === 422) return `リクエストの形式が Jev に受け付けられませんでした${detail}`;
  if (status === 429) return 'レート制限に達しました。少し待って再試行してください';
  if (status === 529) return 'Jev 側が混み合っています。少し待って再試行してください';
  return `プロキシがエラーを返しました（HTTP ${status}）${detail}`;
}

async function postOne(body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(errorMessage(res.status, await res.text().catch(() => '')));
  return res.json();
}

// 100 駅は分割して並列に投げ、答えを 1 つにまとめる（area-questions.js の CHUNK_SIZE）。
async function evaluate(requests) {
  if (!endpoint) return mockAreaEvaluate(requests[0].state.hearing);
  return mergeResults(await Promise.all(requests.map(postOne)));
}

/* ---------- 描画 ---------- */

// バーの長さは Jev が返した確率そのまま。色（tier）は 100駅の中での相対位置で、
// 確率の絶対値が入力ごとに上下しても「上位1/4の駅」が同じ意味で読めるようにしている。
const fill = (row) => `<span class="fill" style="width:${Math.max(row.p * 100, 2)}%"></span>`;

function renderRank(interpreted) {
  el.rank.innerHTML = interpreted.top.map((row) => `
    <li class="rank-row ${row.tier}">
      <span class="rank-name">${row.name}</span>
      <span class="pref-tag">${row.pref}</span>
      <span class="rank-bar">${fill(row)}</span>
      <span class="rank-val">${pct(row.p)}</span>
    </li>`).join('');

  const { count, max, median, min } = interpreted.stats;
  el.stats.textContent =
    `${count}駅の評価: 最高 ${pct(max)} / 中央値 ${pct(median)} / 最低 ${pct(min)}。` +
    `${spreadNote(interpreted)}上位の内訳: ${topPrefSummary(interpreted)}`;
}

function bars(read) {
  const top = read.value;
  return read.ordered.map(({ label, p }) => `
    <div class="bar-row ${label === top ? 'top' : ''}">
      <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${label}</span>
      <span class="bar-val">${pct(p)}</span>
    </div>`).join('');
}

function renderAxes(interpreted) {
  el.axes.innerHTML = interpreted.axes.map(({ axis, read }) => {
    const conf = read.confidence != null ? `確信度 ${pct(read.confidence)}` : '';
    return `
      <article class="axis">
        <header>
          <h3>${axis.label}</h3>
          <span class="conf">${conf}</span>
        </header>
        ${axis.hint ? `<p class="hint">${axis.hint}</p>` : ''}
        <div class="bars">${bars(read)}</div>
      </article>`;
  }).join('');
}

function renderAll(interpreted) {
  el.all.innerHTML = interpreted.byPref.map(({ pref, rows }) => `
      <details class="pref-group">
        <summary>${pref}（${rows.length}駅／最高 ${pct(rows[0]?.p ?? 0)}）</summary>
        <div class="bars">
          ${rows.map((row) => `
            <div class="bar-row ${row.tier}">
              <span class="bar-label">${fill(row)}${row.name}</span>
              <span class="bar-val">${pct(row.p)}</span>
            </div>`).join('')}
        </div>
      </details>`).join('');
}

function render(result, requests) {
  const interpreted = interpretArea(result);
  renderRank(interpreted);
  renderAxes(interpreted);
  renderAll(interpreted);
  el.request.textContent = JSON.stringify(requests, null, 2);
  el.raw.textContent = JSON.stringify(result, null, 2);
  lastInterpreted = interpreted;
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

  await ready;

  const requests = buildAreaRequests(text);
  el.run.disabled = true;
  const split = requests.length > 1 ? `${requests.length}リクエストに分けて` : '';
  el.status.textContent = endpoint
    ? `Jev に問い合わせ中…（100駅を${split}評価）`
    : 'デモモードで推定中…';
  const started = performance.now();

  try {
    const result = await evaluate(requests);
    render(result, requests);
    const ms = Math.round(performance.now() - started);
    const tokens = result.usage?.input_tokens;
    el.status.textContent = result._demo
      ? `デモモードの結果です（${ms}ms）。実 API ではありません。`
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
  if (!lastInterpreted) return;
  try {
    await navigator.clipboard.writeText(areaSummaryText(lastInterpreted));
    el.copyNote.textContent = 'コピーしました。';
  } catch {
    el.copyNote.textContent = 'コピーできませんでした。JSON から手動で控えてください。';
  }
  setTimeout(() => (el.copyNote.textContent = ''), 3000);
});
