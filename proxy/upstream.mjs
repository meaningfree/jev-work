/**
 * Jev API を叩く部分の共通処理。
 * Worker（本番）・ローカルの dev-server・providers.mjs から同じものを使う。
 *
 * リクエストの検証と、Jev 以外のモデル（OpenAI / Gemini）への振り分けは
 * providers.mjs 側にある。
 */

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
export const MAX_BODY_BYTES = 64 * 1024;

/** API キーを付けて Jev に転送する。fetch の Response をそのまま返す。 */
export function callJev(apiKey, payload) {
  return fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: payload.model || 'jev-latest',
      state: payload.state,
      questions: payload.questions,
    }),
  });
}
