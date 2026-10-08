import type { IncomingMessage, ServerResponse } from 'node:http';
import { readExportFile } from './db';
import { GROUP_NAMES } from './groups';

export type Handler = (req: Request) => Promise<Response>;

type NodeRequest = IncomingMessage & { rawBody?: Buffer; body?: unknown; originalUrl?: string };

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function requestBody(req: NodeRequest): Promise<Uint8Array | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.rawBody && req.rawBody.length > 0) return new Uint8Array(req.rawBody);
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return new Uint8Array(req.body);
  if (typeof req.body === 'string' && req.body.length > 0) return new Uint8Array(Buffer.from(req.body));
  if (req.body && typeof req.body === 'object') return new Uint8Array(Buffer.from(JSON.stringify(req.body)));
  const raw = await readBody(req);
  return raw.length > 0 ? new Uint8Array(raw) : undefined;
}

export function routeName(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const functionsIndex = parts.indexOf('functions');
  if (functionsIndex >= 0 && parts[functionsIndex + 1] === 'v1') {
    return parts.slice(functionsIndex + 2).join('/');
  }
  const trimmed = parts[0] === 'api' || (GROUP_NAMES.has(parts[0]) && parts.length > 1)
    ? parts.slice(1)
    : parts;
  return trimmed.join('/');
}

export async function invokeHandler(req: NodeRequest, res: ServerResponse, handler: Handler): Promise<void> {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.originalUrl || req.url || '/', `http://${host}`);
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const body = await requestBody(req);
    const request = new Request(url, {
      method: req.method,
      headers,
      body: body as BodyInit | undefined,
    });
    const response = await handler(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro interno.';
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }
}

export function sendExportFile(req: NodeRequest, res: ServerResponse): boolean {
  const url = new URL(req.originalUrl || req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const name = routeName(url.pathname).split('/')[0] || '';
  if (!(req.method === 'GET' && name === 'export-file')) return false;
  const file = readExportFile(url.searchParams.get('path') || '');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Arquivo não encontrado.' }));
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(file);
  return true;
}
