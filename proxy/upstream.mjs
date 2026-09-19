/**
 * Jev API を叩く部分の共通処理。
 * Worker（本番）とローカルの dev-server から同じものを使う。
 */

export const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
export const MAX_BODY_BYTES = 64 * 1024;

/** リクエストボディの検証。問題なければ null、あればエラー文字列を返す。 */
export function validate(payload) {
  if (!payload || typeof payload !== 'object') return 'invalid JSON';
  if (!payload.state || !payload.questions) return 'state and questions are required';
  return null;
}

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
