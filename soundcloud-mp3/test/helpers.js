'use strict';

// A fake SoundCloud, installed over global fetch. It only checks that our
// code follows the request flow we expect (home page -> bundle -> resolve ->
// stream link -> media). It cannot prove the real SoundCloud still behaves
// this way.

const CLIENT_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function id3Tag(payloadSize = 6) {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, payloadSize]);
  return Buffer.concat([header, Buffer.alloc(payloadSize, 0x01)]);
}

function installFakeSoundCloud({
  track,
  tracksById = {},
  segments = [],
  progressiveBody = null,
  onRequest = () => {},
}) {
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString());
    onRequest(url);

    if (url.origin === 'https://soundcloud.com' && url.pathname === '/') {
      return new Response('<script src="https://a-v2.sndcdn.com/assets/app-1.js"></script>');
    }
    if (url.href === 'https://a-v2.sndcdn.com/assets/app-1.js') {
      return new Response(`var x={client_id:"${CLIENT_ID}"};`);
    }
    if (url.origin === 'https://api-v2.soundcloud.com') {
      if (url.searchParams.get('client_id') !== CLIENT_ID) return new Response('nope', { status: 401 });
      if (url.pathname === '/resolve') return Response.json(track);
      if (url.pathname === '/tracks') {
        const ids = (url.searchParams.get('ids') || '').split(',');
        return Response.json(ids.map((id) => tracksById[id]).filter(Boolean));
      }
      const one = /^\/tracks\/(\d+)$/.exec(url.pathname);
      if (one) {
        return tracksById[one[1]] ? Response.json(tracksById[one[1]]) : new Response('gone', { status: 404 });
      }
      if (url.pathname.endsWith('/stream/progressive')) {
        return Response.json({ url: 'https://cf-media.sndcdn.com/file.mp3' });
      }
      if (url.pathname.endsWith('/stream/hls')) {
        return Response.json({ url: 'https://playback.media-streaming.soundcloud.cloud/abc/playlist.m3u8' });
      }
    }
    if (url.href === 'https://cf-media.sndcdn.com/file.mp3' && progressiveBody) {
      return new Response(progressiveBody, { headers: { 'content-length': String(progressiveBody.length) } });
    }
    if (url.href === 'https://playback.media-streaming.soundcloud.cloud/abc/playlist.m3u8') {
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
      segments.forEach((_, i) => lines.push('#EXTINF:10.0,', `seg${i}.mp3`));
      lines.push('#EXT-X-ENDLIST');
      return new Response(lines.join('\n'));
    }
    const seg = /^https:\/\/playback\.media-streaming\.soundcloud\.cloud\/abc\/seg(\d+)\.mp3$/.exec(url.href);
    if (seg) {
      const index = Number(seg[1]);
      // Later segments answer sooner, so ordering bugs would show up.
      await new Promise((r) => setTimeout(r, (segments.length - index) * 5));
      return new Response(segments[index]);
    }
    return new Response('not found', { status: 404 });
  };

  return () => {
    globalThis.fetch = realFetch;
  };
}

function makeTrack(transcodings, extra = {}) {
  return {
    kind: 'track',
    id: 1,
    title: 'My Song / Remix',
    user: { username: 'Some Artist' },
    artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
    duration: 61000,
    full_duration: 61000,
    track_authorization: 'auth123',
    media: { transcodings },
    ...extra,
  };
}

const hlsMp3 = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/hls',
  preset: 'mp3_0_0',
  snipped: false,
  format: { protocol: 'hls', mime_type: 'audio/mpeg' },
};
const progressiveMp3 = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/progressive',
  preset: 'mp3_0_0',
  snipped: false,
  format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
};
const hlsOpus = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/hls',
  preset: 'opus_0_0',
  snipped: false,
  format: { protocol: 'hls', mime_type: 'audio/ogg; codecs="opus"' },
};

module.exports = { CLIENT_ID, id3Tag, installFakeSoundCloud, makeTrack, hlsMp3, progressiveMp3, hlsOpus };
