import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function startFixtureServer(port = 4173) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/missing.png') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (url.pathname === '/slow.svg') {
      return;
    }
    if (url.pathname.endsWith('.svg')) {
      const id = url.pathname.split('/').pop().replace('.svg', '');
      const colors = ['#d7e2c7', '#e8c9b2', '#b8d6d6', '#d6c7df', '#e9dbba', '#b7cdb8'];
      const color = colors[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length];
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public,max-age=3600',
      });
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560" viewBox="0 0 800 560"><rect width="800" height="560" fill="${color}"/><circle cx="570" cy="180" r="110" fill="#ffffff50"/><path d="M0 430L210 180 420 410 570 300 800 520V560H0Z" fill="#ffffff80"/><text x="45" y="515" font-family="sans-serif" font-size="24" fill="#345641">${id.replace(/[^a-z0-9-]/gi, '')}</text></svg>`,
      );
      return;
    }
    if (url.pathname === '/perf') {
      const nodes = Math.min(30_000, Number(url.searchParams.get('nodes')) || 5000);
      const images = Math.min(1500, Number(url.searchParams.get('images')) || 200);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(
        `<!doctype html><title>性能测试</title><section id="performance" style="padding:20px">${Array.from({ length: nodes }, (_, i) => (i < images ? `<img src="/assets/perf-${i}.svg" width="20" height="20"/>` : '<span>·</span>')).join('')}</section>`,
      );
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(await fs.readFile(path.resolve(import.meta.dirname, '../tests/fixtures/index.html')));
    } catch {
      res.writeHead(500);
      res.end('Fixture unavailable');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startFixtureServer();
  console.log('Fixture: http://127.0.0.1:4173');
}
