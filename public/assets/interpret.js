// Jev のレスポンスを「おすすめ検索条件」に読み替える部分。
// 画面（app.js）と CLI（proxy/try-jev.mjs）の両方から使う。
import { AXES, FLAGS, axesFor } from './questions.js';

export const CONF_LOW = 0.45;   // 最有力でもこれ未満なら「迷っている」扱い
export const FLAG_ON = 0.5;     // これ以上のこだわり条件はチェックを入れる
export const FLAG_MAYBE = 0.3;  // これ以上なら確認したい

export const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;

/** choice / score のどちらでも「表示ラベル・確率・順位つき候補」を同じ形にそろえる。 */
export function readAxis(axis, answer) {
  if (!answer) return null;

  if (answer.type === 'choice') {
    const ordered = Object.keys(axis.question.criteria).map((label) => ({
      label,
      p: answer.probabilities?.[label] ?? 0,
    }));
    const ranked = [...ordered].sort((a, b) => b.p - a.p);
    const value = answer.choice ?? ranked[0]?.label;
    return {
      kind: 'choice',
      value,
      probability: answer.probabilities?.[value] ?? 0,
      confidence: answer.confidence,
      ranked,
      ordered,
    };
  }

  const levels = axis.question.criteria;
  const labelOf = (i) => answer.legend?.[String(i)] ?? levels[i];
  const ordered = levels.map((_, i) => ({ index: i, label: labelOf(i), p: answer.probabilities?.[String(i)] ?? 0 }));
  const ranked = [...ordered].sort((a, b) => b.p - a.p);

  // おすすめ値は最も確率の高いレベル。ただし分布がほぼ平らなときは先頭のレベルを
  // 引いてしまうので、上位が拮抗している場合は期待値に近いほうを採る。
  const expected = answer.score ?? ordered.reduce((acc, o) => acc + o.p * o.index, 0);
  const best = ordered
    .filter((o) => o.p >= (ranked[0]?.p ?? 0) - 0.01)
    .reduce((a, b) => (Math.abs(b.index - expected) < Math.abs(a.index - expected) ? b : a));

  return {
    kind: 'score',
    value: best.label,
    probability: best.p,
    confidence: answer.confidence,
    score: answer.score,
    ranked,
    ordered,
  };
}

/**
 * レスポンス全体を読み取る。
 * axes は「取引の種類」の判定に合わせて絞り込んだ軸（賃貸なら賃料、購入なら価格）。
 */
export function interpret(result) {
  const answers = result?.answers || {};
  const reads = {};
  for (const axis of AXES) reads[axis.id] = readAxis(axis, answers[axis.id]);
  const flagRows = FLAGS
    .map((flag) => ({ flag, p: answers[`flag_${flag.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return { reads, flagRows, axes: axesFor(reads.torihiki?.value) };
}

/** 確率が割れていて、追加で聞きたい項目。 */
export function openQuestions({ reads, flagRows, axes = AXES }) {
  const items = [];
  for (const axis of axes) {
    const read = reads[axis.id];
    if (!read || read.probability >= CONF_LOW) continue;
    items.push({ kind: 'axis', label: axis.label, first: read.ranked[0], second: read.ranked[1] });
  }
  for (const { flag, p } of flagRows) {
    if (p >= FLAG_MAYBE && p < FLAG_ON) items.push({ kind: 'flag', label: flag.label, p });
  }
  return items;
}

/** コピー用のテキストメモ。 */
export function summaryText({ reads, flagRows, axes = AXES }) {
  const lines = ['【おすすめ検索条件】'];
  for (const axis of axes) {
    const read = reads[axis.id];
    if (read) lines.push(`- ${axis.label}: ${read.value}（${pct(read.probability)}）`);
  }
  const on = flagRows.filter((r) => r.p >= FLAG_ON);
  lines.push('', '【チェックを入れる条件】');
  lines.push(on.length ? on.map(({ flag, p }) => `- ${flag.label}（${pct(p)}）`).join('\n') : '- なし');
  return lines.join('\n');
}
