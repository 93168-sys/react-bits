'use strict';

// Turns audio that arrives in pieces (SoundCloud's AAC streams) into an MP3
// stream by running ffmpeg. The pieces are fed to ffmpeg's stdin and the MP3
// is read from its stdout, so nothing is written to disk and the download can
// start before the whole track has been fetched.

const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MP3_BITRATE = '192k';

let resolvedFfmpeg = null;

// FFMPEG_PATH wins, then the binary bundled by @ffmpeg-installer/ffmpeg, then
// whatever `ffmpeg` is on the PATH.
function getFfmpegPath() {
  if (resolvedFfmpeg) return resolvedFfmpeg;

  let binary = process.env.FFMPEG_PATH || null;
  if (!binary) {
    try {
      binary = require('@ffmpeg-installer/ffmpeg').path;
    } catch {
      binary = 'ffmpeg';
    }
  }

  // Some hosts unpack files without the "run" permission. Copy the binary to
  // a writable folder and set it there.
  if (binary !== 'ffmpeg') {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch {
      const copy = path.join(os.tmpdir(), 'soundcloud-mp3-ffmpeg');
      if (!fs.existsSync(copy)) fs.copyFileSync(binary, copy);
      fs.chmodSync(copy, 0o755);
      binary = copy;
    }
  }
  resolvedFfmpeg = binary;
  return binary;
}

function cleanTag(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

class ConvertError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConvertError';
  }
}

// `source` is an async iterable of Buffers in the order ffmpeg should read them.
// Resolves with a Readable of MP3 bytes once the first bytes exist, so a broken
// stream is reported before any response headers are sent. Rejects with
// ConvertError (or the error the source threw).
async function convertToMp3(source, tags = {}) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-b:a', MP3_BITRATE,
    '-compression_level', '7', // about twice as fast as the default, same size, no audible difference at 192k
    '-id3v2_version', '3',
  ];
  const title = cleanTag(tags.title);
  const artist = cleanTag(tags.artist);
  if (title) args.push('-metadata', `title=${title}`);
  if (artist) args.push('-metadata', `artist=${artist}`);
  args.push('-f', 'mp3', 'pipe:1');

  const proc = spawn(getFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    if (stderr.length < 2000) stderr += chunk;
  });
  proc.stdin.on('error', () => {}); // ffmpeg may stop reading before we stop writing

  const spawnFailed = new Promise((_, reject) => proc.once('error', reject));
  spawnFailed.catch(() => {});
  const exited = new Promise((resolve) => proc.once('close', (code) => resolve(code)));

  let feedError = null;
  (async () => {
    try {
      for await (const chunk of source) {
        if (proc.stdin.destroyed || proc.exitCode !== null) return;
        if (!proc.stdin.write(chunk)) {
          await Promise.race([once(proc.stdin, 'drain'), once(proc.stdin, 'close')]);
        }
      }
      proc.stdin.end();
    } catch (err) {
      feedError = err;
      proc.kill('SIGKILL');
    }
  })();

  const output = proc.stdout[Symbol.asyncIterator]();
  let first;
  try {
    first = await Promise.race([output.next(), spawnFailed]);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new ConvertError(`Could not start ffmpeg: ${err.message}`);
  }
  if (first.done) {
    await exited;
    if (feedError) throw feedError;
    throw new ConvertError(`ffmpeg produced no audio. ${stderr.trim()}`);
  }

  async function* mp3() {
    try {
      yield first.value;
      for (let step = await output.next(); !step.done; step = await output.next()) yield step.value;
      const code = await exited;
      if (feedError) throw feedError;
      if (code !== 0) throw new ConvertError(`ffmpeg exited with code ${code}. ${stderr.trim()}`);
    } finally {
      proc.kill('SIGKILL'); // the reader left early, or we are done (harmless then)
    }
  }
  return Readable.from(mp3(), { objectMode: false });
}

module.exports = { convertToMp3, getFfmpegPath, ConvertError };
