#!/usr/bin/env node
/* Tiny static server for the Dune BYOP browser host.
 *
 * Serves the *repository root* (so `/web/host/play.html` can fetch
 * `/runtime/wasm/runtime.wasm` and the gitignored `.local/…/game.wasm`), with
 * the MIME types and COOP/COEP headers a WebAssembly page needs.  No
 * dependencies, no caching, no directory listings beyond index.html.
 *
 *   node tools/host/serve.mjs --port 4188 [--root /path/to/dune-web]
 *
 * Prints `listening http://127.0.0.1:<port>/` on stdout (the port is resolved,
 * so `--port 0` picks a free one).  Useful URLs:
 *   /web/host/play.html
 *   /runtime/wasm/runtime.wasm
 *   /.local/wasm-full/game.wasm   (gitignored player-built module)
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ppm', 'image/x-portable-pixmap'],
  ['.bin', 'application/octet-stream'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function parseArgs(argv) {
  const args = { port: 4188, root: DEFAULT_ROOT, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]);
    else if (arg === '--root') args.root = path.resolve(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/host/serve.mjs [--port N] [--root DIR] [--host ADDR]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function safeJoin(root, urlPath) {
  // decode, normalise and refuse anything that escapes the served root
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function handler(root, request, response) {
  const send = (status, headers, body) => {
    response.writeHead(status, {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      ...headers,
    });
    if (body === undefined) response.end();
    else response.end(body);
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(405, { Allow: 'GET, HEAD' }, 'method not allowed');
    return;
  }

  const urlPath = request.url === '/' ? '/web/host/play.html' : request.url;
  let target = safeJoin(root, urlPath);
  if (!target) {
    send(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden');
    return;
  }

  let stats;
  try {
    stats = await fs.stat(target);
    if (stats.isDirectory()) {
      target = path.join(target, 'index.html');
      stats = await fs.stat(target);
    }
  } catch {
    send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, `not found: ${urlPath}`);
    return;
  }

  const type = MIME.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': stats.size,
    // no-store keeps rebuilt game.wasm from being cached while debugging
  };
  if (request.method === 'HEAD') {
    send(200, headers);
    return;
  }
  response.writeHead(200, {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...headers,
  });
  createReadStream(target).pipe(response);
}

const args = parseArgs(process.argv.slice(2));
const server = createServer((request, response) => {
  handler(args.root, request, response).catch((error) => {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    response.end(`server error: ${error.message}`);
  });
});
server.on('error', (error) => {
  console.error(`serve.mjs: ${error.message}`);
  process.exit(1);
});
server.listen(args.port, args.host, () => {
  const { port } = server.address();
  console.log(`listening http://${args.host}:${port}/`);
  console.log(`root ${args.root}`);
  console.log(`play http://${args.host}:${port}/web/host/play.html`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
