// デモモード用のダミー推論（エリアページ）。
//
// Jev の API キーが無いところでも画面を触れるようにするためのもので、中身はキーワード
// マッチ。ここで駅にひもづけている性格づけ（下の PROFILES）は**デモの中だけの都合**で、
// Jev へのリクエストには一切入らない。実 API のときは駅名しか渡していない。
import { STATIONS } from './area-stations.js';
import { AXES } from './area-questions.js';

// キーワードに反応して加点する駅のまとまり。デモ専用のごく粗い当て込み。
const PROFILES = [
  {
    keys: ['都心', '職場の近く', '通勤時間を短く', '通勤を短く', '繁華街', '外食', '終電', '夜遅く'],
    stations: ['渋谷', '新宿', '池袋', '六本木', '麻布十番', '表参道', '恵比寿', '中目黒', '田町', '日本橋', '四ツ谷', '五反田'],
  },
  {
    keys: ['子育て', '保育園', '幼稚園', '学区', '子ども', '公園', '静か', '治安'],
    stations: ['吉祥寺', '成城学園前', '二子玉川', '国分寺', 'たまプラーザ', '青葉台', '日吉', '浦和', '武蔵境', '府中', '流山おおたかの森', '武蔵浦和'],
  },
  {
    keys: ['家賃を抑え', '安く', '予算', '余裕がない', '手ごろ', '節約'],
    stations: ['川口', '西川口', '蕨', '南越谷', '松戸', '本八幡', '市川', '葛西', '八千代緑が丘', '春日部', '稲毛', '大泉学園'],
  },
  {
    keys: ['自然', '広い', 'のんびり', 'リモート', 'フルリモート', '移住', '海', '山', '庭'],
    stations: ['藤沢', '辻堂', '鎌倉', '八王子', '多摩センター', '海老名', '本厚木', '中央林間', '越谷レイクタウン', '川越', '所沢', '大船'],
  },
  {
    keys: ['下町', '商店街', '飲み屋', '人情', 'にぎやか'],
    stations: ['北千住', '錦糸町', '押上', '蒲田', '大森', '巣鴨', '赤羽', '高円寺', '三軒茶屋', '下北沢', '武蔵小山', '門前仲町'],
  },
  {
    keys: ['一人暮らし', '単身', '初めて', '社会人'],
    stations: ['中野', '高円寺', '荻窪', '高田馬場', '下北沢', '三軒茶屋', '武蔵小山', '練馬', '調布', '川崎', '大森', '本八幡'],
  },
  {
    keys: ['横浜', '神奈川', '川崎'],
    stations: ['横浜', '川崎', '武蔵小杉', '新横浜', 'みなとみらい', '関内', '上大岡', '日吉', '戸塚', '溝の口'],
  },
  {
    keys: ['大宮', '埼玉', '池袋'],
    stations: ['大宮', '浦和', '武蔵浦和', '和光市', '朝霞台', '志木', '川越', '所沢', '練馬', '赤羽'],
  },
  {
    keys: ['千葉', '船橋', '東京駅', '大手町'],
    stations: ['船橋', '西船橋', '津田沼', '市川', '浦安', '新浦安', '海浜幕張', '本八幡', '豊洲', '錦糸町'],
  },
];

// 駅名から作る固定のゆらぎ。実行のたびに順位が変わらないようにしておく。
const jitter = (name) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 997;
  return h / 997;
};

const hits = (text, keys) => keys.reduce((acc, k) => (text.includes(k) ? acc + 1 : acc), 0);

const round = (n, digits = 3) => Number(n.toFixed(digits));

function softmax(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

// 補助質問（AXES）用。どの選択肢・レベルに寄せるかのキーワード。
const AXIS_HINTS = {
  kyori: { 0: ['都心', '職場の近く'], 1: ['通勤時間を短く', '15分'], 2: ['30分'], 3: ['45分', '40分'], 4: ['1時間', '60分'], 5: ['リモート', '移住', '通勤はほぼ'] },
  seikaku: {
    '繁華街・都心の利便性': ['都心', '繁華街', '外食', '便利'],
    '落ち着いた住宅地': ['静か', '子育て', '住宅地', '治安'],
    '下町・商店街のにぎわい': ['下町', '商店街', '飲み屋'],
    '郊外・自然の近さ': ['自然', '郊外', '広い', '移住', 'リモート'],
  },
  souba: { 0: ['安く', '余裕がない'], 1: ['家賃を抑え', '節約'], 2: ['バランス'], 3: ['多少高くても'], 4: ['予算は柔軟', '相場は気にしない'] },
  jushi: {
    '通勤・通学の短さ': ['通勤時間を短く', '職場の近く', '通勤'],
    '家賃・価格の安さ': ['家賃を抑え', '安く', '予算', '余裕がない'],
    '子育て・住環境': ['子育て', '保育園', '学区', '公園'],
    '買い物・街の便利さ': ['買い物', 'スーパー', '商店街', '便利'],
    '静けさ・落ち着き': ['静か', '落ち着'],
  },
};

export function mockAreaEvaluate(text) {
  const answers = {};

  // 駅: 反応したプロファイルの数で加点し、0〜1 に収める。
  const boost = new Map();
  for (const profile of PROFILES) {
    const n = hits(text, profile.keys);
    if (!n) continue;
    for (const name of profile.stations) boost.set(name, (boost.get(name) ?? 0) + n);
  }
  for (const station of STATIONS) {
    const b = boost.get(station.name) ?? 0;
    const base = 0.06 + jitter(station.name) * 0.14;
    answers[station.id] = { type: 'noul', noul: round(Math.min(base + b * 0.22, 0.96)) };
  }

  // 補助質問
  for (const axis of AXES) {
    const q = axis.question;
    const table = AXIS_HINTS[axis.id] || {};
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const weights = softmax(options.map((o) => 1 + 2.4 * hits(text, table[o] || [])));
      const probabilities = {};
      options.forEach((o, i) => (probabilities[o] = round(weights[i])));
      answers[axis.id] = {
        type: 'choice',
        choice: options[weights.indexOf(Math.max(...weights))],
        probabilities,
        confidence: round(Math.max(...weights)),
      };
    } else {
      const levels = q.criteria;
      const weights = softmax(levels.map((_, i) => 1 + 2.4 * hits(text, table[i] || [])));
      const probabilities = {};
      const legend = {};
      levels.forEach((label, i) => {
        probabilities[String(i)] = round(weights[i]);
        legend[String(i)] = label;
      });
      answers[axis.id] = {
        type: 'score',
        score: round(weights.reduce((acc, w, i) => acc + w * i, 0)),
        legend,
        probabilities,
        confidence: round(Math.max(...weights)),
      };
    }
  }

  return { model: 'demo-keyword-matcher', answers, usage: { input_tokens: 0, output_tokens: 0 }, _demo: true };
}
