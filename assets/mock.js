// デモモード用のダミー推論。
// Jev の API キーがまだ無い状態でも UI を触れるようにするためのもので、
// 中身は単純なキーワードマッチ。レスポンスの形だけ Jev に合わせてある。
import { AXES, FLAGS } from './questions.js';

// choice 軸: 選択肢 -> 加点キーワード
const CHOICE_HINTS = {
  torihiki: {
    賃貸: ['賃貸', '家賃', '転勤', '単身赴任', 'とりあえず', '仮住まい', '更新', '引っ越しやすい'],
    購入: ['購入を検討', '購入', '買いたい', 'マイホーム', '住宅ローン', '資産', '持ち家', '終の棲家', '定住'],
  },
  tatemono: {
    'マンション（区分）': ['マンション', '駅近', 'セキュリティ', 'オートロック', '管理', 'タワー'],
    一戸建て: ['戸建', '一戸建て', '庭', '駐車場', '平屋', 'ピアノ', '楽器', '子どもが走る', '二世帯'],
    'アパート・小規模低層': ['アパート', '安く', '家賃を抑え', '単身', 'ひとり暮らし'],
    '土地（建てる前提）': ['土地', '注文住宅', '建てたい', '設計'],
  },
  madori: {
    '1R / 1K': ['ひとり暮らし', '単身', 'ワンルーム', '1K'],
    '1LDK': ['2人暮らし', 'ふたり暮らし', '夫婦2人', '同棲', '新婚'],
    '2LDK': ['子どもが1人', '子ども1人', '書斎', 'もう1部屋', '2LDK'],
    '3LDK': ['子ども2人', '子どもが2人', '3LDK', '家族4人', '4人家族', '手狭'],
    '4LDK以上': ['二世帯', '親と', '子ども3人', '4LDK', '5人'],
  },
  area_type: {
    '都心・駅前の利便重視': ['都心', '職場の近く', '通勤時間を短く', '飲食', '便利', '山手線', '駅前'],
    '都心近郊のバランス型': ['バランス', '郊外すぎない', '沿線', '30分', '40分'],
    '郊外の住宅地': ['郊外', '静か', '子育て', '公園', '広い', '住宅地'],
    '自然環境重視・地方': ['自然', '移住', '地方', '海', '山', 'のんびり', 'リモート'],
  },
  saiyusen: {
    価格: ['予算', '安く', '家賃を抑え', 'ローンが不安', '費用'],
    広さ・部屋数: ['広い', '手狭', '狭い', '部屋数', '収納が足りない'],
    '立地・通勤時間': ['通勤', '職場', '駅近', '時間がかかる', '通学'],
    '住環境・子育て': ['子育て', '学区', '保育園', '静か', '環境', '公園'],
    建物の新しさ・設備: ['新築', '築浅', 'きれい', '設備', '食洗機', '断熱', '寒い'],
  },
};

// score 軸: レベルindex -> 加点キーワード
const SCORE_HINTS = {
  menseki: {
    0: ['ワンルーム', '狭くても'],
    1: ['ひとり暮らし', '単身', '2人'],
    2: ['夫婦', '2LDK', '子どもが1人'],
    3: ['3LDK', '家族4人', '子ども2人', '広い'],
    4: ['二世帯', '庭', '4LDK', 'とても広い'],
  },
  eki_toho: {
    0: ['駅近', '駅から近い', '徒歩5分', '駅前'],
    1: ['通勤', '電車', '徒歩10分'],
    2: ['多少遠く', '徒歩15分'],
    3: ['バス'],
    4: ['車', 'マイカー', '駐車場2台', '運転'],
  },
  chikunensu: {
    0: ['築古', 'リノベ', '古くても', '中古'],
    1: ['築20年'],
    2: ['築浅', 'きれい', '築10年'],
    3: ['新築'],
  },
  yosan_sensitivity: {
    0: ['予算が厳しい', '安く', '節約', '家賃を抑え'],
    1: ['できれば安く', '相場より'],
    2: ['相場', '普通'],
    3: ['条件が合えば', '多少高くても', '予算は柔軟'],
  },
  nyukyo_isogi: {
    0: ['情報収集', 'そのうち', '将来', 'いずれ'],
    1: ['来年', '半年'],
    2: ['3か月', '春までに', '早めに'],
    3: ['すぐ', '急い', '今月', '即入居', '退去'],
  },
};

const FLAG_HINTS = {
  pet: ['ペット', '犬', '猫'],
  parking: ['車', '駐車場', 'マイカー', '運転'],
  kosodate: ['子育て', '保育園', '幼稚園', '学校', '学区', '小学', '公園', '子ども'],
  work_space: ['在宅', 'リモート', 'テレワーク', '書斎', 'ワークスペース', '仕事部屋'],
  shuno: ['収納', '荷物', '物が多い', '片付'],
  kaimono: ['スーパー', '買い物', '商店街', 'コンビニ'],
  shizuka: ['静か', '騒音', 'うるさい', '落ち着'],
  hiatari: ['日当たり', '南向き', '暗い', '陽'],
  barrier_free: ['バリアフリー', '親', '高齢', 'ベビーカー', 'エレベーター', '段差'],
  reform: ['リノベ', 'リフォーム', 'DIY', '古くても'],
};

// 一致した語の長さで重みづけ（具体的な語ほど強く効かせる）
const hits = (text, words) =>
  (words || []).reduce((acc, w) => (text.includes(w) ? acc + 1 + w.length / 4 : acc), 0);

function softmax(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

function round(n, digits = 3) {
  return Number(n.toFixed(digits));
}

export function mockEvaluate(text) {
  const answers = {};

  for (const axis of AXES) {
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
      const score = weights.reduce((acc, w, i) => acc + w * i, 0);
      answers[axis.id] = {
        type: 'score',
        score: round(score),
        legend,
        probabilities,
        confidence: round(Math.max(...weights)),
      };
    }
  }

  for (const flag of FLAGS) {
    const n = hits(text, FLAG_HINTS[flag.id]);
    answers[`flag_${flag.id}`] = {
      type: 'noul',
      noul: round(n === 0 ? 0.08 + Math.min(text.length, 400) / 4000 : Math.min(0.55 + 0.18 * n, 0.97)),
    };
  }

  return {
    model: 'demo-keyword-matcher',
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
    _demo: true,
  };
}
