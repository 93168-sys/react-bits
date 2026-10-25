'use strict';

const { pipeline } = require('node:stream');
const {
  resolveTrack,
  resolveTrackById,
  openMp3Stream,
  trackFileBase,
  contentDisposition,
} = require('../lib/soundcloud');
const { getParam, sendError, allowGet } = require('../lib/http');

// GET /api/download?url=<soundcloud track link>
// GET /api/download?id=<soundcloud track id>   (used for tracks in a playlist)
// Streams the track back as an MP3 file download.
module.exports = async function handler(req, res) {
  if (!allowGet(req, res)) return;
  try {
    const id = getParam(req, 'id');
    const track = id !== null ? await resolveTrackById(id) : await resolveTrack(getParam(req, 'url'));
    const { body, contentLength } = await openMp3Stream(track);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', contentDisposition(trackFileBase(track)));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (contentLength) res.setHeader('Content-Length', String(contentLength));

    pipeline(body, res, (err) => {
      if (err && !res.writableEnded) res.destroy(err);
    });
  } catch (err) {
    sendError(res, err);
  }
};
