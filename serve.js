/* Local test server for Frame Commander — zero dependencies, Node only.
   Serves this folder, disables caching (edits show up on refresh), and
   opens the app in your default browser. Run: node serve.js */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT_START = 8765;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

function start(port) {
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400); return res.end('bad request');
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 ' + urlPath); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < PORT_START + 10) return start(port + 1);
    console.error('server error:', e.message);
    process.exit(1);
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('\n  Frame Commander Dashboard — local test server\n');
    console.log(`  folder : ${ROOT}`);
    console.log(`  url    : ${url}`);
    console.log('  stop   : Ctrl+C   (edits to api/ or js/ show up on page refresh)\n');
    const opener = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(opener, () => {});
  });
}

start(PORT_START);
