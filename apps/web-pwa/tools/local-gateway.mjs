import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

const host = process.env.LOCAL_GATEWAY_HOST || '127.0.0.1';
const port = Number(process.env.LOCAL_GATEWAY_PORT || 4173);
const target = process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const distDir = process.env.PWA_DIST_DIR
  ? resolve(process.env.PWA_DIST_DIR)
  : resolve(scriptDirectory, '..', '..', '..', 'infra', 'cloudflare', 'app', 'dist');

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`${distDir}/index.html がありません。先に npm run build を実行してください。`);
  process.exit(1);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const proxy = httpProxy.createProxyServer({ target, ws: true, changeOrigin: false });
proxy.on('error', (error, request, response) => {
  console.error(`Proxy error for ${request.url}:`, error.message);
  if ('writeHead' in response && !response.headersSent) {
    response.writeHead(502, { 'Content-Type': 'application/problem+json; charset=utf-8' });
    response.end(JSON.stringify({ title: 'Local API unavailable', status: 502, detail: error.message }));
  }
});

function safeFilePath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(distDir, relative || 'index.html');
  return full === distDir || full.startsWith(`${distDir}${sep}`) ? full : undefined;
}

async function serveFile(response, filePath, method) {
  const extension = extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
    headers['Cache-Control'] = 'no-cache';
  } else if (/[/\\]assets[/\\]/.test(filePath)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  const stat = statSync(filePath);
  headers['Content-Length'] = String(stat.size);
  response.writeHead(200, headers);
  if (method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/mock-storage/') || url.pathname === '/health' || url.pathname === '/realtime') {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      request.url = request.url.replace(/^\/api(?=\/|\?|$)/, '') || '/';
    }
    proxy.web(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  try {
    const requested = safeFilePath(url.pathname);
    if (requested && existsSync(requested) && statSync(requested).isFile()) {
      await serveFile(response, requested, request.method);
      return;
    }
    const indexPath = join(distDir, 'index.html');
    const body = await readFile(indexPath);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : 'Internal server error');
  }
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  if (url.pathname === '/realtime') proxy.ws(request, socket, head);
  else socket.destroy();
});

server.listen(port, host, () => {
  console.log(`Pushbridge local PWA: http://${host}:${port}`);
  console.log(`REST/WebSocket proxy: ${target}`);
});
