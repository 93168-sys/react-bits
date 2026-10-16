'use strict';

const { ScError } = require('./soundcloud');

function getUrlParam(req) {
  return new URL(req.url, 'http://localhost').searchParams.get('url');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof ScError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: 'Something went wrong on the server.' });
}

function allowGet(req, res) {
  if (req.method === 'GET') return true;
  res.setHeader('Allow', 'GET');
  sendJson(res, 405, { error: 'Use GET.' });
  return false;
}

module.exports = { getUrlParam, sendJson, sendError, allowGet };
