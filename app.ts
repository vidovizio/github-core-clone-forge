import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > 32 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks, size);
}

/** Build the in-memory forge server. The store is shared by every protocol on this process. */
export function createApp(): Server {
  const store = new ForgeStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://entry'); } catch { sendJson(res, 400, { message: 'Bad Request' }); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    const dispatch = (body: Buffer | undefined): void => {
      const requestId = `GH-${String(++requestCounter).padStart(8, '0')}`;
      const path = url.pathname;
      if (path === '/api/graphql') { handleGraphql(req, res, body, store, token); return; }
      if (path === '/mcp') { handleMcp(req, res, body, store, token); return; }
      if (path.startsWith('/api/v3') && handleRest(req, res, url, store, token, requestId, body)) return;
      if (path.includes('.git/') && handleGit(req, res, url, store, token, body)) return;
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    };
    if (req.method === 'GET' || req.method === 'HEAD') { dispatch(undefined); return; }
    readBody(req).then(dispatch, () => sendJson(res, 413, { message: 'Request body too large' }));
  });
}
