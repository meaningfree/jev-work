/**
 * ローカル確認用サーバー。
 * リポジトリ直下の静的ファイルを配信しつつ、POST /jev を Jev API に中継する。
 * 同一オリジンになるので CORS の問題も起きない。
 *
 *   TYPESAFE_API_KEY=sk-... node proxy/dev-server.mjs
 *   → http://localhost:8787 を開き、接続設定に http://localhost:8787/jev を入れる
 *
 * キー未設定でも起動する（その場合は画面のデモモードで確認できる）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL('..', import.meta.url).pathname;
const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';

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

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/jev') {
    if (!process.env.TYPESAFE_API_KEY) {
      return send(res, 500, JSON.stringify({ error: 'TYPESAFE_API_KEY が設定されていません' }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: payload.model || 'jev-latest',
          state: payload.state,
          questions: payload.questions,
        }),
      });
      const text = await upstream.text();
      console.log(`[jev] ${upstream.status} ${text.length}B`);
      return send(res, upstream.status, text);
    } catch (error) {
      return send(res, 502, JSON.stringify({ error: String(error) }));
    }
  }

  const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
