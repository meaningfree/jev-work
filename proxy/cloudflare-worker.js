/**
 * Jev API への最小プロキシ（Cloudflare Workers）。
 *
 * api.typesafe.ai はブラウザからの CORS リクエストを拒否し、API キーも
 * フロントに置けないので、キーを持つ小さなサーバーを1枚挟む。
 *
 * デプロイ:
 *   npx wrangler deploy                       # proxy/ ディレクトリで
 *   npx wrangler secret put TYPESAFE_API_KEY  # sk-... を登録
 *   npx wrangler secret put ALLOWED_ORIGINS   # 例: https://<user>.github.io
 */

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const MAX_BODY_BYTES = 64 * 1024;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    _ok: ok,
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export default {
  async fetch(request, env) {
    const { _ok, ...cors } = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    if (!_ok) return json({ error: 'origin not allowed' }, 403, cors);
    if (!env.TYPESAFE_API_KEY) return json({ error: 'TYPESAFE_API_KEY is not configured' }, 500, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413, cors);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid JSON' }, 400, cors);
    }
    if (!payload.state || !payload.questions) return json({ error: 'state and questions are required' }, 400, cors);

    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: payload.model || 'jev-latest',
        state: payload.state,
        questions: payload.questions,
      }),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
};
