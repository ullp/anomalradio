# anomalradio

Website and 24/7 radio for **[Anomalradio.com](https://anomalradio.com)** — a station that plays only its own music.

> **Status: M3.** The catalogue lives in SQLite, audio lives in private storage outside the web root (this
> machine's disk, or any S3-compatible bucket), stream tokens are real HMACs with a request cap, and shared track
> links unfurl with proper meta tags, and **live mode is a real continuous stream**: one endless mount with
> ICY metadata, fanned out to every listener and paced to real time. Favourites live on the station with magic-link accounts (M4). Still to come: the shop (M5),
> the admin (M6) and running it on a Node host (M7) — see
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

| Endpoint                                 | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/playlist`                      | published tracks, **without** any storage path                   |
| `GET /api/tracks/:id`                    | one track's public metadata, plus `starred` for the caller       |
| `GET /api/now-playing`                   | on-air snapshot: current track, next, last 15, listeners         |
| `GET /api/now-playing/stream`            | the same, as server-sent events                                  |
| `GET /api/radio`                         | what live mode needs: current track + how far in we already are  |
| `GET /api/session`                       | mint a short-lived stream token (requires a browser context)     |
| `GET /api/stream/:id?t=…`                | audio, gated by that token, with HTTP range support              |
| `GET /api/preview/:id`                   | the 30 s public excerpt — no token, and never the master (M4)    |
| `GET`/`POST`/`DELETE` `/api/favourites`  | the caller's ★ list (account, or an anonymous owner cookie) (M4) |
| `POST /api/tracks/:id/share`             | ⇪ count a share; returns the new total (M4)                      |
| `POST /api/auth/magic-link`              | e-mail a single-use sign-in link (M4)                            |
| `GET /api/auth/verify?token=…`           | consume the link, set the session cookie (M4)                    |
| `GET /api/auth/session` · `POST /logout` | who is signed in; end it (M4)                                    |
| `GET /healthz`                           | liveness                                                         |

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
npm test                            # all suites (~35 s, 221 cases)
npm test -- tests/security.test.js  # one file
```

The suite is the executable version of the security promises above — if one of these fails, the site is leaking
something it claims not to leak. It has already caught real defects, including a storage-path leak waiting to
happen in M2, an XSS vector in the server-rendered structured data, an unthrottled mount that behaved like a bulk
download, and a station file that no player could actually use.

| File                      | What it pins                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.test.js`        | the indirection rule, storage isolation, session and stream gating, response hardening, byte ranges, method safety                              |
| `api-contract.test.js`    | response shapes, status codes, MIME types, the SSE feed, `sanitizeTrack`                                                                        |
| `broadcast-clock.test.js` | the on-air clock is a pure function of time: gapless history, cyclic rotation, progress                                                         |
| `tokens.test.js`          | HMAC signature, expiry, track/IP/browser binding, the request cap, revocation, per-IP stats                                                     |
| `radio.test.js`           | the mount: gating, ICY headers, real-time pacing, fan-out, play history, and the browser→player station-file handoff                            |
| `deploy.test.js`          | the production boundary: X-Forwarded-For is overwritten not appended, the mount is never buffered, the unit is confined, no secret is committed |
| `accounts.test.js`        | magic links: single use, expiry, per-address rate limits, hashed tokens, and that signing in **keeps** the stars you already had                |
| `favourites.test.js`      | ★ and ⇄: per-owner isolation, idempotency, the counters, validation, and that no private field leaks                                            |
| `preview.test.js`         | the excerpt is mono and shorter than the master, served without a token — and the master still needs one                                        |
| `production.test.js`      | the configuration the box actually runs: `NODE_ENV=production`, the SECRET requirement, and no dev markers in responses                         |
| `client-store.test.js`    | the browser store: a ★ reaches the right endpoint with the right method, and never blocks the UI                                                |
| `importer.test.js`        | import pipeline: storage copy, content-hash rename detection, publication rules, idempotency, exports                                           |
| `render.test.js`          | server-rendered meta tags, structured data, escaping of untrusted metadata                                                                      |
| `static-build.test.js`    | the static snapshot the domain serves today: pages, playlist, per-track pages                                                                   |
| `storage.test.js`         | SigV4 against the AWS documentation example and an independent implementation, local driver, key safety                                         |
| `limit-streams.test.js`   | the per-IP concurrency cap holds with genuinely parallel connections                                                                            |
| `limit-rate.test.js`      | token minting is rate limited                                                                                                                   |
| `token-expiry.test.js`    | a token stops working once its TTL passes                                                                                                       |
| `library.test.js`         | the real catalogue matches the audio on disk and ids stay stable (skips without `_data/music`)                                                  |

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

## The station: one continuous stream

Live mode is not "play this track then that one" — it is a single endless response, the way broadcast
radio actually works:

```
schedule (library.slotAt) ──▶ pump ──▶ every listener
                                  ├── ICY metadata every 16 kB: StreamTitle='DWP — Intaktan';
                                  └── play_history row per track
```

| Property               | How it behaves                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One resource**       | `GET /radio-128.mp3?t=…` never ends. There is no per-track URL to save, which is the strongest protection in the whole design.                          |
| **Paced to real time** | The pump is throttled to the on-air track's own bitrate. Without that it would hand out a whole file at disk speed — a download dressed up as a stream. |
| **ICY metadata**       | `icy-metaint`, `icy-name`, `icy-br` plus a `StreamTitle` block at _exactly_ every interval, so VLC and foobar show the track. Browsers ignore it.       |
| **Fan-out**            | One reader, many listeners, all hearing the same position. A listener that stops reading is dropped rather than buffered forever.                       |
| **Late joiners**       | Start mid-track at the offset the schedule dictates — you cannot "start from the beginning" of a live stream.                                           |
| **Real counts**        | `/api/now-playing` reports open mount connections, and `/healthz` too.                                                                                  |
| **History**            | Every track change writes a `play_history` row and increments `plays` — the charts read from that.                                                      |
| **Same gates**         | The mount is behind the token, referer, User-Agent, rate-limit and concurrency checks as everything else.                                               |

External players get station files, which carry a longer-lived token (an external player cannot refresh
one mid-session):

- `GET /radio.pls` — VLC, foobar2000, Winamp
- `GET /radio.m3u` — anything else

Tuning in from the console is the same code path: `GET /api/radio` returns the mount URL with a token,
and the player simply points `<audio>` at it.

## Deployment: two hosts, and which one you are looking at

The station is two separable things, and the distinction matters because the domain currently points
at the first one:

|                 | What it is                                                             | Where it can run                                               |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| **The site**    | pages, catalogue, per-track pages with share cards, favourites, basket | any file host — GitHub Pages, the shared host at `81.2.196.19` |
| **The station** | token-gated stream, SQLite catalogue, private audio storage, scheduler | a Node process with a writable disk (a small VPS behind nginx) |

`81.2.196.19` is Forpsi **shared hosting** (nginx placeholder, no shell, no long-running processes),
so it cannot run the station. Until the Node host exists, the domain serves a **static snapshot**:

```bash
npm run build:static        # writes _site/ : the site + data/playlist.json + per-track pages
```

A GitHub Actions workflow (`.github/workflows/pages.yml`) builds that snapshot and publishes it to
GitHub Pages, so `https://anomalradio.com/` shows the real website — the design, the eight-track
catalogue, working share cards — instead of the repository README.

**The snapshot is honest about itself.** The client falls back to `/data/playlist.json` when `/api/*`
is absent, shows a “static preview” banner, labels the hero “catalogue preview” rather than “on air”,
and answers a play attempt with _“playback needs the station server”_ instead of failing obscurely.
The same fallback is a useful degraded mode in production if the API is ever down.

To run the real station you need a host with Node 22+; then:

```bash
git clone … && npm ci
npm run import -- --publish     # catalogue → private storage + SQLite
SECRET=$(openssl rand -hex 32) NODE_ENV=production npm start
```

and point DNS at that host instead of GitHub Pages.

**Which host, and how much:** the free answer is **Oracle Cloud's Always Free tier** — 2 OCPU /
12 GB ARM VM, 200 GB disk, **10 TB/month outbound**, permanent. A radio is a bandwidth business, and
that is the only free tier with an allowance big enough to matter (GCP's free 1 GB/month is about
seven hours of one listener). The full reasoning, the capacity arithmetic, the two ways it can go
wrong, and the step-by-step runbook are in **[`deploy/README.md`](deploy/README.md)**.

Everything needed to run it is in [`deploy/`](deploy/): cloud-init provisioning, a hardened systemd
unit, two nginx configs (bootstrap → TLS), a production environment template, and an idempotent
deploy script that health-checks the result.

## Roadmap

| Milestone | Scope                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** ✅ | repo, tooling, design tokens, project skeleton                                                                                              |
| **M1** ✅ | clickable design prototype + working player over a stub API                                                                                 |
| **M2** ✅ | SQLite catalogue, private storage (local/S3), real HMAC tokens with a request cap, import pipeline, server-rendered share metadata          |
| **M3** ✅ | continuous mount: one paced endless stream, ICY metadata, listener counts, play history, `.pls`/`.m3u` station files                        |
| **M4** ✅ | ★ favourites server-side with **magic-link accounts** (no passwords), ⇄ share counters, per-track preview excerpts                          |
| **M5**    | basket checkout (Stripe or external buy links) + watermarked downloads                                                                      |
| **M6**    | `/admin`: upload, metadata, covers, rotation weights, dashboard                                                                             |
| **M7** 🟡 | the station on a Node host: `deploy/` is complete and tested; **go-live needs an Oracle account and a DNS change** — see `deploy/README.md` |

Details, effort estimates and open decisions: [`_data/design-offer.md`](_data/design-offer.md).

## Deployment

**The site** is live at `https://anomalradio.com/` today, served from GitHub Pages as a static
snapshot (`scripts/build-static.js`), because neither host available so far can run the station:
GitHub Pages only serves files, and `81.2.196.19` is Forpsi shared hosting with no shell.

**The station** needs a Node process with a writable disk. That is [`deploy/`](deploy/README.md):
nginx + systemd + Let's Encrypt on an **Oracle Cloud Always Free** instance, with the private audio
and the SQLite catalogue on the instance's own volume (`/var/lib/anomalradio`), never in a web root.
Once it is up, DNS moves from Pages to that instance and the snapshot becomes a staging mirror.

## Licensing

Site code © Anomalradio.com. Audio under `_data/music/` is **not** part of the repository and remains the property of
its authors. Web fonts are SIL Open Font License 1.1 (see `public/assets/fonts/manifest.json`).
