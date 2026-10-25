'use strict';

// These tests run the real ffmpeg on a real AAC-in-fragmented-MP4 HLS stream,
// the format SoundCloud serves today. They need ffmpeg and ffprobe on the
// PATH to build the sample stream, and skip themselves without them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sc = require('../lib/soundcloud');
const { installFakeSoundCloud, makeTrack, aac160, aac96, abrSq } = require('./helpers');

function haveTool(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const canRun = haveTool('ffmpeg') && haveTool('ffprobe');
const SECONDS = 25;

function buildAacStream() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-aac-'));
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '10', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg%d.m4s'), path.join(dir, 'playlist.m3u8'),
  ]);
  const files = {};
  for (const name of fs.readdirSync(dir)) if (name !== 'playlist.m3u8') files[name] = fs.readFileSync(path.join(dir, name));
  const playlist = fs.readFileSync(path.join(dir, 'playlist.m3u8'), 'utf8');
  fs.rmSync(dir, { recursive: true });
  return { playlist, files };
}

async function readAll(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function probe(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-out-')), 'out.mp3');
  fs.writeFileSync(file, buffer);
  const out = JSON.parse(
    execFileSync('ffprobe', ['-loglevel', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString()
  );
  fs.rmSync(path.dirname(file), { recursive: true });
  return out;
}

test('an AAC-only track comes out as a real MP3 with title and artist tags', { skip: !canRun }, async () => {
  sc.resetClientIdCache();
  const aacFiles = buildAacStream();
  assert.match(aacFiles.playlist, /EXT-X-MAP/, 'sample stream is fragmented MP4 like SoundCloud');
  const restore = installFakeSoundCloud({ track: makeTrack([aac96, abrSq, aac160]), aacFiles });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const { body, contentLength } = await sc.openMp3Stream(track);
    assert.equal(contentLength, null);

    const info = probe(await readAll(body));
    assert.equal(info.streams.length, 1);
    assert.equal(info.streams[0].codec_name, 'mp3');
    assert.equal(info.format.format_name, 'mp3');
    assert.ok(Math.abs(Number(info.format.duration) - SECONDS) < 0.6, `duration ${info.format.duration}`);
    assert.equal(info.format.tags.title, 'My Song / Remix');
    assert.equal(info.format.tags.artist, 'Some Artist');
  } finally {
    restore();
  }
});

test('odd characters in a title do not break the conversion', { skip: !canRun }, async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({
    track: makeTrack([aac160], { title: '-Beyoncé "Halo"\n; rm -rf / $(x) –', user: { username: '--artist' } }),
    aacFiles: buildAacStream(),
  });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const info = probe(await readAll((await sc.openMp3Stream(track)).body));
    assert.equal(info.format.tags.title, '-Beyoncé "Halo" ; rm -rf / $(x) –');
    assert.equal(info.format.tags.artist, '--artist');
  } finally {
    restore();
  }
});

test('garbage audio is reported before any bytes are sent', { skip: !canRun }, async () => {
  sc.resetClientIdCache();
  const aacFiles = buildAacStream();
  for (const name of Object.keys(aacFiles.files)) aacFiles.files[name] = Buffer.from('this is not audio '.repeat(50));
  const restore = installFakeSoundCloud({ track: makeTrack([aac160]), aacFiles });
  const logged = console.error;
  console.error = () => {};
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    await assert.rejects(sc.openMp3Stream(track), /Could not convert/);
  } finally {
    console.error = logged;
    restore();
  }
});

test('a missing piece fails the download instead of giving a short file quietly', { skip: !canRun }, async () => {
  sc.resetClientIdCache();
  const aacFiles = buildAacStream();
  delete aacFiles.files['seg1.m4s'];
  const restore = installFakeSoundCloud({ track: makeTrack([aac160]), aacFiles });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const { body } = await sc.openMp3Stream(track);
    await assert.rejects(readAll(body), /Lost the connection/);
  } finally {
    restore();
  }
});

test('stopping the download early stops the converter', { skip: !canRun }, async () => {
  sc.resetClientIdCache();
  const restore = installFakeSoundCloud({ track: makeTrack([aac160]), aacFiles: buildAacStream() });
  try {
    const track = await sc.resolveTrack('https://soundcloud.com/some-artist/my-song');
    const { body } = await sc.openMp3Stream(track);
    for await (const chunk of body) {
      assert.ok(chunk.length > 0);
      body.destroy(); // the browser closed the connection
      break;
    }
    assert.ok(body.destroyed);
  } finally {
    restore();
  }
});
