/**
 * ローカル確認用サーバー（Cloudflare を使わずに試すとき用）。
 * リポジトリ直下の静的ファイルを配信しつつ、/jev を各モデルの API に中継する。
 * 本番の Worker と同じく画面と同一オリジンになるので CORS の問題は起きない。
 *
 *   TYPESAFE_API_KEY=apikey_... node proxy/dev-server.mjs
 *   → http://localhost:8787 を開くだけ（接続設定は不要・自動で /jev を使う）
 *
 * OPENAI_API_KEY / GEMINI_API_KEY も渡すと、比較ページ（compare.html）で
 * 同じ質問を OpenAI / Gemini にも投げられる。
 *
 * 回数の上限は RATE_LIMIT_PER_MIN / RATE_LIMIT_LLM_PER_MIN で変えられる（0 で無効）。
 *
 * キー未設定でも起動する（その場合は画面がデモモードになる）。
 * Cloudflare の実行環境そのままで試したいときは `npx wrangler dev` を使う。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { MAX_BODY_BYTES } from './upstream.mjs';
import { callProvider, providerStatus, validateRequest } from './providers.mjs';
import { checkRateLimit, limitsFrom, rateLimitMessage } from './ratelimit.mjs';

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL('../public/', import.meta.url).pathname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
};
const sendJson = (res, status, body) => send(res, status, JSON.stringify(body));

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);

  if (path === '/jev') {
    // 画面が起動時に実 API を使えるか確かめに来る。
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        service: 'jev-proxy',
        configured: Boolean(process.env.TYPESAFE_API_KEY),
        providers: providerStatus(process.env),
        limits: limitsFrom(process.env),
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'body too large' });
      chunks.push(chunk);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const invalid = validateRequest(payload, process.env);
    if (invalid) return sendJson(res, 400, { error: invalid });

    const key = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const gate = await checkRateLimit(process.env, { key, provider: payload.provider });
    if (!gate.ok) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(gate.retryAfter) });
      return res.end(JSON.stringify({ error: rateLimitMessage(gate.scope) }));
    }

    const { status, text } = await callProvider(process.env, payload);
    console.log(`[${payload.provider || 'jev'}] ${status} ${text.length}B`);
    return send(res, status, text);
  }

  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
