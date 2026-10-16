'use strict';

const { Readable } = require('node:stream');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_ORIGIN = 'https://api-v2.soundcloud.com';
const PAGE_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com']);
const REQUEST_TIMEOUT_MS = 15000;
const SEGMENT_CONCURRENCY = 4;

class ScError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ScError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// URL checks. The server only ever fetches hosts that belong to SoundCloud.
// ---------------------------------------------------------------------------

function isTrustedHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === 'soundcloud.com' ||
    h.endsWith('.soundcloud.com') ||
    h.endsWith('.sndcdn.com') ||
    h.endsWith('.soundcloud.cloud')
  );
}

function assertTrusted(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new ScError('SoundCloud sent a broken media link.', 502);
  }
  if (u.protocol !== 'https:' || !isTrustedHost(u.hostname)) {
    throw new ScError('SoundCloud sent a media link from an unexpected host.', 502);
  }
  return u;
}

function parseTrackUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new ScError('Paste a SoundCloud track link first.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ScError("That doesn't look like a link.");
  }
  if (!PAGE_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ScError('That is not a soundcloud.com link.');
  }

  const secret = u.searchParams.get('secret_token');
  u.protocol = 'https:';
  u.hash = '';
  u.search = '';
  if (secret) u.searchParams.set('secret_token', secret);
  return u;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchT(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
    });
  } catch {
    throw new ScError("Couldn't reach SoundCloud. Try again in a moment.", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const res = await fetchT(url);
  if (!res.ok) throw new ScError(`SoundCloud answered with an error (${res.status}).`, 502);
  return res.text();
}

// ---------------------------------------------------------------------------
// client_id. SoundCloud's web player embeds a public client id in its JS
// bundles. We read it once per warm function instance and reuse it. If that
// ever breaks, setting SOUNDCLOUD_CLIENT_ID in Vercel overrides it.
// ---------------------------------------------------------------------------

let cachedClientId = null;

async function getClientId(forceRefresh = false) {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;
  if (cachedClientId && !forceRefresh) return cachedClientId;

  const html = await fetchText('https://soundcloud.com/');
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
    (m) => m[1]
  );

  // The id is usually in one of the last few bundles.
  for (const src of scripts.slice(-6).reverse()) {
    let js;
    try {
      js = await fetchText(src);
    } catch {
      continue;
    }
    const m = js.match(/client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/);
    if (m) {
      cachedClientId = m[1];
      return cachedClientId;
    }
  }
  throw new ScError('Could not get access to SoundCloud right now. Try again later.', 502);
}

function resetClientIdCache() {
  cachedClientId = null;
}

// GET against api-v2 with the client id attached. One retry with a fresh id
// when SoundCloud rejects the cached one.
async function apiGet(target, params = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const clientId = await getClientId(attempt > 0);
    const u = new URL(target, API_ORIGIN);
    assertTrusted(u.toString());
    for (const [key, value] of Object.entries(params)) {
      if (value != null) u.searchParams.set(key, value);
    }
    u.searchParams.set('client_id', clientId);

    const res = await fetchT(u);
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    return res;
  }
  throw new ScError('SoundCloud refused the request.', 502);
}

// ---------------------------------------------------------------------------
// Track lookup
// ---------------------------------------------------------------------------

async function expandShortLink(u) {
  if (u.hostname.toLowerCase() !== 'on.soundcloud.com') return u;
  const res = await fetchT(u, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new ScError("Couldn't open that short link.", 404);
  return parseTrackUrl(new URL(location, u).toString());
}

async function resolveTrack(input) {
  const page = await expandShortLink(parseTrackUrl(input));
  const res = await apiGet('/resolve', { url: page.toString() });

  if (res.status === 404) {
    throw new ScError('SoundCloud could not find that track. It may be private or deleted.', 404);
  }
  if (!res.ok) throw new ScError(`SoundCloud answered with an error (${res.status}).`, 502);

  const data = await res.json();
  if (data.kind === 'playlist') {
    throw new ScError('That is a playlist or set link. Paste the link to a single track instead.');
  }
  if (data.kind !== 'track') {
    throw new ScError('That link is not a track. Paste the link to a single track.');
  }
  return data;
}

// Chooses which stream to download: a full-length MP3, progressive first
// (one plain file), HLS second (many small pieces we stitch together).
function pickTranscoding(track) {
  const transcodings = track.media?.transcodings ?? [];
  const mp3 = transcodings.filter((t) => t?.url && /^audio\/mpeg/i.test(t.format?.mime_type ?? ''));
  const full = mp3.filter((t) => !t.snipped);

  const chosen =
    full.find((t) => t.format?.protocol === 'progressive') ?? full.find((t) => t.format?.protocol === 'hls');
  if (chosen) return chosen;

  if (mp3.length > 0 && full.length === 0) {
    throw new ScError(
      'SoundCloud only offers a 30 second preview of this track (Go+ or region locked), so it cannot be downloaded.',
      422
    );
  }
  throw new ScError('This track has no downloadable MP3 stream.', 422);
}

function upgradeArtwork(artworkUrl) {
  if (!artworkUrl) return null;
  const bigger = String(artworkUrl).replace('-large.', '-t500x500.');
  try {
    const u = new URL(bigger);
    return u.protocol === 'https:' && isTrustedHost(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

function describeTrack(track) {
  let downloadable = true;
  let reason = null;
  try {
    pickTranscoding(track);
  } catch (err) {
    if (!(err instanceof ScError)) throw err;
    downloadable = false;
    reason = err.message;
  }
  return {
    title: track.title || 'Untitled track',
    artist: track.user?.username || null,
    artwork: upgradeArtwork(track.artwork_url || track.user?.avatar_url),
    durationMs: track.full_duration ?? track.duration ?? null,
    downloadable,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Streaming the audio
// ---------------------------------------------------------------------------

async function getStreamUrl(track, transcoding) {
  const res = await apiGet(transcoding.url, { track_authorization: track.track_authorization });
  if (!res.ok) {
    throw new ScError('SoundCloud refused to hand out a stream for this track.', res.status === 404 ? 404 : 502);
  }
  const data = await res.json();
  return assertTrusted(data.url).toString();
}

async function openProgressive(url) {
  const res = await fetchT(url);
  if (!res.ok || !res.body) throw new ScError('Could not start the audio stream.', 502);
  const length = Number(res.headers.get('content-length'));
  return {
    body: Readable.fromWeb(res.body),
    contentLength: Number.isFinite(length) && length > 0 ? length : null,
  };
}

function parsePlaylist(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, baseUrl).toString());
}

// MP3 pieces in an HLS stream can start with an ID3 timing tag. Remove it so
// the stitched file is one clean run of MP3 frames.
function stripId3(buf) {
  let offset = 0;
  while (buf.length - offset >= 10 && buf.toString('latin1', offset, offset + 3) === 'ID3') {
    const size =
      ((buf[offset + 6] & 0x7f) << 21) |
      ((buf[offset + 7] & 0x7f) << 14) |
      ((buf[offset + 8] & 0x7f) << 7) |
      (buf[offset + 9] & 0x7f);
    const footer = buf[offset + 5] & 0x10 ? 10 : 0;
    offset += 10 + size + footer;
  }
  return offset ? buf.subarray(Math.min(offset, buf.length)) : buf;
}

async function fetchSegment(url, tries = 3) {
  assertTrusted(url);
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchT(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      // try again
    }
  }
  throw new ScError('Lost the connection to SoundCloud while downloading.', 502);
}

// Downloads segments a few at a time but hands them back in playlist order.
function createSegmentFetcher(urls) {
  let nextToStart = 0;
  const pending = [];

  const start = () => {
    if (nextToStart >= urls.length) return;
    const promise = fetchSegment(urls[nextToStart++]);
    promise.catch(() => {}); // a failure is reported when this segment's turn comes
    pending.push(promise);
  };
  for (let i = 0; i < SEGMENT_CONCURRENCY; i++) start();

  return async function next() {
    const promise = pending.shift();
    if (!promise) return null;
    start();
    return stripId3(await promise);
  };
}

async function openHls(playlistUrl) {
  let base = playlistUrl;
  let text = await fetchText(base);

  // A master playlist points at variants. Follow the first one.
  if (text.includes('#EXT-X-STREAM-INF')) {
    base = parsePlaylist(text, base)[0];
    if (!base) throw new ScError('SoundCloud sent an empty stream list.', 502);
    assertTrusted(base);
    text = await fetchText(base);
  }

  const urls = parsePlaylist(text, base);
  if (urls.length === 0) throw new ScError('SoundCloud sent an empty stream list.', 502);

  const next = createSegmentFetcher(urls);
  const first = await next(); // fail now, before any response headers go out

  async function* chunks() {
    yield first;
    for (let chunk = await next(); chunk !== null; chunk = await next()) yield chunk;
  }
  return { body: Readable.from(chunks(), { objectMode: false }), contentLength: null };
}

async function openMp3Stream(track) {
  const transcoding = pickTranscoding(track);
  const streamUrl = await getStreamUrl(track, transcoding);
  return transcoding.format.protocol === 'progressive' ? openProgressive(streamUrl) : openHls(streamUrl);
}

// ---------------------------------------------------------------------------
// File name
// ---------------------------------------------------------------------------

function safeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || 'soundcloud-track';
}

function contentDisposition(name) {
  const file = safeFilename(name) + '.mp3';
  const ascii = file.replace(/[^\x20-\x7e]/g, '_').replace(/["%]/g, '_');
  const encoded = encodeURIComponent(file).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  ScError,
  parseTrackUrl,
  resolveTrack,
  pickTranscoding,
  describeTrack,
  upgradeArtwork,
  openMp3Stream,
  parsePlaylist,
  stripId3,
  safeFilename,
  contentDisposition,
  resetClientIdCache,
};
