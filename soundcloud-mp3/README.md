# SoundCloud to MP3

Paste a SoundCloud track link, see the artwork and title, download the MP3.

One static page (`public/index.html`) and two Vercel serverless functions:

| Route | What it does |
| --- | --- |
| `GET /api/info?url=...` | Looks the track up and returns title, artist, artwork, length and whether it can be downloaded |
| `GET /api/download?url=...` | Streams the track back as an `.mp3` file named `Artist - Title.mp3` |

There are no dependencies and no build step.

## Deploy on Vercel

1. Push this repo to GitHub.
2. In Vercel choose **Add New... > Project** and import the repo.
3. Leave every setting on its default and press **Deploy**. Vercel reads `vercel.json` and serves `public/` plus the `api/` functions.

If the repo has this project inside a subfolder, set **Root Directory** to that folder on the import screen.

## What works and what does not

- Works: public tracks that SoundCloud streams in full.
- Fails with a message: playlists and sets, profile links, private tracks, and Go+ tracks that SoundCloud only previews for 30 seconds.
- Fails with a message: tracks that only exist as Opus or AAC. The server cannot convert audio, so it only serves tracks that SoundCloud already offers as MP3.
- Short `on.soundcloud.com` links are followed.

## If it stops working

SoundCloud has no public download API, so this uses the same requests the SoundCloud website makes. It reads a public `client_id` out of SoundCloud's web player scripts. If SoundCloud changes that, downloads fail with "Could not get access to SoundCloud".

Quick fix: open soundcloud.com in a browser, open DevTools, go to the Network tab, filter for `client_id=`, and copy the 32 character value. In Vercel go to **Settings > Environment Variables**, add `SOUNDCLOUD_CLIENT_ID` with that value, and redeploy.

## Limits on Vercel's free plan

- Each download runs inside one function call capped at 60 seconds (`vercel.json`). Normal song length tracks finish well inside that. Very long mixes and DJ sets can hit the cap.
- There is no rate limiting. Anyone with the link can use it, and the bandwidth counts against your Vercel plan. Do not share the URL widely.

## Run the tests

```
npm test
```

The tests use a fake SoundCloud, so they check this project's own logic only. They cannot tell you whether the real SoundCloud still answers the way the fake does.

## Use it responsibly

Only download tracks you made, tracks with a Creative Commons licence, or tracks you have permission to use. SoundCloud's terms of use and the artist's copyright still apply.
