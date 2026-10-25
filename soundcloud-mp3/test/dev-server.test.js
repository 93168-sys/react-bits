'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../dev/server');

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path, method }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject)
      .end();
  });
}

test('local server serves the page, scripts and API routes', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body.toString(), /SoundCloud to MP3/);

    for (const file of ['/app.js', '/zip.js']) {
      const res = await get(port, file);
      assert.equal(res.status, 200, file);
      assert.match(res.headers['content-type'], /text\/javascript/, file);
    }

    const api = await get(port, '/api/info?url=' + encodeURIComponent('https://example.com/x'));
    assert.equal(api.status, 400);
    assert.match(JSON.parse(api.body).error, /not a soundcloud\.com link/);
  } finally {
    server.close();
  }
});

test('local server only serves files from public/', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/nope.html', '/%00']) {
      const res = await get(port, bad);
      assert.equal(res.status, 404, bad);
    }
    assert.equal((await get(port, '/', 'POST')).status, 405);
  } finally {
    server.close();
  }
});
