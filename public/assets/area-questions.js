// 「住むのにおすすめのエリア（駅）」を Jev に選ばせるための質問定義。
//
// 検索条件ページ（questions.js）との違いは、軸ではなく駅そのものを質問にするところ。
// 100 駅それぞれを noul（はい/いいえの確率）で評価させ、返ってきた確率で並べ替える。
// choice で 100 択にしないのは、
//   - 確率が 100 分割されて差が読めなくなる
//   - 「どれも合わない」「どれも悪くない」が表現できない
// ため。駅ごとに独立した 0〜1 が返るほうが、順位も温度感も読める。
//
// ★ 質問文に入れるのは駅名だけ。沿線・所要時間・相場・自治体は一切渡さない。
//   「駅名だけで Jev がどこまで判断できるか」を見るのがこのページの目的。
import { STATIONS } from './area-stations.js';

// 全駅で同じ文面を使う。駅ごとに書き分けると、その文面自体が
// 駅の特徴を教えるヒントになってしまい、実験にならない。
export const STATION_CRITERIA = {
  true:
    'この人の通勤・予算・世帯構成・求めている環境に照らして、その駅の周辺に住むことを積極的にすすめられる',
  false:
    '通勤が現実的でない、家賃や価格の相場が合わない、求めている環境と違うなど、すすめにくい理由がある',
};

/** 駅 1 つ分の質問。渡しているのが駅名だけであることがひと目で分かるようにしてある。 */
export function stationQuestion(station) {
  return {
    type: 'noul',
    instructions: `「${station.name}」駅の周辺は、この人が住む場所としておすすめできますか？`,
    criteria: STATION_CRITERIA,
  };
}

// 駅の並びとは別に、ヒアリング文そのものの見立ても取っておく。
// 上位に出た駅が妥当かを人間が判断するための材料で、駅の選定には使っていない。
export const AXES = [
  {
    id: 'kyori',
    label: '都心までの距離感',
    hint: 'どこまで離れてよいか',
    question: {
      type: 'score',
      instructions:
        '通勤・通学や普段の行き先から、都心（東京駅・新宿駅あたり）までの所要時間をどこまで許容できるか判断してください。前のレベルほど都心に近いことが必須、後のレベルほど離れていても構わないことを表します。',
      criteria: [
        '都心の中心部',
        '都心まで15分以内',
        '都心まで30分以内',
        '都心まで45分以内',
        '都心まで60分以内',
        '都心まで60分超でも可',
      ],
    },
  },
  {
    id: 'seikaku',
    label: '街の性格',
    question: {
      type: 'choice',
      instructions: 'この人が暮らしたい街の性格として、最も近いものを判断してください。',
      criteria: {
        '繁華街・都心の利便性': '仕事や遊びの中心に近いこと、店や交通の多さを重視している',
        '落ち着いた住宅地': '静かさ・治安・子育て環境を重視した住宅街を求めている',
        '下町・商店街のにぎわい': '生活感のある商店街、物価の手ごろさ、人の近さを求めている',
        '郊外・自然の近さ': '緑や広さ、ゆったりした環境を重視し、都心からの距離は気にしない',
      },
    },
  },
  {
    id: 'souba',
    label: '狙う相場の水準',
    hint: '首都圏の中でどのあたりか',
    question: {
      type: 'score',
      instructions:
        'この人が現実的に払える水準から、首都圏の中でどのくらいの相場のエリアを狙うべきか判断してください。前のレベルほど相場の安いエリア、後のレベルほど相場の高いエリアを表します。',
      criteria: [
        '相場のかなり安いエリア',
        '相場の安いエリア',
        '平均的な相場のエリア',
        'やや高い相場のエリア',
        '相場の高いエリア',
      ],
    },
  },
  {
    id: 'jushi',
    label: 'エリア選びで最優先すること',
    hint: '条件がぶつかったとき何を守るか',
    question: {
      type: 'choice',
      instructions: 'エリアを選ぶときに、この人が最後まで譲れないものはどれか判断してください。',
      criteria: {
        '通勤・通学の短さ': null,
        '家賃・価格の安さ': null,
        '子育て・住環境': null,
        '買い物・街の便利さ': null,
        '静けさ・落ち着き': null,
      },
    },
  },
];

/** 自由入力文を state に整形する。 */
export function buildAreaState(text) {
  return {
    role: '首都圏で住むエリア（最寄り駅）を探している人のヒアリングメモ',
    note: '書かれていないことは推測してよいが、確信が持てない場合は確率を割り振ってよい。',
    hearing: text,
  };
}

// 1 リクエストあたりの駅数。104 問（補助質問 4 + 駅 100）を 1 回で投げて通ることは
// 実測で確認済み（16,525 トークン / 573ms / jev-1.13.0）なので既定は分割なし。
// 質問数の上限に当たったら、この値を下げれば分割して投げる。
// 分割しても state と criteria の文面は同じなので、確率は横並びで比較できる
// （ただし state が回数分課金されるので、分割したほうが少し高くつく）。
export const CHUNK_SIZE = 100;

const chunk = (items, size) =>
  items.reduce((acc, item, i) => {
    if (i % size === 0) acc.push([]);
    acc[acc.length - 1].push(item);
    return acc;
  }, []);

/**
 * Jev に投げるリクエストボディの配列を作る。
 * 補助質問（AXES）は最初のリクエストにだけ載せる。
 */
export function buildAreaRequests(text) {
  const state = buildAreaState(text);
  return chunk(STATIONS, CHUNK_SIZE).map((group, index) => {
    const questions = {};
    if (index === 0) for (const axis of AXES) questions[axis.id] = axis.question;
    for (const station of group) questions[station.id] = stationQuestion(station);
    return { model: 'jev-latest', state, questions };
  });
}

/** 分割して投げたレスポンスを 1 つにまとめる。 */
export function mergeResults(results) {
  const merged = { model: results[0]?.model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  for (const result of results) {
    Object.assign(merged.answers, result?.answers || {});
    merged.usage.input_tokens += result?.usage?.input_tokens ?? 0;
    merged.usage.output_tokens += result?.usage?.output_tokens ?? 0;
    if (result?._demo) merged._demo = true;
  }
  return merged;
}
