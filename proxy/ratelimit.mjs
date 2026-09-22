/**
 * /jev を叩ける回数の上限。
 *
 * 公開した中継は誰でも叩けて、呼ばれた分だけこちらのクレジットが減る。
 * Jev だけなら 1 回 $0.0002 なので放っておけたが、比較ページから生成モデルを
 * 選べるようになると 1 回で 2 桁上がるので、上限を入れておく。
 *
 * 2 段構えにしてある。
 *   all … POST /jev 全部（既存の 2 画面も含む）
 *   llm … 生成モデル（OpenAI / Gemini）だけ。1 回が高いので別枠でさらに絞る
 *
 * Cloudflare の Rate Limiting バインディング（wrangler.toml の [[ratelimits]]）が
 * あればそれを使う。無ければこのファイルのメモリ内カウンタにフォールバックする。
 * フォールバックは isolate / プロセス単位でしか数えられないので、本番では
 * バインディングを設定すること（ローカルの dev-server はこちらで十分）。
 */

const DEFAULTS = { all: 30, llm: 8 };
const PERIOD = 60;   // 秒。Cloudflare のバインディングは 10 か 60 しか取れない。

const toCount = (value, fallback) =>
  value === undefined || value === null || value === '' ? fallback : Number(value);

/**
 * 環境変数で上限を上書きできるようにしておく（1 分あたりの回数）。
 *   RATE_LIMIT_PER_MIN     … 全体
 *   RATE_LIMIT_LLM_PER_MIN … 生成モデルぶん
 * 0 以下にすると、その枠は無効（ローカルで試すとき用）。
 */
export function limitsFrom(env = {}) {
  return {
    all: { limit: toCount(env.RATE_LIMIT_PER_MIN, DEFAULTS.all), period: PERIOD },
    llm: { limit: toCount(env.RATE_LIMIT_LLM_PER_MIN, DEFAULTS.llm), period: PERIOD },
  };
}

// key -> その時間枠での回数。時間枠が変わったら古いものは捨てる。
const buckets = new Map();

function memoryLimit(key, { limit, period }, now = Date.now()) {
  const window = Math.floor(now / (period * 1000));
  const id = `${key}#${window}`;
  const count = (buckets.get(id) ?? 0) + 1;
  buckets.set(id, count);

  // 古い時間枠のカウンタが残り続けないように、たまに掃除する。
  if (buckets.size > 2000) {
    for (const k of buckets.keys()) if (!k.endsWith(`#${window}`)) buckets.delete(k);
  }

  const retryAfter = (window + 1) * period - Math.floor(now / 1000);
  return { success: count <= limit, retryAfter };
}

/**
 * 1 リクエストぶん数える。超えていたら { ok: false, scope, retryAfter } を返す。
 *
 * key      … 数える単位。IP アドレスを想定
 * provider … jev 以外なら llm の枠も使う
 */
export async function checkRateLimit(env, { key, provider }) {
  const limits = limitsFrom(env);
  const scopes = [['all', env.RATE_LIMIT_ALL]];
  if (provider && provider !== 'jev') scopes.push(['llm', env.RATE_LIMIT_LLM]);

  for (const [scope, binding] of scopes) {
    const conf = limits[scope];
    if (conf.limit <= 0) continue;

    if (typeof binding?.limit === 'function') {
      // Cloudflare 側で数える。上限は wrangler.toml の [[ratelimits]] が正。
      const { success } = await binding.limit({ key: `${scope}:${key}` });
      if (!success) return { ok: false, scope, retryAfter: conf.period };
    } else {
      const { success, retryAfter } = memoryLimit(`${scope}:${key}`, conf);
      if (!success) return { ok: false, scope, retryAfter };
    }
  }
  return { ok: true };
}

/** 429 のときに返す本文。 */
export function rateLimitMessage(scope) {
  return scope === 'llm'
    ? '生成モデル（OpenAI / Gemini）の呼び出しが多すぎます。少し待って再試行してください'
    : 'リクエストが多すぎます。少し待って再試行してください';
}
