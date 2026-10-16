'use strict';

const { resolveTrack, describeTrack } = require('../lib/soundcloud');
const { getUrlParam, sendJson, sendError, allowGet } = require('../lib/http');

// GET /api/info?url=<soundcloud track link>
// Returns what the preview card needs: title, artist, artwork, length, and
// whether the track can be downloaded as a full MP3.
module.exports = async function handler(req, res) {
  if (!allowGet(req, res)) return;
  try {
    const track = await resolveTrack(getUrlParam(req));
    sendJson(res, 200, describeTrack(track));
  } catch (err) {
    sendError(res, err);
  }
};
