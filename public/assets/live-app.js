import { buildState } from './questions.js';
import { LIVE_AXES, LIVE_FLAGS, buildLiveQuestions, liveAxesFor, composeHearing } from './live-questions.js';
import { readAxis, summaryText, pct, CONF_LOW, FLAG_ON } from './interpret.js';
import { mockEvaluate } from './mock.js';

// Worker で配信しているときは同じオリジンの /jev が中継になる。
// 中継が無い静的配信（GitHub Pages など）ではデモモードに落ちる。
const SAME_ORIGIN = new URL('jev', document.baseURI).href;

// 文字入力は打ち終わるまで待ってから投げる。選択肢・チェックは即時。
const TYPING_DELAY = 700;

const EXAMPLES = {
  family: {
    household: '夫婦＋子ども2人以上',
    intent: '購入を検討している',
    budget: 'あまり余裕はない。4,000万円くらいまで',
    work: '夫の職場は品川',
    commute: '電車で1時間くらいまでなら許容',
    timing: '1年以上先・急いでいない',
    life: ['車を持っている・買う予定', '保育園・小学校に通う子どもがいる'],
    memo: '子どもを走らせられる公園が近くにあって、静かな住宅地がいい。',
  },
  single: {
    household: '一人暮らし',
    intent: '賃貸で探したい',
    budget: '家賃8万円くらいまで',
    work: '渋谷',
    commute: 'とにかく駅から近いところがいい',
    timing: 'すぐにでも引っ越したい',
    life: ['防犯が気になる'],
    memo: '初めての一人暮らし。自炊はあまりしない。',
  },
  senior: {
    household: '親と同居（二世帯を含む）',
    intent: '',
    budget: '',
    work: '母の通院先が近いほうがいい',
    commute: '電車で30分くらいまで',
    timing: '1年以上先・急いでいない',
    life: ['高齢の家族がいて階段がつらい'],
    memo: '買い物が歩いて行ける範囲にあると助かる。',
  },
};

const $ = (id) => document.getElementById(id);
const el = {
  form: $('form'), status: $('status'), output: $('output'), empty: $('empty'),
  summary: $('summary-chips'), flagChips: $('flag-chips'), axes: $('axes'),
  hearing: $('hearing'), copy: $('copy'), copyNote: $('copy-note'),
};

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

function errorMessage(status) {
  if (status === 401) return 'API キーが無効か、プロキシに設定されていません';
  if (status === 429) return 'レート制限に達しました。少し待ってから入力を変えてください';
  if (status === 529) return 'Jev 側が混み合っています';
  return `プロキシがエラーを返しました（HTTP ${status}）`;
}

async function evaluate(text, signal) {
  if (!endpoint) return mockEvaluate(text, { axes: LIVE_AXES, flags: LIVE_FLAGS });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: buildState(text), questions: buildLiveQuestions() }),
    signal,
  });
  if (!res.ok) throw new Error(errorMessage(res.status));
  return res.json();
}

function interpretLive(result) {
  const answers = result?.answers || {};
  const reads = {};
  for (const axis of LIVE_AXES) reads[axis.id] = readAxis(axis, answers[axis.id]);
  const flagRows = LIVE_FLAGS
    .map((flag) => ({ flag, p: answers[`flag_${flag.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return { reads, flagRows, axes: liveAxesFor(reads.torihiki?.value) };
}

/* ---------- 描画 ---------- */

// 前回から値が変わった条件だけ光らせて、何が動いたかを分かるようにする。
let previous = new Map();

function renderSummary({ axes, reads }) {
  const next = new Map();
  el.summary.innerHTML = axes.map((axis) => {
    const read = reads[axis.id];
    if (!read) return '';
    next.set(axis.id, read.value);
    const loose = read.probability < CONF_LOW ? 'loose' : '';
    const changed = previous.size && previous.get(axis.id) !== read.value ? 'changed' : '';
    return `<span class="cond ${loose} ${changed}"><span class="k">${axis.label}</span><span class="v">${read.value}</span><span class="p">${pct(read.probability)}</span></span>`;
  }).join('');
  return next;
}

function renderFlags(flagRows, next) {
  const on = flagRows.filter((r) => r.p >= FLAG_ON);
  for (const { flag } of on) next.set(`flag_${flag.id}`, true);
  el.flagChips.innerHTML = on.length
    ? on.map(({ flag, p }) => {
      const changed = previous.size && !previous.has(`flag_${flag.id}`) ? 'changed' : '';
      return `<span class="cond ${changed}"><span class="v">${flag.label}</span><span class="p">${pct(p)}</span></span>`;
    }).join('')
    : '<span class="note">はっきり必要と読み取れたこだわり条件はありません。</span>';
}

function renderAxes({ axes, reads }) {
  el.axes.innerHTML = axes.map((axis) => {
    const read = reads[axis.id];
    if (!read) return '';
    // 全選択肢を出すと縦に長くなるので、上位 3 つだけ。
    const rows = read.ranked.slice(0, 3).map(({ label, p }) => `
      <div class="bar-row ${label === read.value ? 'top' : ''}">
        <span class="bar-label"><span class="fill" style="width:${Math.max(p * 100, 1.5)}%"></span>${label}</span>
        <span class="bar-val">${pct(p)}</span>
      </div>`).join('');
    return `<div class="live-axis"><h4>${axis.label}</h4><div class="bars">${rows}</div></div>`;
  }).join('');
}

let lastInterpreted = null;

function render(result) {
  const interpreted = interpretLive(result);
  const next = renderSummary(interpreted);
  renderFlags(interpreted.flagRows, next);
  renderAxes(interpreted);
  previous = next;
  lastInterpreted = interpreted;
  el.empty.hidden = true;
  el.copy.disabled = false;
}

function renderEmpty() {
  el.summary.innerHTML = el.flagChips.innerHTML = el.axes.innerHTML = '';
  el.empty.hidden = false;
  el.copy.disabled = true;
  el.status.textContent = '';
  el.output.classList.remove('stale');
  previous = new Map();
  lastInterpreted = null;
}

/* ---------- リアルタイム更新 ---------- */

function readForm() {
  const data = new FormData(el.form);
  const text = (name) => String(data.get(name) ?? '').trim();
  return {
    household: text('household'),
    intent: text('intent'),
    budget: text('budget'),
    work: text('work'),
    commute: text('commute'),
    timing: text('timing'),
    life: data.getAll('life').map(String),
    memo: text('memo'),
  };
}

let timer = 0;
let sentHearing = '';   // 最後に投げたメモ。同じ内容なら投げ直さない
let controller = null;  // 投げている途中のリクエスト（新しい入力が来たら取り消す）
let seq = 0;

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(update, delay);
}

async function update() {
  const hearing = composeHearing(readForm());
  el.hearing.textContent = hearing || '（まだ何も入力されていません）';
  if (hearing === sentHearing) return;
  sentHearing = hearing;

  controller?.abort();
  controller = null;
  if (!hearing) {
    renderEmpty();
    return;
  }

  await ready;   // 起動直後は接続先の判定を待つ

  const mine = ++seq;
  const ctrl = new AbortController();
  controller = ctrl;
  el.output.classList.add('stale');
  el.status.textContent = endpoint ? '更新中…' : 'デモモードで更新中…';
  const started = performance.now();

  try {
    const result = await evaluate(hearing, ctrl.signal);
    if (mine !== seq) return;   // 後から来た入力のほうを優先する
    render(result);
    const ms = Math.round(performance.now() - started);
    el.status.textContent = result._demo ? `デモモード（${ms}ms）` : `更新しました（${ms}ms）`;
  } catch (error) {
    if (error.name === 'AbortError' || mine !== seq) return;
    sentHearing = '';   // 次の変更で投げ直せるようにする
    el.status.textContent = `失敗しました: ${error.message}`;
  } finally {
    if (mine === seq) {
      el.output.classList.remove('stale');
      controller = null;
    }
  }
}

el.form.addEventListener('input', (e) => {
  const typing = e.target.matches('input[type="text"], textarea');
  schedule(typing ? TYPING_DELAY : 0);
});
// 文字入力欄はフォーカスが外れた時点（onchange）で待たずに確定させる。
el.form.addEventListener('change', () => schedule(0));
// reset イベントは値が戻る前に来るので、戻った後の値で出し直す。
el.form.addEventListener('reset', () => schedule(0));
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  schedule(0);
});

function fillExample(example) {
  el.form.household.value = example.household;
  for (const radio of el.form.querySelectorAll('[name="intent"]')) radio.checked = radio.value === example.intent;
  el.form.budget.value = example.budget;
  el.form.work.value = example.work;
  el.form.commute.value = example.commute;
  el.form.timing.value = example.timing;
  for (const box of el.form.querySelectorAll('[name="life"]')) box.checked = example.life.includes(box.value);
  el.form.memo.value = example.memo;
  schedule(0);
}

for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => fillExample(EXAMPLES[button.dataset.example]));
}

el.copy.addEventListener('click', async () => {
  if (!lastInterpreted) return;
  try {
    await navigator.clipboard.writeText(summaryText(lastInterpreted));
    el.copyNote.textContent = 'コピーしました。';
  } catch {
    el.copyNote.textContent = 'コピーできませんでした。';
  }
  setTimeout(() => (el.copyNote.textContent = ''), 3000);
});

// ブラウザがフォームの値を復元した場合（戻るボタンなど）にも出しておく。
schedule(0);
