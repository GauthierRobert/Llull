/**
 * Serves the production build (dist/) for tests/pwa. `POST /__test/next-build` makes `sw.js`
 * report a new version — what the browser sees after the next deploy — without rebuilding.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '../../dist');
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
let buildSuffix = '';

createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'POST' && path === '/__test/next-build') {
    buildSuffix += '-next';
    response.writeHead(204).end();
    return;
  }
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  const body = await readFile(file.startsWith(ROOT) ? file : ROOT).catch(() => readFile(join(ROOT, 'index.html')));
  const type = TYPES[extname(file)] ?? 'text/html';
  const payload = path === '/sw.js' ? body.toString().replace(/"version":"([^"]+)"/, `"version":"$1${buildSuffix}"`) : body;
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(payload);
}).listen(PORT);
