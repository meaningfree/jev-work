/**
 * 画面（静的ファイル）と 各モデルへの中継を 1 つの Worker で配信する。
 *
 * 画面と API が同一オリジンになるので CORS の設定が要らず、
 * API キーは Worker のシークレットに置いたままブラウザには出ない。
 *
 * デプロイ:
 *   npx wrangler deploy
 *   npx wrangler secret put TYPESAFE_API_KEY   # apikey_... を貼る
 *   npx wrangler secret put OPENAI_API_KEY     # 比較ページを使う場合（任意）
 *   npx wrangler secret put GEMINI_API_KEY     # 比較ページを使う場合（任意）
 *
 * /jev 以外のパスは静的アセット（public/ の中身）が返る。
 * POST /jev の body に provider（jev / openai / gemini）を入れると宛先が変わる。
 */
import { MAX_BODY_BYTES } from './proxy/upstream.mjs';
import { callProvider, providerStatus, validateRequest } from './proxy/providers.mjs';

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/jev') return env.ASSETS.fetch(request);

    // 画面が起動時に「実 API が使える配信か」「どのモデルを選べるか」を確かめに来る。
    if (request.method === 'GET') {
      return json(
        {
          service: 'jev-proxy',
          configured: Boolean(env.TYPESAFE_API_KEY),
          providers: providerStatus(env),
        },
        200,
      );
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const invalid = validateRequest(payload);
    if (invalid) return json({ error: invalid }, 400);

    const { status, text } = await callProvider(env, payload);
    return new Response(text, {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
