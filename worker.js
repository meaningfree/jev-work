/**
 * 画面（静的ファイル）と Jev API への中継を 1 つの Worker で配信する。
 *
 * 画面と API が同一オリジンになるので CORS の設定が要らず、
 * API キーは Worker のシークレットに置いたままブラウザには出ない。
 *
 * デプロイ:
 *   npx wrangler deploy
 *   npx wrangler secret put TYPESAFE_API_KEY   # apikey_... を貼る
 *
 * /jev 以外のパスは静的アセット（public/ の中身）が返る。
 */
import { MAX_BODY_BYTES, callJev, validate } from './proxy/upstream.mjs';

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/jev') return env.ASSETS.fetch(request);

    // 画面が起動時に「実 API が使える配信か」を確かめるための応答。
    if (request.method === 'GET') {
      return json({ service: 'jev-proxy', configured: Boolean(env.TYPESAFE_API_KEY) }, 200);
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.TYPESAFE_API_KEY) return json({ error: 'TYPESAFE_API_KEY が設定されていません' }, 500);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const invalid = validate(payload);
    if (invalid) return json({ error: invalid }, 400);

    const upstream = await callJev(env.TYPESAFE_API_KEY, payload);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
