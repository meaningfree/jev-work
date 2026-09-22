// 比較ページの組み立て。
// 検索条件ページ（app.js）と同じ questions.js / interpret.js を使い、
// 同じリクエストを provider だけ変えて複数回投げる。
import { buildQuestions, buildState } from './questions.js';
import { EXAMPLES } from './examples.js';
import { compareRuns, compareSummaryText, costOf, formatCost, pct } from './compare.js';
import { mockEvaluate } from './mock.js';

const SAME_ORIGIN = new URL('jev', document.baseURI).href;

// 中継が無いときに表示するダミー。実際のモデルの挙動ではなく、
// 画面の動きを確かめるためだけのもの（キーワードマッチに癖を付けただけ）。
const DEMO_PROVIDERS = [
  {
    id: 'jev', label: 'Jev（デモ）', configured: true,
    models: [{ id: 'demo-jev', short: 'Jev', label: 'demo-keyword-matcher', price: null, demo: { jitter: 0, sharpen: 1, label: 'demo-jev' } }],
  },
  {
    id: 'openai', label: 'OpenAI（デモ）', configured: true,
    models: [
      { id: 'demo-openai-small', short: 'OpenAI 小', label: 'demo-sharpened', price: null, demo: { jitter: 0.5, sharpen: 2.4, label: 'demo-openai' } },
      { id: 'demo-openai-large', short: 'OpenAI 大', label: 'demo-sharpened-2', price: null, demo: { jitter: 0.3, sharpen: 3.2, label: 'demo-openai-large' } },
    ],
  },
  {
    id: 'gemini', label: 'Gemini（デモ）', configured: true,
    models: [{ id: 'demo-gemini', short: 'Gemini', label: 'demo-jittered', price: null, demo: { jitter: 0.8, sharpen: 1.4, label: 'demo-gemini' } }],
  },
];

const $ = (id) => document.getElementById(id);
const el = {
  hearing: $('hearing'), run: $('run'), clear: $('clear'), status: $('status'),
  picker: $('model-picker'), pickerNote: $('picker-note'), result: $('result'),
  runs: $('runs'), pairs: $('pairs'), decisiveness: $('decisiveness'),
  highlights: $('highlights'), axes: $('axes'), flags: $('flags'),
  raw: $('raw'), copy: $('copy'), copyNote: $('copy-note'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms = (n) => (n == null ? '—' : `${n}ms`);
const num = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const unitPrice = (price) =>
  price ? `入力 $${price.input} / 出力 $${price.output}（100万トークン）` : '単価不明';

let providers = [];
let limits = null;
let demoMode = false;
let lastCompare = null;

/* ---------- 接続先とモデル一覧 ---------- */

async function resolveProviders() {
  try {
    const res = await fetch(SAME_ORIGIN, { method: 'GET' });
    const body = res.ok ? await res.json() : null;
    if (body?.service !== 'jev-proxy' || !Array.isArray(body.providers)) throw new Error('no proxy');
    if (!body.providers.some((p) => p.configured)) throw new Error('no key');
    providers = body.providers;
    limits = body.limits ?? null;
    demoMode = false;
  } catch {
    providers = DEMO_PROVIDERS;
    limits = null;
    demoMode = true;
  }
  renderPicker();
}

/** チェックボックスの値。プロバイダとモデルの組で 1 行になる。 */
const runIdOf = (providerId, modelId) => `${providerId}:${modelId}`;

function findEntry(runId) {
  const [providerId, ...rest] = runId.split(':');
  const modelId = rest.join(':');
  const provider = providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  return provider && model ? { provider, model } : null;
}

// 既定では各プロバイダの先頭のモデルだけを選ぶ（全部入れると高くつくので）。
function renderPicker() {
  el.picker.innerHTML = providers
    .map((p) => `
      <fieldset class="model-group ${p.configured ? '' : 'off'}">
        <legend>${esc(p.label)}${p.configured ? '' : '<span class="tag">キー未設定</span>'}</legend>
        ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
        ${p.models.map((m, i) => `
          <label class="model-opt ${p.configured ? '' : 'off'}">
            <input type="checkbox" value="${esc(runIdOf(p.id, m.id))}"
              ${p.configured && i === 0 ? 'checked' : ''} ${p.configured ? '' : 'disabled'} />
            <span class="model-name">${esc(m.label)}</span>
            <span class="model-id">${esc(m.id)}</span>
            <span class="model-id">${esc(unitPrice(m.price))}</span>
          </label>`).join('')}
      </fieldset>`)
    .join('');

  for (const input of el.picker.querySelectorAll('input')) {
    input.addEventListener('change', updatePickerNote);
  }
  updatePickerNote();
}

function updatePickerNote() {
  const chosen = selected();
  const llm = chosen.filter((e) => e.provider.id !== 'jev').length;
  const lines = [];

  if (demoMode) {
    lines.push('中継が見つからないのでデモモードです。表示されるのは実際のモデルの出力ではなく、画面確認用のダミーです。');
  } else {
    const usable = providers.filter((p) => p.configured).length;
    if (usable < 2) {
      lines.push('比較には 2 つ以上のキーが要ります。OPENAI_API_KEY / GEMINI_API_KEY を Worker のシークレット（ローカルなら .dev.vars）に足すと選べるようになります。');
    } else if (providers.some((p) => !p.configured)) {
      lines.push('キーが設定されていないモデルは選べません（シークレットに追加すると出てきます）。');
    }
    // 1 回の実行で、選んだ数だけ上限を消費する。
    if (limits?.llm?.limit > 0 && llm > 0) {
      lines.push(`選択中 ${chosen.length} モデル（うち生成モデル ${llm}）。生成モデルは 1 分あたり ${limits.llm.limit} 回までなので、この組み合わせなら 1 分に ${Math.floor(limits.llm.limit / llm)} 回まで実行できます。`);
    } else {
      lines.push(`選択中 ${chosen.length} モデル。`);
    }
  }
  el.pickerNote.textContent = lines.join(' ');
}

/** 選択中のモデル（プロバイダとモデルの組）。 */
function selected() {
  return [...el.picker.querySelectorAll('input:checked')]
    .map((input) => findEntry(input.value))
    .filter(Boolean);
}

const ready = resolveProviders();

/* ---------- 実行 ---------- */

function errorMessage(status, body) {
  let detail = body ? body.slice(0, 200) : '';
  try {
    const parsed = JSON.parse(body);
    detail = [parsed.error, parsed.detail].filter(Boolean).join(' / ').slice(0, 200);
  } catch { /* JSON でなければそのまま使う */ }
  if (status === 401 || status === 403) return `認証に失敗しました（HTTP ${status}）${detail ? `: ${detail}` : ''}`;
  if (status === 429) return 'レート制限に達しました。少し待って再試行してください';
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

async function runOne({ provider, model }, text) {
  const started = performance.now();
  const run = {
    id: runIdOf(provider.id, model.id),
    label: model.short || model.id,
    provider: provider.label,
    price: model.price,
    ms: null,
    result: null,
    error: null,
  };

  try {
    if (demoMode) {
      // 見た目だけそれらしくするために、少しだけ待つ。
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
      run.result = mockEvaluate(text, model.demo);
    } else {
      const res = await fetch(SAME_ORIGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.id,
          model: model.id,
          state: buildState(text),
          questions: buildQuestions(),
        }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(errorMessage(res.status, body));
      run.result = JSON.parse(body);
    }
  } catch (error) {
    run.error = error.message;
  }
  run.ms = Math.round(performance.now() - started);
  return run;
}

/* ---------- 描画 ---------- */

function renderRuns(runs) {
  const rows = runs.map((run) => {
    if (run.error) {
      return `<tr class="failed"><th>${esc(run.label)}<span class="model-id">${esc(run.provider ?? '')}</span></th><td colspan="5">失敗: ${esc(run.error)}</td></tr>`;
    }
    const usage = run.result?.usage || {};
    return `
      <tr>
        <th>${esc(run.label)}<span class="model-id">${esc(run.result?.model ?? '')}</span></th>
        <td>${esc(run.provider ?? '')}</td>
        <td>${ms(run.ms)}</td>
        <td>${num(usage.input_tokens)}</td>
        <td>${num(usage.output_tokens)}</td>
        <td>${run.price ? formatCost(costOf(usage, run.price)) : '—'}</td>
      </tr>`;
  });
  el.runs.innerHTML = `
    <table class="cmp">
      <thead><tr><th>モデル</th><th>提供元</th><th>時間</th><th>入力トークン</th><th>出力トークン</th><th>概算コスト</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderPairs(cmp) {
  if (!cmp.pairs.length) {
    el.pairs.innerHTML = '<p class="note">比較には 2 つ以上のモデルが要ります。</p>';
    return;
  }
  const rows = cmp.pairs.map((p) => `
    <tr>
      <th>${esc(p.labelA)} vs ${esc(p.labelB)}</th>
      <td>${p.axisMatch}/${p.axisTotal}</td>
      <td>${p.flagMatch}/${p.flagTotal}</td>
      <td>${p.meanDistance?.toFixed(2) ?? '—'}</td>
      <td>${p.meanFlagGap != null ? pct(p.meanFlagGap) : '—'}</td>
    </tr>`);
  el.pairs.innerHTML = `
    <table class="cmp">
      <thead><tr><th>組み合わせ</th><th>条件の一致</th><th>こだわりの一致</th><th>分布のずれ</th><th>確率差の平均</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderDecisiveness(cmp) {
  const rows = cmp.decisiveness.map((d) => `
    <tr>
      <th>${esc(d.label)}</th>
      <td>${pct(d.meanTop)}</td>
      <td>${d.loose}/${d.total}</td>
    </tr>`);
  el.decisiveness.innerHTML = `
    <table class="cmp">
      <thead><tr><th>モデル</th><th>最有力候補の平均確率</th><th>決めきれていない条件</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderHighlights(cmp) {
  if (!cmp.highlights.length) {
    el.highlights.innerHTML = '<p class="note">結論が食い違った項目はありませんでした（確率の付き方には差があります）。</p>';
    return;
  }
  const labelOf = (id) => cmp.done.find((r) => r.id === id)?.label ?? id;
  el.highlights.innerHTML = `<ul class="ask-list">${cmp.highlights.slice(0, 8).map((h) => `
    <li>
      <span class="ask-label">${esc(h.label)}<span class="tag">${h.kind === 'axis' ? '条件' : 'こだわり'}</span></span>
      <span class="ask-detail">${h.cells.map((c) => `${esc(labelOf(c.runId))}: ${esc(c.text)}`).join(' ／ ')}</span>
    </li>`).join('')}</ul>`;
}

// 選択肢 × モデルの確率表。バーはセルの背景にしてある。
function matrix(rows, models, { highlight }) {
  const head = models.map((m) => `<th>${esc(m.label)}</th>`).join('');
  const body = rows.map((row) => `
    <tr class="${row.className || ''}">
      <th>${esc(row.label)}</th>
      ${row.cells.map((c) => `
        <td class="p-cell ${highlight(c, row) ? 'lead' : ''}">
          <span class="p-fill" style="width:${Math.max((c.p ?? 0) * 100, 1.5)}%"></span>
          <span class="p-text">${pct(c.p)}</span>
        </td>`).join('')}
    </tr>`).join('');
  return `<table class="cmp matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderAxes(cmp) {
  const models = cmp.done;
  el.axes.innerHTML = cmp.axes.map((row) => {
    // 行（選択肢）の並びはどのモデルでも同じなので、読めたものを 1 つ拾って使う。
    const sample = row.cells.find((c) => c.read)?.read;
    const rows = (sample?.ordered || []).map((option, i) => ({
      label: option.label,
      cells: row.cells.map((cell) => ({
        p: cell.read?.ordered[i]?.p ?? 0,
        top: cell.read?.value === (cell.read?.ordered[i]?.label ?? null),
      })),
    }));
    return `
      <article class="axis">
        <header>
          <h3>${esc(row.axis.label)}</h3>
          <span class="badge ${row.agree ? 'ok' : 'warn'}">${row.agree ? '結論は一致' : '結論が割れた'}</span>
        </header>
        <p class="hint">
          ${row.cells.map((c) => `${esc(cmp.done.find((r) => r.id === c.runId)?.label)}: <strong>${esc(c.read?.value ?? '—')}</strong> ${c.read ? pct(c.read.probability) : ''}`).join(' ／ ')}
          ${row.maxDistance != null ? `／ 分布のずれ ${row.maxDistance.toFixed(2)}` : ''}
        </p>
        <div class="table-wrap">${matrix(rows, models, { highlight: (c) => c.top })}</div>
      </article>`;
  }).join('');
}

function renderFlags(cmp) {
  const rows = cmp.flags.map((row) => ({
    label: row.flag.label,
    className: row.agree ? '' : 'split',
    cells: row.cells.map((c) => ({ p: c.p, on: c.on })),
  }));
  el.flags.innerHTML = matrix(rows, cmp.done, { highlight: (c) => c.on });
}

function renderRaw(runs) {
  el.raw.innerHTML = runs.map((run) => `
    <h3>${esc(run.label)}<span class="tag">${esc(run.provider ?? '')}</span></h3>
    <pre>${esc(run.error ? run.error : JSON.stringify(run.result, null, 2))}</pre>`).join('');
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
  const chosen = selected();
  if (chosen.length < 2) {
    el.status.textContent = '比べるモデルを 2 つ以上選んでください（同じ提供元の別モデル同士でも比べられます）。';
    return;
  }

  el.run.disabled = true;
  el.status.textContent = `${chosen.map((e) => e.model.short || e.model.id).join(' / ')} に同じ質問を投げています…`;

  // 同じ質問を同時に投げる。1 つ失敗しても残りは表示する。
  const runs = await Promise.all(chosen.map((entry) => runOne(entry, text)));
  const cmp = compareRuns(runs);
  lastCompare = cmp;

  renderRuns(runs);
  renderRaw(runs);
  if (cmp.done.length >= 2) {
    renderPairs(cmp);
    renderDecisiveness(cmp);
    renderHighlights(cmp);
    renderAxes(cmp);
    renderFlags(cmp);
  } else {
    const message = '<p class="note">比較できたモデルが 1 つ以下でした。上の実行結果でエラーを確認してください。</p>';
    el.pairs.innerHTML = message;
    el.decisiveness.innerHTML = '';
    el.highlights.innerHTML = '';
    el.axes.innerHTML = '';
    el.flags.innerHTML = '';
  }

  const failed = runs.filter((r) => r.error).length;
  el.status.textContent = demoMode
    ? `デモモードの結果です（実際のモデル出力ではありません）。`
    : `${runs.length - failed} モデルから取得しました${failed ? `（${failed} 件失敗）` : ''}。`;
  el.result.hidden = false;
  el.run.disabled = false;
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  if (!lastCompare) return;
  try {
    await navigator.clipboard.writeText(compareSummaryText(lastCompare));
    el.copyNote.textContent = 'コピーしました。';
  } catch {
    el.copyNote.textContent = 'コピーできませんでした。JSON から手動で控えてください。';
  }
  setTimeout(() => (el.copyNote.textContent = ''), 3000);
});
