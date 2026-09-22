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
  { id: 'jev', label: 'Jev（デモ）', model: 'demo-keyword-matcher', configured: true, demo: { jitter: 0, sharpen: 1, label: 'demo-jev' } },
  { id: 'openai', label: 'OpenAI（デモ）', model: 'demo-sharpened', configured: true, demo: { jitter: 0.5, sharpen: 2.4, label: 'demo-openai' } },
  { id: 'gemini', label: 'Gemini（デモ）', model: 'demo-jittered', configured: true, demo: { jitter: 0.8, sharpen: 1.4, label: 'demo-gemini' } },
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

let providers = [];
let demoMode = false;
let lastCompare = null;

/* ---------- 接続先とモデル一覧 ---------- */

async function resolveProviders() {
  try {
    const res = await fetch(SAME_ORIGIN, { method: 'GET' });
    const body = res.ok ? await res.json() : null;
    if (body?.service !== 'jev-proxy' || !Array.isArray(body.providers)) throw new Error('no proxy');
    const usable = body.providers.filter((p) => p.configured);
    if (!usable.length) throw new Error('no key');
    providers = body.providers;
    demoMode = false;
  } catch {
    providers = DEMO_PROVIDERS;
    demoMode = true;
  }
  renderPicker();
}

function renderPicker() {
  el.picker.innerHTML = providers
    .map((p) => `
      <label class="model-opt ${p.configured ? '' : 'off'}" title="${esc(p.note ?? '')}">
        <input type="checkbox" value="${esc(p.id)}" ${p.configured ? 'checked' : 'disabled'} />
        <span class="model-name">${esc(p.label)}</span>
        <span class="model-id">${esc(p.model)}</span>
        ${p.configured ? '' : '<span class="model-id">キー未設定</span>'}
      </label>`)
    .join('');

  const usable = providers.filter((p) => p.configured).length;
  el.pickerNote.textContent = demoMode
    ? '中継が見つからないのでデモモードです。表示されるのは実際のモデルの出力ではなく、画面確認用のダミーです。'
    : usable < 2
      ? '比較には 2 つ以上のキーが要ります。OPENAI_API_KEY / GEMINI_API_KEY を Worker のシークレット（ローカルなら .dev.vars）に足すと選べるようになります。'
      : providers.some((p) => !p.configured)
        ? 'キーが設定されていないモデルは選べません（シークレットに追加すると出てきます）。'
        : '';
}

const selected = () =>
  [...el.picker.querySelectorAll('input:checked')].map((i) => providers.find((p) => p.id === i.value));

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

async function runOne(provider, text) {
  const started = performance.now();
  const run = { id: provider.id, label: provider.label, price: provider.price, ms: null, result: null, error: null };

  try {
    if (demoMode) {
      // 見た目だけそれらしくするために、少しだけ待つ。
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
      run.result = mockEvaluate(text, provider.demo);
    } else {
      const res = await fetch(SAME_ORIGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.id,
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
      return `<tr class="failed"><th>${esc(run.label)}</th><td colspan="4">失敗: ${esc(run.error)}</td></tr>`;
    }
    const usage = run.result?.usage || {};
    return `
      <tr>
        <th>${esc(run.label)}<span class="model-id">${esc(run.result?.model ?? '')}</span></th>
        <td>${ms(run.ms)}</td>
        <td>${num(usage.input_tokens)}</td>
        <td>${num(usage.output_tokens)}</td>
        <td>${run.price ? formatCost(costOf(usage, run.price)) : '—'}</td>
      </tr>`;
  });
  el.runs.innerHTML = `
    <table class="cmp">
      <thead><tr><th>モデル</th><th>時間</th><th>入力トークン</th><th>出力トークン</th><th>概算コスト</th></tr></thead>
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
    <h3>${esc(run.label)}</h3>
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
    el.status.textContent = '比べるモデルを 2 つ以上選んでください。';
    return;
  }

  el.run.disabled = true;
  el.status.textContent = `${chosen.map((p) => p.label).join(' / ')} に同じ質問を投げています…`;

  // 同じ質問を同時に投げる。1 つ失敗しても残りは表示する。
  const runs = await Promise.all(chosen.map((provider) => runOne(provider, text)));
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
