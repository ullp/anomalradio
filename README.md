# anomalradio

Website and 24/7 radio for **[Anomalradio.com](https://anomalradio.com)** — a station that plays only its own music.

> **Status: M2.** The catalogue lives in SQLite, audio lives in private storage outside the web root (this
> machine's disk, or any S3-compatible bucket), stream tokens are real HMACs with a request cap, and shared track
> links unfurl with proper meta tags. Still to come: the continuous Icecast stream (M3), accounts and share
> previews (M4), the shop (M5), the admin (M6) and go-live (M7) — see
> [`_data/design-offer.md`](_data/design-offer.md).

---

## Quick start

```bash
npm run import -- --publish   # scan _data/music → private storage + SQLite + data/tracks.json
npm run dev                   # http://localhost:3000
npm test                      # the contract suite
```

Requirements: **Node 22+** (uses the built-in `node:sqlite`) and **ffmpeg/ffprobe** on `PATH` for
`npm run import`. There are **no runtime dependencies** — the server, the database layer, the S3 signing and the
HTTP stack are all Node standard library.

```bash
PORT=4000 npm run dev                      # different port
DEMO_TIME_SCALE=0.05 npm run dev           # broadcast clock runs 20× faster (watch track changes)
node scripts/import-tracks.js --dry-run    # report what an import would do
node scripts/import-tracks.js --help       # every import flag
node scripts/fetch-fonts.js                # (re)download the self-hosted web fonts
```

## Where the music goes, and where it ends up

Drop your MP3s anywhere under **`_data/music/`** (subfolders are scanned recursively), then run
`npm run import`. Audio is **never** committed to Git and never served from the web root.

```
_data/music/dwp/01-Come.mp3        ← your import folder (git-ignored)
        │  npm run import
        ▼
media/tracks/ar_Kt0j2bAUde.mp3     ← private storage (git-ignored, outside public/)
data/anomalradio.db                ← catalogue, favourites, baskets, issued tokens
data/tracks.json                   ← readable metadata export (committed, for review)
```

What one run does, per file:

1. hashes the file (SHA-256) and probes it with ffprobe
2. works out its id — an existing database row wins, so ids survive moves and renames
3. copies the audio into private storage (`tracks/<id>.mp3`, or a private bucket)
4. upserts the database row, keeping publication state, price and cover that were already set
5. optionally writes a loudness-normalised master for the radio (`--normalise`)
6. writes the readable metadata export

**Publication is deliberately conservative** — a new file cannot go live by accident:

| Situation                                         | Result                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| existing database row                             | keeps its own published/featured flags                              |
| no row, but the previous JSON export knows the id | inherits its state (this is how the original catalogue stayed live) |
| genuinely new file                                | **draft** unless `--publish` is given                               |
| a draft you now want live                         | `--publish-existing` (or the admin, from M6)                        |

Other flags: `--metadata-only` (probe + export, touch neither storage nor database), `--dry-run`,
`--normalise`, `--prune` (report rows whose source file disappeared — never deletes), `--source`, `--out`, `--db`.

Re-running is safe and cheap: files already in storage are recognised by content hash, so nothing is copied twice,
ids do not move, and a renamed file keeps its identity.

### Storage drivers

One environment variable switches where audio lives:

|                                | `STORAGE_DRIVER=local`                      | `STORAGE_DRIVER=s3` (R2 / B2 / Wasabi / MinIO / AWS)                                                |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Where files live               | `media/` on this machine, outside `public/` | private bucket, no public policy                                                                    |
| How audio reaches the listener | streamed by the app                         | streamed by the app (`S3_PROXY=true`, default) or 302 to a presigned URL (`S3_PROXY=false`)         |
| Bucket hostname visible?       | n/a                                         | **no** in proxy mode — the app stays the only door                                                  |
| Signature                      | n/a                                         | hand-rolled SigV4, verified against the AWS documentation example and an independent implementation |

Switching is `STORAGE_DRIVER=s3` plus the `S3_*` values and one `npm run import` (which uploads whatever is missing).

## Project layout

```
_data/                     source material: brief, offer, logo, music (music + audio are git-ignored)
data/tracks.json           generated library index (metadata only, no audio)
public/                    the website — the only thing a web server should ever serve
  assets/css/              tokens · base · components · player
  assets/js/               api · store · ui · cover · visualizer · player · share · pages
  assets/fonts/            Orbitron, Inter, JetBrains Mono (SIL OFL 1.1, self-hosted)
  assets/img/              logo lockup + signal mark + favicons + social card
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

## Security model

1. **Storage isolation** — audio lives outside the web root (or in a private bucket) and is addressed only by
   opaque ids. Requests for `.mp3`-style paths, the database, `.env` or source files return **404**, not 403 —
   existence is never confirmed.
2. **The indirection rule** — `sanitizeTrack()` strips `storageKey`, `streamKey`, `sourcePath`, `originalName`,
   `contentHash` and `sourceFile` from every response, by name, so a new private column cannot start leaking.
3. **Real tokens** — `GET /api/session` mints an HMAC-signed token bound to one track, one IP and one browser (all
   hashed), valid for `STREAM_TOKEN_TTL` (120 s). It is recorded in the database, so it can be revoked and counted,
   and it is capped at `MAX_REQUESTS_PER_TOKEN` requests: seeking needs a handful, while a ripper looping over byte
   ranges hits the cap and is cut off.
4. **Browser context required** — a token is only issued to requests with an allowed `Origin`/`Referer`
   (`ALLOWED_ORIGINS`), which is what stops hotlinking from other sites.
5. **Anti-ripper rules** — `curl`, `wget`, `ffmpeg`, `streamripper`, `yt-dlp` and friends are refused on audio
   routes; token minting and audio requests are rate limited per IP; concurrent streams per IP are capped.
6. **Client deterrents** — `controlsList="nodownload"`, no download attribute, no inline scripts anywhere — all
   cosmetic, and labelled as such on `/about/#security`.

Every one of these is enforced by the test suite below, and by CI on each push.

Try to break it locally (all of these are expected to fail):

```bash
curl -s http://localhost:3000/api/session                        # blocked-user-agent
curl -s -A "Mozilla/5.0" http://localhost:3000/api/session       # forbidden-origin
curl -s "http://localhost:3000/api/stream/ar_Kt0j2bAUde"         # stream-denied: missing-token
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://localhost:3000/_data/music/dwp/01-Come.mp3"            # 404 — audio is not in the web root
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:3000/data/anomalradio.db                      # 404 — nor is the database
```

### Scaling note

Rate-limit buckets and the per-IP stream counter live in **process memory**, which is correct for the single
instance this milestone targets. Running two Node instances behind nginx would make those caps per-instance — move
them into SQLite (the `stream_tokens` table already records every issued token) before scaling out.

## Testing

```bash
npm test                            # all suites (~8 s, 119 cases)
npm test -- tests/security.test.js  # one file
```

The suite is the executable version of the security promises above — if one of these fails, the site is leaking
something it claims not to leak. It has already caught four real defects, including a storage-path leak waiting to
happen in M2 and an XSS vector in the server-rendered structured data.

| File                      | What it pins                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `security.test.js`        | the indirection rule, storage isolation, session and stream gating, response hardening, byte ranges, method safety |
| `api-contract.test.js`    | response shapes, status codes, MIME types, the SSE feed, `sanitizeTrack`                                           |
| `broadcast-clock.test.js` | the on-air clock is a pure function of time: gapless history, cyclic rotation, progress                            |
| `tokens.test.js`          | HMAC signature, expiry, track/IP/browser binding, the request cap, revocation, per-IP stats                        |
| `importer.test.js`        | import pipeline: storage copy, content-hash rename detection, publication rules, idempotency, exports              |
| `render.test.js`          | server-rendered meta tags, structured data, escaping of untrusted metadata                                         |
| `storage.test.js`         | SigV4 against the AWS documentation example and an independent implementation, local driver, key safety            |
| `limit-streams.test.js`   | the per-IP concurrency cap holds with genuinely parallel connections                                               |
| `limit-rate.test.js`      | token minting is rate limited                                                                                      |
| `token-expiry.test.js`    | a token stops working once its TTL passes                                                                          |
| `library.test.js`         | the real catalogue matches the audio on disk and ids stay stable (skips without `_data/music`)                     |

All but the last run against a **committed fixture library** (`tests/fixtures/`: two 800 ms
generated MP3s plus an index produced by the real scanner), so they are hermetic, fast and
independent of your private music folder. `library.test.js` is the only suite that touches
`_data/music`, and it skips itself with a clear message when that folder or ffprobe is missing.

Because the tests are the contract, `scripts/serve.js` exposes a small test surface
(`createServer`, `startServer({ port: 0 })`, `config`, `sanitizeTrack`, `broadcastState`) and reads
its configuration at import time — environment overrides must be set _before_ importing it, which
is what `tests/helpers/server.js` does.

CI runs the linter and the suite on every push and pull request (`.github/workflows/test.yml`); on
CI, `library.test.js` skips itself because audio is never committed.

## Roadmap

| Milestone | Scope                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **M0** ✅ | repo, tooling, design tokens, project skeleton                                                                                     |
| **M1** ✅ | clickable design prototype + working player over a stub API                                                                        |
| **M2** ✅ | SQLite catalogue, private storage (local/S3), real HMAC tokens with a request cap, import pipeline, server-rendered share metadata |
| **M3**    | continuous radio: ffmpeg → Icecast mount with `stream_auth` validation, ICY metadata                                               |
| **M4**    | favourites accounts, per-track OG tags, share previews                                                                             |
| **M5**    | basket checkout (Stripe or external buy links) + watermarked downloads                                                             |
| **M6**    | `/admin`: upload, metadata, covers, rotation weights, dashboard                                                                    |
| **M7**    | deployment on `81.2.196.19`: nginx, TLS, backups, monitoring, abuse testing                                                        |

Details, effort estimates and open decisions: [`_data/design-offer.md`](_data/design-offer.md).

## Deployment (planned, M7)

`anomalradio.com` → `81.2.196.19` behind nginx with a Let's Encrypt wildcard certificate (the existing
`*.anomalradio.com` CNAME already allows `stream.` and `beta.` hosts). The app runs on systemd or Docker Compose with
Icecast alongside; media lives on a separate volume, with nightly offsite backups.

## Licensing

Site code © Anomalradio.com. Audio under `_data/music/` is **not** part of the repository and remains the property of
its authors. Web fonts are SIL Open Font License 1.1 (see `public/assets/fonts/manifest.json`).
