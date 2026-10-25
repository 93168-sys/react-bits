'use strict';

// Runs the whole app on your own computer: the page from public/ plus the two
// API functions. Used for a Cloudflare tunnel; Vercel does not use this file.
//
//   node dev/server.js            (or: npm start)
//   PORT=8080 node dev/server.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const infoHandler = require('../api/info');
const downloadHandler = require('../api/download');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function sendStatic(req, res, pathname) {
  let file;
  try {
    file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  } catch {
    file = '';
  }
  // Only files inside public/ are ever served.
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
}

function createServer() {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/info') return infoHandler(req, res);
    if (pathname === '/api/download') return downloadHandler(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end('Use GET');
    }
    return sendStatic(req, res, pathname);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Bound to this computer only. The tunnel reaches it from inside.
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`SoundCloud to MP3 is running at http://localhost:${port}`);
    console.log(`For a public link, open a second terminal and run:`);
    console.log(`  cloudflared tunnel --url http://localhost:${port}`);
  });
}

module.exports = { createServer };
