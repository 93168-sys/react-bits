'use strict';

const { pipeline } = require('node:stream');
const { resolveTrack, openMp3Stream, contentDisposition } = require('../lib/soundcloud');
const { getUrlParam, sendError, allowGet } = require('../lib/http');

// GET /api/download?url=<soundcloud track link>
// Streams the track back as an MP3 file download.
module.exports = async function handler(req, res) {
  if (!allowGet(req, res)) return;
  try {
    const track = await resolveTrack(getUrlParam(req));
    const { body, contentLength } = await openMp3Stream(track);

    const name = track.user?.username ? `${track.user.username} - ${track.title}` : track.title;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', contentDisposition(name));
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
