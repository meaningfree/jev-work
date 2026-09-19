/**
 * ローカル確認用サーバー（Cloudflare を使わずに試すとき用）。
 * リポジトリ直下の静的ファイルを配信しつつ、/jev を Jev API に中継する。
 * 本番の Worker と同じく画面と同一オリジンになるので CORS の問題は起きない。
 *
 *   TYPESAFE_API_KEY=sk-... node proxy/dev-server.mjs
 *   → http://localhost:8787 を開くだけ（接続設定は不要・自動で /jev を使う）
 *
 * キー未設定でも起動する（その場合は画面がデモモードになる）。
 * Cloudflare の実行環境そのままで試したいときは `npx wrangler dev` を使う。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { MAX_BODY_BYTES, callJev, validate } from './upstream.mjs';

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
      return sendJson(res, 200, { service: 'jev-proxy', configured: Boolean(process.env.TYPESAFE_API_KEY) });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    if (!process.env.TYPESAFE_API_KEY) {
      return sendJson(res, 500, { error: 'TYPESAFE_API_KEY が設定されていません' });
    }

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
    const invalid = validate(payload);
    if (invalid) return sendJson(res, 400, { error: invalid });

    try {
      const upstream = await callJev(process.env.TYPESAFE_API_KEY, payload);
      const text = await upstream.text();
      console.log(`[jev] ${upstream.status} ${text.length}B`);
      return send(res, upstream.status, text);
    } catch (error) {
      return sendJson(res, 502, { error: String(error) });
    }
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
