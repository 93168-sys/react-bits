'use strict';

const { lookup } = require('../lib/soundcloud');
const { getParam, sendJson, sendError, allowGet } = require('../lib/http');

// GET /api/info?url=<soundcloud track or playlist link>
// Returns what the preview card needs. For a track: title, artist, artwork,
// length, and whether it can be downloaded as a full MP3. For a playlist: the
// same for the playlist plus a list of its tracks (up to 50).
module.exports = async function handler(req, res) {
  if (!allowGet(req, res)) return;
  try {
    sendJson(res, 200, await lookup(getParam(req, 'url')));
  } catch (err) {
    sendError(res, err);
  }
};
