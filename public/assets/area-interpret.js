// エリアページのレスポンス読み取り。画面（area-app.js）と CLI（proxy/try-area.mjs）で共用する。
import { PREFS, STATIONS } from './area-stations.js';
import { AXES } from './area-questions.js';
import { readAxis, pct } from './interpret.js';

export { pct };

export const TOP_N = 12;   // 「おすすめ」として前に出す駅数

// 確率の絶対値は入力によってまるごと上下する（実測: 都心志向の相談だと最高 49% /
// 中央値 25%、郊外志向だと最高 71% / 中央値 58% になった）。
// 「0.5 以上ならおすすめ」のような固定のしきい値では読めないので、
// 100駅の中での相対位置（四分位）で強調する。表示する % は Jev が返した値そのまま。
const percentile = (sorted, ratio) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * ratio;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * 駅の並べ替えと、補助質問の読み取り。
 *
 * stats は「Jev が駅名だけで差をつけられているか」を見るための数字。
 * 全駅が同じような確率に張り付いていたら、そもそも判断できていないということになる。
 */
export function interpretArea(result) {
  const answers = result?.answers || {};

  const raw = STATIONS.map((station) => ({ ...station, p: answers[station.id]?.noul ?? 0 }));
  const values = raw.map((r) => r.p).sort((a, b) => a - b);
  const min = values[0] ?? 0;
  const max = values[values.length - 1] ?? 0;
  const q25 = percentile(values, 0.25);
  const q75 = percentile(values, 0.75);
  const span = max - min;

  // tier は 100駅の中での相対位置。確率の絶対値が入力ごとに上下しても、
  // 「上位1/4か、下位1/4か」は同じ意味で読める。
  const rows = raw.map((row) => ({
    ...row,
    tier: row.p >= q75 ? 'strong' : row.p <= q25 ? 'weak' : '',
  }));

  const ranked = [...rows].sort((a, b) => b.p - a.p);

  const axes = AXES.map((axis) => ({ axis, read: readAxis(axis, answers[axis.id]) }))
    .filter((entry) => entry.read);

  const byPref = PREFS.map((pref) => ({
    pref,
    rows: rows.filter((r) => r.pref === pref).sort((a, b) => b.p - a.p),
  }));

  return {
    rows,
    ranked,
    top: ranked.slice(0, TOP_N),
    byPref,
    axes,
    stats: {
      count: rows.length,
      answered: rows.filter((r) => answers[r.id]).length,
      max, min, q25, q75, span,
      median: percentile(values, 0.5),
    },
  };
}

/** 上位の駅が特定の都県に寄っているか（都心寄り／郊外寄りの偏りを一言で出す）。 */
export function topPrefSummary({ top }) {
  const counts = new Map();
  for (const row of top) counts.set(row.pref, (counts.get(row.pref) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pref, n]) => `${pref} ${n}駅`)
    .join(' / ');
}

/**
 * 駅名だけで差がついているかの所見。
 * 幅が狭いと、Jev がこの入力では駅を区別できていない（＝結果を信じる意味が薄い）。
 */
export function spreadNote({ stats }) {
  if (stats.span >= 0.3) return '駅ごとにはっきり差がついています。';
  if (stats.span >= 0.15) return '差はついていますが、上位と下位の幅は狭めです。';
  return 'どの駅もほぼ同じ評価です。入力からは駅を絞りきれていない可能性があります。';
}

/** コピー用のテキストメモ。 */
export function areaSummaryText(interpreted) {
  const lines = ['【住むのにおすすめのエリア】'];
  interpreted.top.forEach((row, i) => {
    lines.push(`${String(i + 1).padStart(2, ' ')}. ${row.name}（${row.pref}） ${pct(row.p)}`);
  });
  lines.push('', '【Jev の見立て】');
  for (const { axis, read } of interpreted.axes) {
    lines.push(`- ${axis.label}: ${read.value}（${pct(read.probability)}）`);
  }
  const { count, max, median, min } = interpreted.stats;
  lines.push('', `※ ${count}駅の評価: 最高 ${pct(max)} / 中央値 ${pct(median)} / 最低 ${pct(min)}`);
  lines.push(`※ ${spreadNote(interpreted)}確率の絶対値は入力ごとに上下するので、順位で見てください。`);
  return lines.join('\n');
}
