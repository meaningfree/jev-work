// live.html（フォームを変えるたびに検索条件を出し直す画面）で使う質問セット。
//
// 入力が変わるたびに Jev を叩くので、index.html の 26 問から
// 「ポータルの絞り込みで最初に触る項目」だけに減らしてある。
// 質問の文面そのものは questions.js と共通（同じ id をそのまま拾っている）。
import { AXES, FLAGS, buildQuestions } from './questions.js';

const AXIS_IDS = ['torihiki', 'madori', 'yachin', 'kakaku', 'eki_toho', 'chikunensu'];
const FLAG_IDS = ['pet', 'parking', 'autolock', 'ev', 'school', 'soku'];

export const LIVE_AXES = AXIS_IDS.map((id) => AXES.find((axis) => axis.id === id));
export const LIVE_FLAGS = FLAG_IDS.map((id) => FLAGS.find((flag) => flag.id === id));

/** Jev に投げる questions マップ（12 問）。 */
export function buildLiveQuestions() {
  const all = buildQuestions();
  const questions = {};
  for (const axis of LIVE_AXES) questions[axis.id] = all[axis.id];
  for (const flag of LIVE_FLAGS) questions[`flag_${flag.id}`] = all[`flag_${flag.id}`];
  return questions;
}

/** 取引の種類（賃貸/購入）に応じて、表示する軸を絞る。 */
export function liveAxesFor(torihiki) {
  return LIVE_AXES.filter((axis) => !axis.appliesTo || axis.appliesTo === torihiki);
}

/**
 * フォームの値を 1 本のヒアリングメモにまとめる。
 * Jev にはこのメモを state.hearing として渡す（index.html の自由入力と同じ扱い）。
 * 空欄の項目は書かない（「未定」と書くとそれ自体が手がかりとして読まれてしまうため）。
 */
export function composeHearing(form) {
  const lines = [];
  if (form.household) lines.push(`世帯: ${form.household}`);
  if (form.intent) lines.push(`住まいの持ち方: ${form.intent}`);
  if (form.budget) lines.push(`予算: ${form.budget}`);
  if (form.work) lines.push(`職場・よく行く場所: ${form.work}`);
  if (form.commute) lines.push(`通勤・移動: ${form.commute}`);
  if (form.timing) lines.push(`住み替えの時期: ${form.timing}`);
  if (form.life.length) lines.push(`暮らしの事情: ${form.life.join('、')}`);
  if (form.memo) lines.push(`そのほか: ${form.memo}`);
  return lines.join('\n');
}
