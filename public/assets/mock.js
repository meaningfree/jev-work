// デモモード用のダミー推論。
// Jev の API キーがまだ無い状態でも UI を触れるようにするためのもので、
// 中身は単純なキーワードマッチ。レスポンスの形だけ Jev に合わせてある。
import { AXES, FLAGS } from './questions.js';

// choice 軸: 選択肢 -> 加点キーワード
const CHOICE_HINTS = {
  torihiki: {
    賃貸: ['賃貸', '家賃', '転勤', '単身赴任', '仮住まい', '更新', '引っ越しやすい'],
    購入: ['購入を検討', '購入', '買いたい', 'マイホーム', '住宅ローン', '資産', '持ち家', '終の棲家', '定住'],
  },
  tatemono: {
    マンション: ['マンション', '駅近', 'セキュリティ', 'オートロック', '管理', 'タワー'],
    アパート: ['アパート', '家賃を抑え', '初めての一人暮らし'],
    一戸建て: ['戸建', '一戸建て', '庭', '平屋', 'ピアノ', '楽器', '二世帯', '子どもを走らせ'],
    土地: ['土地', '注文住宅', '建てたい', '設計'],
  },
  madori: {
    ワンルーム: ['ワンルーム', '1R'],
    '1K・1DK': ['1K', '一人暮らし', '単身'],
    '1LDK': ['2人暮らし', 'ふたり暮らし', '夫婦2人', '同棲', '新婚'],
    '2K・2DK': ['2DK', '2K'],
    '2LDK': ['2LDK', '子どもが1人', '子ども1人', '書斎', 'もう1部屋'],
    '3K・3DK': ['3DK', '3K'],
    '3LDK': ['3LDK', '子ども2人', '子どもが2人', '家族4人', '4人家族', '手狭'],
    '4LDK以上': ['二世帯', '親と同居', '子ども3人', '4LDK', '5人家族'],
  },
  area_type: {
    '都心・ターミナル駅周辺': ['都心', '職場の近く', '通勤時間を短く', '便利', '駅前', '渋谷', '新宿'],
    '都心から電車30分圏': ['30分', 'バランス', '沿線', '40分'],
    '電車45〜60分の郊外': ['郊外', '静か', '子育て', '公園', '住宅地', '1時間'],
    '車移動前提の郊外・地方': ['自然', '移住', '地方', '海', '山', 'のんびり', 'リモート', 'フルリモート'],
  },
  saiyusen: {
    '賃料・価格': ['予算', '安く', '家賃を抑え', 'ローンが不安', '費用', '余裕がない'],
    '広さ・間取り': ['広い', '手狭', '狭い', '部屋数', '収納が足りない'],
    '駅からの近さ': ['駅近', '通勤時間を短く', '徒歩5分'],
    '住環境・子育て': ['子育て', '学区', '保育園', '静かな', '公園'],
    '築年数・設備': ['新築', '築浅', 'きれい', '設備', '食洗機', '断熱'],
  },
};

// score 軸: レベル index -> 加点キーワード
const SCORE_HINTS = {
  yachin: {
    0: ['家賃を抑え', '安く', '6万'],
    1: ['8万', '一人暮らし'],
    2: ['10万'],
    3: ['12万', '夫婦'],
    4: ['15万'],
    5: ['20万'],
    6: ['予算は柔軟', '多少高くても'],
  },
  kakaku: {
    0: ['2000万', '2,000万'],
    1: ['3000万', '3,000万', '予算はあまり余裕がない'],
    2: ['4000万', '4,000万'],
    3: ['5000万', '5,000万'],
    4: ['6000万', '6,000万'],
    5: ['8000万', '8,000万'],
    6: ['予算は柔軟', '多少高くても'],
  },
  menseki: {
    0: ['ワンルーム', '狭くても'],
    1: ['一人暮らし', '単身'],
    2: ['1LDK'],
    3: ['2LDK', '夫婦'],
    4: ['3LDK', '子ども2人'],
    5: ['家族4人', '手狭'],
    6: ['広い家', '4LDK'],
    7: ['二世帯'],
    8: ['庭', 'とても広い'],
  },
  eki_toho: {
    0: ['駅近', '駅から近い', '徒歩5分', '駅前'],
    1: ['通勤時間を短く'],
    2: ['徒歩10分', '通勤'],
    3: ['徒歩15分', '多少遠く'],
    4: ['徒歩20分'],
    5: ['バス'],
    6: ['車', 'マイカー', '運転', '車移動'],
  },
  chikunensu: {
    0: ['新築'],
    1: ['築浅', '築3年'],
    2: ['築5年'],
    3: ['築10年', 'きれい'],
    4: ['築15年'],
    5: ['築20年'],
    6: ['築25年'],
    7: ['築古', 'リノベ', '古くても', '中古'],
  },
};

const FLAG_HINTS = {
  pet: ['ペット', '犬', '猫'],
  parking: ['車', '駐車場', 'マイカー', '運転'],
  autolock: ['セキュリティ', '防犯', 'オートロック', '女性の一人暮らし'],
  takuhai: ['通販', '宅配', '不在', '共働き'],
  floor2: ['防犯', '眺望', '視線', '1階は不安'],
  minami: ['日当たり', '南向き', '暗い', '洗濯物'],
  bathsep: ['バス・トイレ別', 'ユニットバス', 'お風呂'],
  sentaku: ['洗濯', '家事動線'],
  oidaki: ['追焚', '湯船', 'お風呂'],
  wic: ['収納', '荷物', '物が多い', '片付'],
  ev: ['バリアフリー', '高齢', 'ベビーカー', 'エレベーター', '段差', '階段がつらい', '母'],
  school: ['子育て', '保育園', '幼稚園', '学校', '学区', '小学', '公園', '子ども'],
  super: ['スーパー', '買い物', '商店街', 'コンビニ'],
  soku: ['すぐ', '急い', '即入居', '退去', '来月'],
  gakki: ['楽器', 'ピアノ', 'ギター'],
  reform: ['リノベ', 'リフォーム', 'DIY', '古くても'],
};

// 一致した語の長さで重みづけ（具体的な語ほど強く効かせる）
const hits = (text, words) =>
  (words || []).reduce((acc, w) => (text.includes(w) ? acc + 1 + w.length / 4 : acc), 0);

function softmax(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

const round = (n, digits = 3) => Number(n.toFixed(digits));

/** axes / flags を渡すと、その項目だけ答える（live.html の絞った質問セット用）。 */
export function mockEvaluate(text, { axes = AXES, flags = FLAGS } = {}) {
  const answers = {};

  for (const axis of axes) {
    const q = axis.question;
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const table = CHOICE_HINTS[axis.id] || {};
      const weights = softmax(options.map((o) => 1 + 2.4 * hits(text, table[o])));
      const probabilities = {};
      options.forEach((o, i) => (probabilities[o] = round(weights[i])));
      const best = options[weights.indexOf(Math.max(...weights))];
      answers[axis.id] = {
        type: 'choice',
        choice: best,
        probabilities,
        confidence: round(Math.max(...weights)),
      };
    } else {
      const levels = q.criteria;
      const table = SCORE_HINTS[axis.id] || {};
      const weights = softmax(levels.map((_, i) => 1 + 2.4 * hits(text, table[i])));
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

  for (const flag of flags) {
    const n = hits(text, FLAG_HINTS[flag.id]);
    answers[`flag_${flag.id}`] = {
      type: 'noul',
      noul: round(n === 0 ? 0.06 : Math.min(0.5 + 0.12 * n, 0.97)),
    };
  }

  return { model: 'demo-keyword-matcher', answers, usage: { input_tokens: 0, output_tokens: 0 }, _demo: true };
}
