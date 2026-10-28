# anomalradio

Website and 24/7 radio for **[Anomalradio.com](https://anomalradio.com)** — a station that plays only its own music.

> **Status: M1 prototype.** The design, the player, the library and the protected-stream plumbing are real and
> runnable. The production backend (private storage, SQLite, real signed tokens, continuous Icecast stream, shop,
> admin) is specified in [`_data/design-offer.md`](_data/design-offer.md) and lands in the next milestones.

---

## Quick start

```bash
npm run import     # scan _data/music, probe with ffprobe, write data/tracks.json
npm run dev        # http://localhost:3000
```

Requirements: **Node 20.6+** and **ffmpeg/ffprobe** on `PATH` (used to read audio metadata). The prototype server has
no npm dependencies — everything runs on the Node standard library.

```bash
PORT=4000 npm run dev                      # different port
DEMO_TIME_SCALE=0.05 npm run dev           # broadcast clock runs 20× faster (watch track changes)
node scripts/import-tracks.js --dry-run    # probe the library without writing anything
node scripts/fetch-fonts.js                # (re)download the self-hosted web fonts
```

## Where the music goes

Drop your MP3s anywhere under **`_data/music/`** (subfolders are scanned recursively), then run `npm run import`.

```
_data/music/
└── dwp/
    ├── 01-Come.mp3
    ├── 02-Breach.mp3
    └── …
```

The scanner reads ID3 tags (title, artist, album, year, genre, BPM, key, composer), the real duration and bitrate, and
assigns every track an **opaque, stable public id** (`ar_Kt0j2bAUde`) derived from its path and size:

```
id = "ar_" + base62(sha256(relativePath + "|" + sizeBytes))[0..10]
```

Audio is **never committed to Git** — `.gitignore` excludes `_data/music/`, `media/` and every audio extension. The
repository is public and GitHub also caps files at 100 MB.

> In the prototype the dev server reads audio straight from `_data/music/`. That is a **development-only shortcut**:
> M2 copies the files into private storage outside the web root (or a private bucket) and serves them only by id.

## Project layout

```
_data/                     source material: brief, offer, logo, music (music + audio are git-ignored)
data/tracks.json           generated library index (metadata only, no audio)
public/                    the website — the only thing a web server should ever serve
  assets/css/              tokens · base · components · player
  assets/js/               api · store · ui · cover · visualizer · player · share · pages
  assets/fonts/            Orbitron, Inter, JetBrains Mono (SIL OFL 1.1, self-hosted)
  assets/img/              logo lockup + waveform mark + favicons + social card
scripts/serve.js           zero-dependency prototype server (static + stub API + dev audio)
scripts/import-tracks.js   library scanner → data/tracks.json
scripts/fetch-fonts.js     one-off self-hosted font fetch
```

## Pages

| Route          | What it does                                                                              |
| -------------- | ----------------------------------------------------------------------------------------- |
| `/`            | hero, live on-air panel, last five tracks, featured grid                                  |
| `/player/`     | the radio console — now-playing, visualizer, last 15 tracks, `?popup=1` for a mini player |
| `/tracks/`     | library with search and sorting                                                           |
| `/track/<id>`  | track permalink: facts, waveform, star / basket / share, buy box                          |
| `/favourites/` | starred tracks, play-all, `.m3u` export                                                   |
| `/cart/`       | basket and totals (checkout is M5)                                                        |
| `/about/`      | how the station works, the security model in plain language, terms, privacy               |

Keyboard: `space` play/pause · `←/→` seek · `↑/↓` volume · `S` star · `B` basket · `C` copy link.

## API (prototype shape — production keeps the same contract)

| Endpoint                      | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `GET /api/playlist`           | published tracks, **without** any storage path                  |
| `GET /api/tracks/:id`         | one track's public metadata                                     |
| `GET /api/now-playing`        | on-air snapshot: current track, next, last 15, listeners        |
| `GET /api/now-playing/stream` | the same, as server-sent events                                 |
| `GET /api/radio`              | what live mode needs: current track + how far in we already are |
| `GET /api/session`            | mint a short-lived stream token (requires a browser context)    |
| `GET /api/stream/:id?t=…`     | audio, gated by that token, with HTTP range support             |
| `GET /healthz`                | liveness                                                        |

## Security model (implemented here, hardened in M2)

1. **Storage isolation** — audio is never served as a file; requests for `.mp3`-style paths return 404.
2. **Opaque ids** — `sourceFile` never leaves the server (`sanitizeTrack` in `scripts/serve.js`).
3. **Token gating** — a token is required for every stream request; it is bound to the requesting IP and User-Agent,
   expires in ~120 s, and is issued only to requests carrying a browser context (no `Origin`/`Referer` → refused).
4. **Anti-ripper rules** — `curl`, `wget`, `ffmpeg`, `streamripper`, `yt-dlp` and friends are refused on audio routes;
   per-IP concurrency is capped.
5. **Client deterrents** — cosmetic only, and labelled as such in the code and on `/about/#security`.

Try to break it locally (all of these are expected to fail):

```bash
curl -s http://localhost:3000/api/session                     # blocked-user-agent
curl -s -A "Mozilla/5.0" http://localhost:3000/api/session    # forbidden-origin
curl -s "http://localhost:3000/api/stream/ar_Kt0j2bAUde"      # stream-denied: missing-token
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://localhost:3000/_data/music/dwp/01-Come.mp3"         # 404 — audio is not in the web root
```

## Roadmap

| Milestone | Scope                                                                                |
| --------- | ------------------------------------------------------------------------------------ |
| **M0** ✅ | repo, tooling, design tokens, project skeleton                                       |
| **M1** ✅ | clickable design prototype + working player over a stub API (this build)             |
| **M2**    | SQLite library, private storage driver (local/S3), real HMAC tokens, import pipeline |
| **M3**    | continuous radio: ffmpeg → Icecast mount with `stream_auth` validation, ICY metadata |
| **M4**    | favourites accounts, per-track OG tags, share previews                               |
| **M5**    | basket checkout (Stripe or external buy links) + watermarked downloads               |
| **M6**    | `/admin`: upload, metadata, covers, rotation weights, dashboard                      |
| **M7**    | deployment on `81.2.196.19`: nginx, TLS, backups, monitoring, abuse testing          |

Details, effort estimates and open decisions: [`_data/design-offer.md`](_data/design-offer.md).

## Deployment (planned, M7)

`anomalradio.com` → `81.2.196.19` behind nginx with a Let's Encrypt wildcard certificate (the existing
`*.anomalradio.com` CNAME already allows `stream.` and `beta.` hosts). The app runs on systemd or Docker Compose with
Icecast alongside; media lives on a separate volume, with nightly offsite backups.

## Licensing

Site code © Anomalradio.com. Audio under `_data/music/` is **not** part of the repository and remains the property of
its authors. Web fonts are SIL Open Font License 1.1 (see `public/assets/fonts/manifest.json`).
