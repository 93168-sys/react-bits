'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const sc = require('../lib/soundcloud');
const infoHandler = require('../api/info');
const downloadHandler = require('../api/download');
const { id3Tag, installFakeSoundCloud, makeTrack, hlsMp3, progressiveMp3, hlsOpus } = require('./helpers');

// --- pure helpers ---------------------------------------------------------

test('parseTrackUrl accepts soundcloud links and drops tracking params', () => {
  const u = sc.parseTrackUrl('soundcloud.com/artist/song?utm_source=clipboard&si=abc#t=10');
  assert.equal(u.toString(), 'https://soundcloud.com/artist/song');
});

test('parseTrackUrl keeps secret_token for private share links', () => {
  const u = sc.parseTrackUrl('https://soundcloud.com/artist/song/s-AbC123?secret_token=s-AbC123&x=1');
  assert.equal(u.search, '?secret_token=s-AbC123');
});

test('parseTrackUrl rejects other hosts and look-alikes', () => {
  for (const bad of [
    'https://example.com/artist/song',
    'https://soundcloud.com.evil.example/artist/song',
    'https://evil.example/?u=soundcloud.com',
    'http://169.254.169.254/latest/meta-data',
    '',
    'not a link at all',
  ]) {
    assert.throws(() => sc.parseTrackUrl(bad), sc.ScError, bad);
  }
});

test('stripId3 removes one or more leading ID3 tags and leaves audio alone', () => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  assert.deepEqual(sc.stripId3(Buffer.concat([id3Tag(6), audio])), audio);
  assert.deepEqual(sc.stripId3(Buffer.concat([id3Tag(6), id3Tag(3), audio])), audio);
  assert.deepEqual(sc.stripId3(audio), audio);
});

test('safeFilename and contentDisposition handle odd titles', () => {
  assert.equal(sc.safeFilename('A/B:C*D?"E"<F>|G'), 'ABCDEFG');
  assert.equal(sc.safeFilename('   '), 'soundcloud-track');
  const header = sc.contentDisposition('Beyoncé – "Halo" (live)');
  assert.match(header, /^attachment; filename="Beyonc_ _ Halo \(live\)\.mp3"; /);
  assert.match(header, /filename\*=UTF-8''Beyonc%C3%A9%20%E2%80%93%20Halo%20%28live%29\.mp3$/);
  assert.ok(!/[^\x20-\x7e]/.test(header), 'header must be plain ASCII');
});

test('upgradeArtwork asks for the bigger image and refuses foreign hosts', () => {
  assert.equal(
    sc.upgradeArtwork('https://i1.sndcdn.com/artworks-abc-large.jpg'),
    'https://i1.sndcdn.com/artworks-abc-t500x500.jpg'
  );
  assert.equal(sc.upgradeArtwork('https://evil.example/a-large.jpg'), null);
  assert.equal(sc.upgradeArtwork(null), null);
});

test('pickTranscoding prefers progressive MP3, then HLS MP3', () => {
  assert.equal(sc.pickTranscoding(makeTrack([hlsMp3, progressiveMp3])), progressiveMp3);
  assert.equal(sc.pickTranscoding(makeTrack([hlsOpus, hlsMp3])), hlsMp3);
});

test('pickTranscoding explains preview-only and no-MP3 tracks', () => {
  assert.throws(() => sc.pickTranscoding(makeTrack([{ ...hlsMp3, snipped: true }])), /30 second preview/);
  assert.throws(() => sc.pickTranscoding(makeTrack([hlsOpus])), /no downloadable MP3/);
  assert.throws(() => sc.pickTranscoding(makeTrack([])), /no downloadable MP3/);
});

// --- request flow against the fake SoundCloud -----------------------------

test('resolveTrack rejects playlists and non-track links', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: { kind: 'playlist' } });
  try {
    await assert.rejects(sc.resolveTrack('https://soundcloud.com/a/sets/b'), /playlist/);
  } finally {
    restore();
  }
  sc.resetClientIdCache();
  const restoreUser = installFakeSoundCloud({ track: { kind: 'user' } });
  try {
    await assert.rejects(sc.resolveTrack('https://soundcloud.com/a'), /not a track/);
  } finally {
    restoreUser();
  }
});

test('openMp3Stream stitches HLS segments in order and strips ID3 tags', async () => {
  sc.resetClientIdCache();
  const audio = [0, 1, 2, 3, 4, 5, 6].map((n) => Buffer.alloc(100, n + 10));
  const segments = audio.map((buf, i) => (i % 2 === 0 ? Buffer.concat([id3Tag(8), buf]) : buf));
  const restore = installFakeSoundCloud({ track: makeTrack([hlsMp3]), segments });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const { body, contentLength } = await sc.openMp3Stream(track);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    assert.equal(contentLength, null);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat(audio));
  } finally {
    restore();
  }
});

test('openMp3Stream passes a progressive MP3 straight through with its length', async () => {
  sc.resetClientIdCache();
  const file = Buffer.from('fake-mp3-bytes-'.repeat(1000));
  const restore = installFakeSoundCloud({ track: makeTrack([progressiveMp3]), progressiveBody: file });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const { body, contentLength } = await sc.openMp3Stream(track);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    assert.equal(contentLength, file.length);
    assert.deepEqual(Buffer.concat(chunks), file);
  } finally {
    restore();
  }
});

test('never fetches a host outside SoundCloud, even if the API says to', async () => {
  sc.resetClientIdCache();
  const evil = { ...progressiveMp3, url: 'https://evil.example/stream' };
  const requested = [];
  const restore = installFakeSoundCloud({
    track: makeTrack([evil]),
    onRequest: (url) => requested.push(url.hostname),
  });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    await assert.rejects(sc.openMp3Stream(track), /unexpected host/);
    assert.ok(!requested.includes('evil.example'));
  } finally {
    restore();
  }
});

test('retries once with a fresh client id when the cached one is rejected', async () => {
  sc.resetClientIdCache();
  let resolveCalls = 0;
  const restore = installFakeSoundCloud({
    track: makeTrack([hlsMp3]),
    onRequest: (url) => {
      if (url.pathname === '/resolve') resolveCalls++;
    },
  });
  const inner = globalThis.fetch;
  let rejectedOnce = false;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString());
    if (url.pathname === '/resolve' && !rejectedOnce) {
      rejectedOnce = true;
      return new Response('expired', { status: 401 });
    }
    return inner(input);
  };
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    assert.equal(track.title, 'My Song / Remix');
    assert.equal(rejectedOnce, true);
  } finally {
    globalThis.fetch = inner;
    restore();
  }
});

// --- the two API handlers over a real local HTTP server -------------------

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    // Use http.get so the test is not affected by the fetch override.
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

test('GET /api/info returns the preview card data', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: makeTrack([hlsMp3]) });
  const server = await serve(infoHandler);
  try {
    const res = await get(server.address().port, '/api/info?url=' + encodeURIComponent('https://soundcloud.com/a/b'));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {
      kind: 'track',
      title: 'My Song / Remix',
      artist: 'Some Artist',
      artwork: 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg',
      durationMs: 61000,
      downloadable: true,
      reason: null,
    });
  } finally {
    server.close();
    restore();
  }
});

test('GET /api/info reports a preview-only track as not downloadable', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: makeTrack([{ ...hlsMp3, snipped: true }]) });
  const server = await serve(infoHandler);
  try {
    const res = await get(server.address().port, '/api/info?url=' + encodeURIComponent('https://soundcloud.com/a/b'));
    const data = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.equal(data.downloadable, false);
    assert.match(data.reason, /30 second preview/);
  } finally {
    server.close();
    restore();
  }
});

test('GET /api/info answers 400 with a message for a bad link', async () => {
  const server = await serve(infoHandler);
  try {
    const res = await get(server.address().port, '/api/info?url=' + encodeURIComponent('https://example.com/x'));
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /not a soundcloud\.com link/);
  } finally {
    server.close();
  }
});

test('GET /api/download streams an MP3 with a download filename', async () => {
  sc.resetClientIdCache();
  const audio = [0, 1, 2].map((n) => Buffer.alloc(50, n + 1));
  const restore = installFakeSoundCloud({ track: makeTrack([hlsMp3]), segments: audio });
  const server = await serve(downloadHandler);
  try {
    const res = await get(server.address().port, '/api/download?url=' + encodeURIComponent('https://soundcloud.com/a/b'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.match(res.headers['content-disposition'], /^attachment; filename="Some Artist - My Song Remix\.mp3"/);
    assert.deepEqual(res.body, Buffer.concat(audio));
  } finally {
    server.close();
    restore();
  }
});

test('GET /api/download answers with a JSON error instead of a broken file', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: makeTrack([hlsOpus]) });
  const server = await serve(downloadHandler);
  try {
    const res = await get(server.address().port, '/api/download?url=' + encodeURIComponent('https://soundcloud.com/a/b'));
    assert.equal(res.status, 422);
    assert.match(res.headers['content-type'], /application\/json/);
  } finally {
    server.close();
    restore();
  }
});

// --- playlists ------------------------------------------------------------

function playlistFixture(trackCount, { fullCount = 1 } = {}) {
  const tracksById = {};
  const stubs = [];
  for (let i = 1; i <= trackCount; i++) {
    const t = makeTrack(i === 3 ? [{ ...hlsMp3, snipped: true }] : [hlsMp3], {
      id: i,
      title: `Song ${i}`,
      user: { username: i === 2 ? 'Other Artist' : 'Some Artist' },
    });
    tracksById[i] = t;
    stubs.push(i <= fullCount ? t : { id: i, kind: 'track' }); // later tracks arrive as bare ids
  }
  const playlist = {
    kind: 'playlist',
    title: 'My: Playlist?',
    user: { username: 'List Owner' },
    artwork_url: null,
    track_count: trackCount,
    tracks: stubs,
  };
  return { playlist, tracksById };
}

test('lookup lists playlist tracks in order, filling in bare track ids', async () => {
  sc.resetClientIdCache();
  const { playlist, tracksById } = playlistFixture(4);
  const batches = [];
  const restore = installFakeSoundCloud({
    track: playlist,
    tracksById,
    onRequest: (url) => {
      if (url.pathname === '/tracks') batches.push(url.searchParams.get('ids'));
    },
  });
  try {
    const info = await sc.lookup('https://soundcloud.com/list-owner/sets/my-playlist');
    assert.equal(info.kind, 'playlist');
    assert.equal(info.title, 'My: Playlist?');
    assert.equal(info.zipName, 'My Playlist.zip');
    assert.equal(info.artist, 'List Owner');
    assert.equal(info.artwork, 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg');
    assert.equal(info.truncated, false);
    assert.deepEqual(batches, ['2,3,4'], 'only the bare ids are requested, in one batch');

    assert.deepEqual(
      info.tracks.map((t) => [t.position, t.id, t.title, t.downloadable]),
      [[1, 1, 'Song 1', true], [2, 2, 'Song 2', true], [3, 3, 'Song 3', false], [4, 4, 'Song 4', true]]
    );
    assert.equal(info.tracks[1].filename, 'Other Artist - Song 2.mp3');
    assert.match(info.tracks[2].reason, /30 second preview/);
  } finally {
    restore();
  }
});

test('lookup caps a playlist at 50 tracks and says so', async () => {
  sc.resetClientIdCache();
  const { playlist, tracksById } = playlistFixture(60);
  const batches = [];
  const restore = installFakeSoundCloud({
    track: playlist,
    tracksById,
    onRequest: (url) => {
      if (url.pathname === '/tracks') batches.push(url.searchParams.get('ids').split(',').length);
    },
  });
  try {
    const info = await sc.lookup('https://soundcloud.com/list-owner/sets/big');
    assert.equal(info.tracks.length, sc.MAX_PLAYLIST_TRACKS);
    assert.equal(info.totalTracks, 60);
    assert.equal(info.truncated, true);
    assert.deepEqual(batches, [49], 'one request for the 49 bare ids, none for the 10 cut off');
  } finally {
    restore();
  }
});

test('lookup drops playlist tracks that SoundCloud no longer returns', async () => {
  sc.resetClientIdCache();
  const { playlist, tracksById } = playlistFixture(3);
  delete tracksById[2]; // deleted since the playlist was made
  const restore = installFakeSoundCloud({ track: playlist, tracksById });
  try {
    const info = await sc.lookup('https://soundcloud.com/list-owner/sets/gappy');
    assert.deepEqual(info.tracks.map((t) => t.id), [1, 3]);
  } finally {
    restore();
  }
});

test('lookup still answers for a single track and refuses profiles', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: makeTrack([hlsMp3]) });
  try {
    assert.equal((await sc.lookup('https://soundcloud.com/a/b')).kind, 'track');
  } finally {
    restore();
  }
  sc.resetClientIdCache();
  const restoreUser = installFakeSoundCloud({ track: { kind: 'user' } });
  try {
    await assert.rejects(sc.lookup('https://soundcloud.com/a'), /not a track or a playlist/);
  } finally {
    restoreUser();
  }
});

test('GET /api/download?id= streams a playlist track by id', async () => {
  sc.resetClientIdCache();
  const audio = [0, 1].map((n) => Buffer.alloc(40, n + 7));
  const { tracksById } = playlistFixture(2);
  const restore = installFakeSoundCloud({ track: {}, tracksById, segments: audio });
  const server = await serve(downloadHandler);
  try {
    const res = await get(server.address().port, '/api/download?id=2');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /^attachment; filename="Other Artist - Song 2\.mp3"/);
    assert.deepEqual(res.body, Buffer.concat(audio));
  } finally {
    server.close();
    restore();
  }
});

test('GET /api/download?id= rejects bad ids and reports missing tracks', async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: {}, tracksById: {} });
  const server = await serve(downloadHandler);
  try {
    const port = server.address().port;
    const bad = await get(port, '/api/download?id=' + encodeURIComponent('1/../../secret'));
    assert.equal(bad.status, 400);
    const missing = await get(port, '/api/download?id=999');
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    restore();
  }
});
