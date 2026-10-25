# SoundCloud to MP3

Paste a SoundCloud track link, see the artwork and title, download the MP3. Paste a playlist link and download every track in one ZIP.

One static page (`public/`) and two Vercel serverless functions:

| Route | What it does |
| --- | --- |
| `GET /api/info?url=...` | Looks up a track or playlist and returns title, artist, artwork, length and whether each track can be downloaded. For a playlist it lists the tracks (up to 50). |
| `GET /api/download?url=...` | Streams one track back as an `.mp3` file named `Artist - Title.mp3` |
| `GET /api/download?id=...` | Same, for a track id. The playlist ZIP uses this. |

### How playlist ZIPs work

The server never builds the ZIP. A playlist of 15 songs would not finish inside Vercel's 60 second function limit. Instead the page asks `/api/download?id=...` for one track at a time, each as its own short function call, and packs the files into a ZIP in the browser (`public/zip.js`, no library). Keep the tab open until the ZIP is saved.

There is no build step. The one dependency is `@ffmpeg-installer/ffmpeg`, which ships the ffmpeg program used to convert audio to MP3.

## Deploy on Vercel

1. Push this repo to GitHub.
2. In Vercel choose **Add New... > Project** and import the repo.
3. Leave every setting on its default and press **Deploy**. Vercel reads `vercel.json` and serves `public/` plus the `api/` functions.

If the repo has this project inside a subfolder, set **Root Directory** to that folder on the import screen.

## Run it on your own computer with a Cloudflare tunnel

This gives a public `https://something.trycloudflare.com` link without Vercel. It only works while your computer is on and both terminals below stay open.

1. Install [Node.js](https://nodejs.org) (the LTS version) and `cloudflared`. On Windows run `winget install --id Cloudflare.cloudflared`. On a Mac run `brew install cloudflared`.
2. Get this folder, open a terminal inside it, and run `npm install` once. This downloads ffmpeg.
3. Terminal one: `npm start`. It prints `SoundCloud to MP3 is running at http://localhost:3000`. Leave it running.
4. Terminal two: `cloudflared tunnel --url http://localhost:3000`. After a few seconds it prints a line with `https://....trycloudflare.com`. That is your link.

The address changes every time you start the tunnel. Anyone who has the link can use the downloader while it runs, so only share it with people you mean to. `dev/server.js` is only for this. Vercel does not use it.

## What works and what does not

- Works: public tracks that SoundCloud streams in full, and public playlists, sets and albums made of them.
- Conversion: SoundCloud now serves most tracks as AAC, not MP3. When a track has no MP3 stream the server converts the AAC to a 192 kbps MP3 with ffmpeg and adds the title and artist tags. The sound quality is that of SoundCloud's AAC original, in an MP3 wrapper. Tracks that do have an MP3 stream are passed through untouched.
- Playlists: the first 50 tracks are listed and zipped. Tracks that cannot be downloaded are skipped and marked in the list. A 50 track ZIP of normal songs needs roughly 200 MB of free browser memory, so a phone may struggle with the biggest ones. Each track also has its own MP3 button.
- Fails with a message: profile links, private tracks, and Go+ tracks that SoundCloud only previews for 30 seconds.
- Fails with a message: tracks that only exist as Opus, and tracks with copy protection.
- Short `on.soundcloud.com` links are followed.

## If it stops working

SoundCloud has no public download API, so this uses the same requests the SoundCloud website makes. It reads a public `client_id` out of SoundCloud's web player scripts. If SoundCloud changes that, downloads fail with "Could not get access to SoundCloud".

If a download fails with "Could not convert this track to MP3", check the Vercel function logs for the ffmpeg message. You can point the app at a different ffmpeg by setting the `FFMPEG_PATH` environment variable.

Quick fix for the client id problem: open soundcloud.com in a browser, open DevTools, go to the Network tab, filter for `client_id=`, and copy the 32 character value. In Vercel go to **Settings > Environment Variables**, add `SOUNDCLOUD_CLIENT_ID` with that value, and redeploy.

## Limits on Vercel's free plan

- Each download runs inside one function call capped at 60 seconds (`vercel.json`). Converting runs at roughly 40 times real time, so a 4 minute song takes about 6 seconds and a 20 minute mix about 30. A mix longer than about 40 minutes will run out of time.
- There is no rate limiting. Anyone with the link can use it, and the bandwidth counts against your Vercel plan. Do not share the URL widely.

## Run the tests

```
npm test
```

The tests use a fake SoundCloud, so they check this project's own logic only. They cannot tell you whether the real SoundCloud still answers the way the fake does.

## Use it responsibly

Only download tracks you made, tracks with a Creative Commons licence, or tracks you have permission to use. SoundCloud's terms of use and the artist's copyright still apply.
