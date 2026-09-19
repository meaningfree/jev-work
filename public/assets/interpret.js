// Jev のレスポンスを「おすすめ検索条件」に読み替える部分。
// 画面（app.js）と CLI（proxy/try-jev.mjs）の両方から使う。
import { AXES, FLAGS } from './questions.js';

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
  const ordered = levels.map((_, i) => ({ label: labelOf(i), p: answer.probabilities?.[String(i)] ?? 0 }));
  // おすすめ値は最も確率の高いレベル（期待値の丸めだと確率の低いレベルを指すことがある）。
  // 期待値のほうは score として併記する。
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

/** レスポンス全体を読み取る。 */
export function interpret(result) {
  const answers = result?.answers || {};
  const reads = {};
  for (const axis of AXES) reads[axis.id] = readAxis(axis, answers[axis.id]);
  const flagRows = FLAGS
    .map((flag) => ({ flag, p: answers[`flag_${flag.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.p - a.p);
  return { reads, flagRows };
}

/** 確率が割れていて、追加で聞きたい項目。 */
export function openQuestions({ reads, flagRows }) {
  const items = [];
  for (const axis of AXES) {
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
export function summaryText({ reads, flagRows }) {
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
