// 同じ入力・同じ質問を複数のモデルに投げた結果を突き合わせる部分。
// 画面（compare-app.js）と CLI（proxy/try-compare.mjs）の両方から使う。
//
// 見たいのは「どの答えが正しいか」ではなく、
//   1. 最有力の答えが一致するか（順位レベルの一致）
//   2. 確率の付き方がどれくらい違うか（分布レベルの距離）
//   3. 迷い方が違うか（Jev は割れるのに生成モデルは 1 つに振り切る、など）
// の 3 点。1 は一致率、2 は total variation distance、3 は最有力の確率で見る。
import { AXES, FLAGS, axesFor } from './questions.js';
import { readAxis, pct, FLAG_ON, CONF_LOW } from './interpret.js';

export { pct, FLAG_ON, CONF_LOW };

/** 分布どうしの距離。0 なら完全一致、1 なら重なりゼロ。 */
export function totalVariation(a, b) {
  if (!a || !b) return null;
  const sum = a.ordered.reduce((acc, row, i) => acc + Math.abs(row.p - (b.ordered[i]?.p ?? 0)), 0);
  return sum / 2;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pairsOf = (xs) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]));

/** 入力トークン・出力トークンと単価から概算コスト（USD）を出す。 */
export function costOf(usage, price) {
  if (!usage || !price) return null;
  const input = ((usage.input_tokens || 0) / 1e6) * price.input;
  const output = ((usage.output_tokens || 0) / 1e6) * price.output;
  return input + output;
}

export const formatCost = (usd) => (usd == null ? '—' : `$${usd.toFixed(6)}`);

/**
 * runs: [{ id, label, provider, price, ms, result, error }]
 * result は Jev 形式のレスポンス（OpenAI / Gemini もプロキシ側でこの形に直している）。
 */
export function compareRuns(runs) {
  const done = runs.filter((run) => run.result && !run.error);

  // 各モデルの読み取り結果。軸の絞り込み（賃貸なら賃料 / 購入なら価格）は
  // モデルごとに判断が割れうるので、表示する軸は和集合にする。
  const readsOf = new Map();
  for (const run of done) {
    const answers = run.result.answers || {};
    const reads = {};
    for (const axis of AXES) reads[axis.id] = readAxis(axis, answers[axis.id]);
    readsOf.set(run.id, reads);
  }

  const shown = new Set();
  for (const run of done) {
    for (const axis of axesFor(readsOf.get(run.id).torihiki?.value)) shown.add(axis.id);
  }

  const axes = AXES.filter((axis) => shown.has(axis.id)).map((axis) => {
    const cells = done.map((run) => ({ runId: run.id, read: readsOf.get(run.id)[axis.id] }));
    const values = cells.map((c) => c.read?.value);
    const distances = pairsOf(cells).map(([a, b]) => totalVariation(a.read, b.read)).filter((d) => d != null);
    return {
      axis,
      cells,
      agree: values.every((v) => v != null && v === values[0]),
      maxDistance: distances.length ? Math.max(...distances) : null,
    };
  });

  const flags = FLAGS.map((flag) => {
    const cells = done.map((run) => {
      const p = run.result.answers?.[`flag_${flag.id}`]?.noul ?? 0;
      return { runId: run.id, p, on: p >= FLAG_ON };
    });
    const ps = cells.map((c) => c.p);
    return {
      flag,
      cells,
      agree: cells.every((c) => c.on === cells[0].on),
      spread: ps.length ? Math.max(...ps) - Math.min(...ps) : 0,
    };
  }).sort((a, b) => b.spread - a.spread);

  // モデル 2 つずつの突き合わせ。3 モデルなら 3 組になる。
  const pairs = pairsOf(done).map(([a, b]) => {
    const axisPairs = axes
      .map((row) => ({
        axis: row.axis,
        a: row.cells.find((c) => c.runId === a.id)?.read,
        b: row.cells.find((c) => c.runId === b.id)?.read,
      }))
      .filter((x) => x.a && x.b);
    const flagPairs = flags
      .map((row) => ({
        flag: row.flag,
        a: row.cells.find((c) => c.runId === a.id),
        b: row.cells.find((c) => c.runId === b.id),
      }))
      .filter((x) => x.a && x.b);

    return {
      a: a.id,
      b: b.id,
      labelA: a.label,
      labelB: b.label,
      axisMatch: axisPairs.filter((x) => x.a.value === x.b.value).length,
      axisTotal: axisPairs.length,
      flagMatch: flagPairs.filter((x) => x.a.on === x.b.on).length,
      flagTotal: flagPairs.length,
      meanDistance: mean(axisPairs.map((x) => totalVariation(x.a, x.b))),
      meanFlagGap: mean(flagPairs.map((x) => Math.abs(x.a.p - x.b.p))),
    };
  });

  // 「1 つに振り切るモデル / 迷いを確率に残すモデル」を見るための指標。
  const decisiveness = done.map((run) => {
    const reads = readsOf.get(run.id);
    const tops = axes.map((row) => reads[row.axis.id]?.probability).filter((p) => p != null);
    return {
      runId: run.id,
      label: run.label,
      meanTop: mean(tops),
      loose: tops.filter((p) => p < CONF_LOW).length,
      total: tops.length,
    };
  });

  // 食い違いが大きい順。まずここだけ見れば差が分かるようにしておく。
  const highlights = [
    ...axes.filter((row) => !row.agree).map((row) => ({
      kind: 'axis',
      label: row.axis.label,
      gap: row.maxDistance ?? 0,
      cells: row.cells.map((c) => ({ runId: c.runId, text: c.read ? `${c.read.value}（${pct(c.read.probability)}）` : '—' })),
    })),
    ...flags.filter((row) => !row.agree).map((row) => ({
      kind: 'flag',
      label: row.flag.label,
      gap: row.spread,
      cells: row.cells.map((c) => ({ runId: c.runId, text: `${c.on ? '入れる' : '入れない'}（${pct(c.p)}）` })),
    })),
  ].sort((a, b) => b.gap - a.gap);

  return { runs, done, axes, flags, pairs, decisiveness, highlights };
}

/** コピー用・CLI 用のテキスト。 */
export function compareSummaryText(cmp) {
  const lines = ['【モデル比較】', ''];

  lines.push('■ 実行したモデル');
  for (const run of cmp.runs) {
    if (run.error) {
      lines.push(`- ${run.label}: 失敗（${run.error}）`);
      continue;
    }
    const usage = run.result?.usage || {};
    lines.push(
      `- ${run.label}（${run.result?.model ?? '?'}）: ${run.ms}ms / ` +
      `入力 ${usage.input_tokens ?? '?'}・出力 ${usage.output_tokens ?? 0} トークン / ` +
      `${formatCost(costOf(usage, run.price))}`,
    );
  }

  lines.push('', '■ 一致率');
  for (const pair of cmp.pairs) {
    lines.push(
      `- ${pair.labelA} vs ${pair.labelB}: 条件 ${pair.axisMatch}/${pair.axisTotal} 一致 / ` +
      `こだわり ${pair.flagMatch}/${pair.flagTotal} 一致 / 分布のずれ ${pair.meanDistance?.toFixed(2) ?? '—'}`,
    );
  }

  lines.push('', '■ 条件ごとの答え');
  for (const row of cmp.axes) {
    const cells = row.cells
      .map((c) => `${cmp.done.find((r) => r.id === c.runId)?.label}=${c.read ? `${c.read.value} ${pct(c.read.probability)}` : '—'}`)
      .join(' / ');
    lines.push(`- ${row.axis.label}${row.agree ? '' : ' ★割れ'}: ${cells}`);
  }

  lines.push('', '■ 確率の振り切り方（最有力候補の平均確率）');
  for (const d of cmp.decisiveness) {
    lines.push(`- ${d.label}: ${pct(d.meanTop)}（決めきれていない条件 ${d.loose}/${d.total}）`);
  }

  return lines.join('\n');
}
