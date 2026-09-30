#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const host = process.env.KINETIK_BIND ?? '127.0.0.1';
const port = Number(process.env.KINETIK_PORT ?? 4173);
const keepAlive = process.env.KINETIK_KEEP_ALIVE === '1';
const prefix = process.env.KINETIK_BASE_PATH ?? '/';
if (
  !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(prefix) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error('Invalid KINETIK_BASE_PATH or KINETIK_PORT.');
const origin = `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
const url = process.env.KINETIK_PUBLIC_URL ?? origin + prefix;
const nonce = randomUUID();
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
try {
  await readFile(resolve(root, 'index.html'));
} catch {
  console.error('Build the app first with npm run build.');
  process.exit(1);
}
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin).pathname;
    if (path === prefix + '__launcher') {
      if (
        req.method === 'POST' &&
        req.headers['x-kinetik-ready'] === nonce &&
        req.headers.origin === new URL(url).origin
      ) {
        res.end('ready');
        if (!keepAlive) {
          console.log('Offline app is ready. Launcher exited.');
          server.close();
          server.closeIdleConnections();
        }
      } else if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nonce, keepAlive }));
      } else {
        res.writeHead(403);
        res.end();
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!path.startsWith(prefix)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const relative = decodeURIComponent(path.slice(prefix.length)) || 'index.html';
    const file = resolve(root, relative);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const content = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Only the trusted plugin host needs string compilation; the UI does not.
    res.setHeader(
      'Content-Security-Policy',
      file.endsWith('app-sandbox.html')
        ? "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; media-src data: https:; connect-src https: wss:; frame-src about: https:; base-uri https:; object-src 'none'; form-action 'none'; sandbox allow-scripts"
        : file.endsWith('sw.js')
          ? "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src https: http://127.0.0.1:* http://localhost:*"
          : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 400);
    res.end('Not found');
  }
});
server.listen(port, host, () => {
  console.log(`Kinetik OSS: ${url}`);
  console.log(
    keepAlive
      ? 'Static server stays running.'
      : 'Launcher will exit after the PWA caches its app files.',
  );
  if (process.env.KINETIK_OPEN_BROWSER !== '0') {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log('Open the URL above in your browser.'));
    child.unref();
  }
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
process.on('SIGINT', () => {
  server.close();
  server.closeAllConnections();
});
