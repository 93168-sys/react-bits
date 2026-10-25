'use strict';

const { Readable } = require('node:stream');
const { convertToMp3, ConvertError } = require('./convert');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const API_ORIGIN = 'https://api-v2.soundcloud.com';
const PAGE_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com']);
const REQUEST_TIMEOUT_MS = 15000;
const SEGMENT_CONCURRENCY = 4;
const MAX_PLAYLIST_TRACKS = 50;

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

const NOT_FOUND = 'SoundCloud could not find that track. It may be private or deleted.';

// Looks up whatever the link points at: a track, a playlist, a profile...
async function resolveLink(input) {
  const page = await expandShortLink(parseTrackUrl(input));
  const res = await apiGet('/resolve', { url: page.toString() });

  if (res.status === 404) throw new ScError(NOT_FOUND, 404);
  if (!res.ok) throw new ScError(`SoundCloud answered with an error (${res.status}).`, 502);
  return res.json();
}

async function resolveTrack(input) {
  const data = await resolveLink(input);
  if (data.kind === 'playlist') {
    throw new ScError('That is a playlist or set link. Paste the link to a single track instead.');
  }
  if (data.kind !== 'track') {
    throw new ScError('That link is not a track. Paste the link to a single track.');
  }
  return data;
}

async function resolveTrackById(id) {
  if (!/^\d{1,20}$/.test(String(id ?? ''))) throw new ScError('That is not a valid track id.');
  const res = await apiGet(`/tracks/${id}`);

  if (res.status === 404) throw new ScError(NOT_FOUND, 404);
  if (!res.ok) throw new ScError(`SoundCloud answered with an error (${res.status}).`, 502);

  const data = await res.json();
  if (data.kind !== 'track') throw new ScError(NOT_FOUND, 404);
  return data;
}

// A playlist only carries full details for its first few tracks. The rest are
// bare ids, so ask for them in batches. Order follows the playlist.
async function loadPlaylistTracks(playlist) {
  const entries = (playlist.tracks ?? []).filter(Boolean).slice(0, MAX_PLAYLIST_TRACKS);
  const missing = entries.filter((t) => !t.media).map((t) => t.id);

  const byId = new Map();
  for (let i = 0; i < missing.length; i += 50) {
    const res = await apiGet('/tracks', { ids: missing.slice(i, i + 50).join(',') });
    if (!res.ok) throw new ScError(`SoundCloud answered with an error (${res.status}).`, 502);
    for (const track of await res.json()) byId.set(track.id, track);
  }
  return entries.map((t) => (t.media ? t : byId.get(t.id))).filter(Boolean);
}

const isMp3Mime = (mime) => /^audio\/mpeg\s*(;|$)/i.test(mime ?? '');
const isAacMime = (mime) => /^audio\/mp4\b/i.test(mime ?? '') && /mp4a/i.test(mime ?? '');
const aacBitrate = (t) => Number(/aac_(\d+)k/i.exec(t.preset ?? '')?.[1] ?? 0);

// Chooses which stream to download, best first:
//   1. a full-length MP3 file (progressive)
//   2. an MP3 in HLS pieces that we stitch together
//   3. AAC in HLS pieces, which we convert to MP3 with ffmpeg
// "audio/mpegurl" (SoundCloud's adaptive playlist) looks like MP3 but is not.
function pickTranscoding(track) {
  const usable = (track.media?.transcodings ?? []).filter((t) => {
    if (!t?.url) return false;
    const { protocol, mime_type: mime } = t.format ?? {};
    if (protocol === 'progressive') return isMp3Mime(mime);
    return protocol === 'hls' && (isMp3Mime(mime) || isAacMime(mime));
  });
  const full = usable.filter((t) => !t.snipped);

  const chosen =
    full.find((t) => t.format.protocol === 'progressive') ??
    full.find((t) => t.format.protocol === 'hls' && isMp3Mime(t.format.mime_type)) ??
    full.filter((t) => isAacMime(t.format.mime_type)).sort((a, b) => aacBitrate(b) - aacBitrate(a))[0];
  if (chosen) return chosen;

  if (usable.length > 0) {
    throw new ScError(
      'SoundCloud only offers a 30 second preview of this track (Go+ or region locked), so it cannot be downloaded.',
      422
    );
  }
  throw new ScError('This track has no audio stream that can be downloaded.', 422);
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

function checkDownloadable(track) {
  try {
    pickTranscoding(track);
    return { downloadable: true, reason: null };
  } catch (err) {
    if (!(err instanceof ScError)) throw err;
    return { downloadable: false, reason: err.message };
  }
}

function trackFileBase(track) {
  const title = track.title || 'Untitled track';
  return track.user?.username ? `${track.user.username} - ${title}` : title;
}

function describeTrack(track) {
  return {
    kind: 'track',
    title: track.title || 'Untitled track',
    artist: track.user?.username || null,
    artwork: upgradeArtwork(track.artwork_url || track.user?.avatar_url),
    durationMs: track.full_duration ?? track.duration ?? null,
    ...checkDownloadable(track),
  };
}

function describePlaylist(playlist, tracks) {
  const listed = (playlist.tracks ?? []).filter(Boolean);
  const firstArt = tracks.find((t) => t.artwork_url)?.artwork_url;
  return {
    kind: 'playlist',
    title: playlist.title || 'Untitled playlist',
    artist: playlist.user?.username || null,
    artwork: upgradeArtwork(playlist.artwork_url || firstArt || playlist.user?.avatar_url),
    zipName: safeFilename(playlist.title || 'playlist') + '.zip',
    totalTracks: playlist.track_count ?? listed.length,
    truncated: listed.length > MAX_PLAYLIST_TRACKS,
    tracks: tracks.map((track, index) => ({
      id: track.id,
      position: index + 1,
      title: track.title || 'Untitled track',
      artist: track.user?.username || null,
      durationMs: track.full_duration ?? track.duration ?? null,
      filename: safeFilename(trackFileBase(track)) + '.mp3',
      ...checkDownloadable(track),
    })),
  };
}

// What the page shows after a link is pasted: one track or a whole playlist.
async function lookup(input) {
  const data = await resolveLink(input);
  if (data.kind === 'track') return describeTrack(data);
  if (data.kind === 'playlist') return describePlaylist(data, await loadPlaylistTracks(data));
  throw new ScError('That link is not a track or a playlist.');
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

// Reads an HLS playlist: the list of piece URLs, plus the "init" piece that
// MP4 based streams need before the first one.
async function loadHlsPlaylist(playlistUrl) {
  let base = playlistUrl;
  let text = await fetchText(base);

  // A master playlist points at variants. Follow the first one.
  if (text.includes('#EXT-X-STREAM-INF')) {
    base = parsePlaylist(text, base)[0];
    if (!base) throw new ScError('SoundCloud sent an empty stream list.', 502);
    assertTrusted(base);
    text = await fetchText(base);
  }
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(text)) {
    throw new ScError('This track is copy protected and cannot be downloaded.', 422);
  }

  const urls = parsePlaylist(text, base);
  if (urls.length === 0) throw new ScError('SoundCloud sent an empty stream list.', 502);

  const map = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(text);
  return { urls, initUrl: map ? new URL(map[1], base).toString() : null };
}

async function openHls(playlistUrl) {
  const { urls } = await loadHlsPlaylist(playlistUrl);

  const next = createSegmentFetcher(urls);
  const first = await next(); // fail now, before any response headers go out

  async function* chunks() {
    yield first;
    for (let chunk = await next(); chunk !== null; chunk = await next()) yield chunk;
  }
  return { body: Readable.from(chunks(), { objectMode: false }), contentLength: null };
}

// AAC streams cannot be stitched into an MP3 by joining bytes. Fetch the
// pieces in order, hand them to ffmpeg, and stream out what it encodes.
async function openAacAsMp3(playlistUrl, tags) {
  const { urls, initUrl } = await loadHlsPlaylist(playlistUrl);
  const next = createSegmentFetcher(urls);

  async function* pieces() {
    if (initUrl) yield await fetchSegment(initUrl);
    for (let chunk = await next(); chunk !== null; chunk = await next()) yield chunk;
  }

  try {
    return { body: await convertToMp3(pieces(), tags), contentLength: null };
  } catch (err) {
    if (!(err instanceof ConvertError)) throw err;
    console.error(err.message);
    throw new ScError('Could not convert this track to MP3.', 502);
  }
}

async function openMp3Stream(track) {
  const transcoding = pickTranscoding(track);
  const streamUrl = await getStreamUrl(track, transcoding);
  const { protocol, mime_type: mime } = transcoding.format;

  if (protocol === 'progressive') return openProgressive(streamUrl);
  if (isMp3Mime(mime)) return openHls(streamUrl);
  return openAacAsMp3(streamUrl, { title: track.title, artist: track.user?.username });
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
  resolveTrackById,
  lookup,
  trackFileBase,
  MAX_PLAYLIST_TRACKS,
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
