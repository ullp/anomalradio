# Anomalradio.com — Implementation & Design Offer (v1)

> Companion document to `_data/zadani.md`. This is the _offer_: what I propose to build,
> how it will look, how it will be protected, what it costs in effort, and what I need from you.
> Nothing in the app has been generated yet — this is for approval.

---

## 0. TL;DR

|                      |                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**          | 24/7 auto-playing own-music radio + track library + favourites + buy + share                                                                  |
| **Reference**        | SomaFM (`somafm.com/player24/station/groovesalad`) — continuous stream, now-playing + last-15 history, popup player                           |
| **Stack (proposed)** | Node.js 24 + Express 5 API + vanilla ES-module frontend (no build step), SQLite, ffmpeg + Icecast for the live stream                         |
| **Media**            | MP3s **outside the web root** (or private object storage), addressed only by opaque IDs, streamed through a token-gated endpoint / live mount |
| **Protection**       | 5 layers (storage isolation → short-lived IP/UA-bound tokens → anti-bot → continuous stream → client deterrents) + honest limits stated       |
| **Look**             | Black canvas, azure glow, glass panels, broadcast-signal visualizer derived from the logo mark                                                |
| **Effort**           | M0–M7 core ≈ 8–12 working days; **playable + beautiful MVP ≈ 4 days (M0–M2)**                                                                 |
| **Deploy**           | `81.2.196.19` behind nginx, TLS via Let's Encrypt (wildcard via DNS-01), systemd or Docker Compose                                            |

---

## 1. Inputs I used (facts, not assumptions)

From `_data/zadani.md`:

- Radio name **Anomalradio.com**, domain owned; site plays **only its own music**.
- DNS: `anomalradio.com` → **A 81.2.196.19** (TTL 1800); `*.anomalradio.com` → **CNAME** `anomalradio.com`.
  → a wildcard subdomain is available: useful for `stream.` / `media.` / `cdn.`.
- Git: `https://github.com/ullp/anomalradio` (not yet initialised locally — `/Users/ullp/git/anomalradio` has no `.git`).
- Autoplay like SomaFM; MP3s placed by you in a folder **I choose**.
- **New in your revision:** files _may be stored elsewhere_ and served **under IDs / a protected path or URL**
  → this is exactly the "private storage + ID indirection" model in §6.
- Protection: playable by people, not downloadable / not "dropped" by hackers.
- Business: auto radio player, with per-track **star / basket / share**.

From `_data/logo/anomalradiocomlogoweb.jpeg` (1254×1254 JPEG, the web lockup) — I read the image:

- Pure **black** background.
- **White** wide/square techno wordmark "ANOMAL RADIO" (two lines, custom geometric letterforms).
- **Azure blue** broadcast waves flanking a white "A" chevron that holds an azure dot (the mark).
- Below the mark, the lowercase **"anomalradio.com"** wordmark: white for "anomalradio", azure for ".com".
- Sampled palette → `#000000` / `#FFFFFF` / `#1B8EF5` (blue, ±few units; final value to be sampled exactly).

From the SomaFM reference (fetched live):

- Home = station directory + "N people listening right now" + donate/store/news.
- Playlists page = per-station **charts** (by spins, by listeners) and **"recently played" = last 10–15 songs only**, further history deliberately unavailable.
- Their own news item (21-Oct-2026): they **killed the HLS lossless stream** because it _"was being abused by bots and streamrippers"_.
  → stream ripping is a real, ongoing threat even for a large station; my §7 design targets exactly this.
- Icecast (their transport family) supports mount-level listener auth: `htpasswd` and **URL/`stream_auth`** hooks —
  i.e. a listener connection can be validated by our own server before audio flows. That is the backbone of §7 Layer 3.

Environment verified on your machine: **Node v24.3.0**, npm 11.4.2, Python 3.14.5, **Docker 29.2.1**, **ffmpeg 8.0**, git at `/opt/homebrew/bin/git`.

---

## 2. Design offer — "control room" futurism, derived from your logo

### 2.1 Design principles

1. **Logo-first**: the mark is the hero; the broadcast waves are the recurring brand motif (idle = a travelling wave packet, playing = the live signal).
2. **Dark, precise, technical** — black canvas + a single azure accent, thin 1px borders, no drop-shadow soup.
3. **One accent colour** used for: play state, active nav, live dot, focus rings, waveform. Everything else is greyscale.
4. **Motion with meaning**: 120–200 ms transitions; the visualizer is the only continuously animated element (and it is disabled under `prefers-reduced-motion`).
5. **Accessible by default**: WCAG AA contrast, full keyboard operation, ARIA live region announcing track changes, visible focus.

### 2.2 Design tokens (CSS custom properties)

```css
:root {
  /* surfaces */
  --bg-0: #000000; /* page canvas, matches logo */
  --bg-1: #05070b; /* section background */
  --panel: rgba(255, 255, 255, 0.035);
  --panel-hi: rgba(255, 255, 255, 0.06);
  --line: rgba(255, 255, 255, 0.09);

  /* ink */
  --ink: #ffffff;
  --ink-2: #b9c2cf;
  --ink-3: #7b8595;

  /* brand */
  --accent: #1b8ef5; /* sampled from the waves, the dot and ".com" */
  --accent-2: #00e5ff; /* cyan end of gradient, for glow only */
  --accent-glow: 0 0 24px rgba(27, 142, 245, 0.45);
  --live: #ff2e4c; /* LIVE dot, mirrors broadcast convention */

  /* type */
  --font-display: 'Orbitron', system-ui, sans-serif; /* techno headings */
  --font-ui: 'Inter', system-ui, sans-serif; /* body / controls */
  --font-mono: 'JetBrains Mono', ui-monospace, monospace; /* IDs, times, ticker */

  /* geometry */
  --r-sm: 8px;
  --r-md: 14px;
  --r-lg: 22px;
  --r-pill: 999px;
  --sp: 4px; /* 4px spacing scale: 4/8/12/16/24/32/48/64 */
}
```

_Fonts are self-hosted `woff2` in `public/assets/fonts/` (no Google CDN → faster, GDPR-clean, works offline)._
_The wordmark itself stays a raster/SVG asset from `_data/logo/`; Orbitron is only used for other headings so we never "fake" the logo._

### 2.3 Visual language

| Element               | Treatment                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hero                  | Full-bleed black, faint 40px grid + radial azure vignette, logo lockup, animated signal trace beside it, one primary CTA |
| Panels                | `--panel` + `backdrop-filter: blur(14px)`, 1px `--line`, `--r-lg`; hover lifts to `--panel-hi`                           |
| Now-playing module    | Rotating disc/ring with cover art, title/artist in display font, live elapsed counter in mono, animated spectrum bars    |
| Visualizer            | Web Audio `AnalyserNode` → 48 spectrum bars plus a signal trace; canvas, DPR-aware; idle = travelling wave packet        |
| Buttons               | Pill primary (accent fill, black text), ghost secondary (1px border), icon-only circles for star/basket/share            |
| Star / basket / share | Same icon slot everywhere (player bar, track rows, track page) — accent fill when active (starred / in cart)             |
| Track rows            | Index · cover thumb · title/artist · genre pill · duration (mono) · actions; zebra-free, separated by `--line`           |
| Live indicator        | `--live` pulsing dot + "LIVE" + listener count                                                                           |
| Grain/scanline        | 2% opacity noise PNG + slow 8s horizontal scan sweep, both disabled for reduced-motion                                   |
| Empty/loading states  | Skeleton shimmer in accent at 8% opacity, never a blank screen                                                           |

### 2.4 Pages (site map)

| Route                          | Purpose                           | Key content                                                                                                                       |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/`                            | Landing / tune-in                 | Hero, TUNE IN, live now-playing, last-5 history, featured tracks, about blurb, footer                                             |
| `/player`                      | **player24** — full radio console | Big art, visualizer, now playing, last-15 history with star/basket/share per row, volume, quality, popup-player link, sleep timer |
| `/player?popup=1`              | Minimal always-on-top player      | Logo, art, play/pause, volume, current track + 3 actions                                                                          |
| `/tracks`                      | Library / archive                 | Search, filter (genre / year / bpm / duration), sort, pagination; play/star/basket/share per row                                  |
| `/track/:id`                   | Track permalink                   | Cover, waveform, credits, description, **buy**, star, share buttons, OG/Twitter meta, "play in radio"                             |
| `/favourites`                  | Starred tracks                    | List + "export as M3U" + "play all"                                                                                               |
| `/cart` → `/checkout`          | Basket & purchase                 | Line items, totals, Stripe Checkout, order confirmation with signed download links                                                |
| `/about`, `/legal`, `/contact` | Trust & compliance                | Story, privacy, terms (no-ripping clause), licensing, contact                                                                     |
| `/admin`                       | Upload & publish (protected)      | Drag-drop MP3, ffprobe auto-metadata, edit, cover upload, publish/unpublish, ID generation                                        |
| `/embed/:id?`                  | Optional                          | iframe mini-player for other sites (growth channel)                                                                               |

### 2.5 Responsiveness & a11y

- Mobile-first: 1 column < 640px, 2 at ≥ 640px, console layout (art + history side by side) ≥ 1024px.
- Sticky bottom player bar on all pages; safe-area insets for iOS; ≥44px tap targets.
- Keyboard: `Space` play/pause · `←/→` seek/volume · `↑/↓` volume · `S` star · `B` basket · `C` copy link · `?` shortcut sheet.
- Screen readers: `aria-live="polite"` now-playing announcements, `aria-pressed` on star/basket, labelled icon buttons.
- `prefers-reduced-motion` → no scanline, no rotating disc, static (non-animated) bars; `prefers-color-scheme: light` is **not** supported by design (radio is dark) but text contrast stays AA.

---

## 3. Player offer — two modes, one UI

SomaFM does not hand out files; it hands out a **live mount** and shows what is playing. I propose the same,
but with an on-demand mode on top so a listener can start a specific track from the library.

### 3.1 Mode A — "Radio" (default, continuous, SomaFM-like)

```
[ your MP3s ] → ffmpeg (decode) → Icecast mount /radio-128.mp3 (auth-protected) → <audio src="https://stream.anomalradio.com/radio-128.mp3?t=…">
                                                   ↓ ICY metadata
                                     Node API → /api/now-playing (SSE) → UI
```

- The browser receives **one endless stream**. There is no per-track URL in the DOM, no file to "save as".
- Track boundaries come from the scheduler (a JSON schedule/rotation built from the library) and are published as
  **ICY metadata** (works in VLC/standalone players too) **and** as a server-sent-event feed for our own UI.
- A single "TUNE IN" button starts it; because browsers block unmuted autoplay, the first click is required
  (SomaFM has the same gate). Optional variant: **start muted** with a "🔊 Unmute" pulse — autoplay-compliant and honest.
- "Skip/next" in Mode A = "jump the live stream to the next track" (a request to the scheduler; other listeners stay in sync)
  — or, if you prefer per-listener freedom, Mode B is used instead.

### 3.2 Mode B — "On-demand track" (library, share links, favourites)

- `GET /api/session` → short-lived signed token (see §7).
- `GET /api/stream/:id?t=<token>` → Node proxies the MP3 with `no-store`, IP/UA-bound token, concurrency cap.
- Sequential autoplay: when a track ends, the player fetches the next track + a **fresh token** and continues.
  This feels exactly like the radio but lets a listener pick a track; per-track URLs expire in ~2 min and are useless to share.
- Progress/seek allowed inside the token window only.

### 3.3 Player bar (present on every page)

`[cover] Title — Artist · genre · elapsed/live` | `◀◀ ▶/❚❚ ▶▶` | `🔊 ─────` | `★` `🛒` `⇪` | `LIVE ● 42 listening` | `⤢ popup`

- Elapsed counter in mono; in Mode A it shows "LIVE + hh:mm:ss on air".
- Star/basket/share always act on the **currently playing** track.
- Popup player opens `/player?popup=1` (small window, minimal chrome) — the classic SomaFM behaviour.

### 3.4 History & charts (SomaFM parity + one step further)

- "Recently played" list of the **last 15** tracks with timestamp, each row with star/basket/share (SomaFM parity).
- Per-track **play counters** so `/tracks` can sort by "most played" and show a simple chart (SomaFM's charts, but live from our own DB).
- "Listeners right now" = live count of open stream connections (Icecast stats endpoint, cached 10 s).

### 3.5 Extras I recommend (cheap, high value)

Sleep timer · volume memory · media-session/OS media keys (`navigator.mediaSession`) · lock-screen metadata with cover ·
"add to my playlist" queue · share-the-current-track · Chromecast/AirPlay via standard media casting · PWA install so it
behaves like an app on mobile · optional 64 kbps AAC mount for weak connections (auto-selected by bandwidth hint).

---

## 4. Architecture — three options, one recommendation

### Option A — **Node.js + Express API + vanilla frontend** ✅ recommended

- One process (`node server/index.js`) serves the static UI and the API; nginx in front terminates TLS.
- Frontend: plain **ES modules + CSS custom properties**, no bundler, no framework → instant load, zero build step, nothing to go stale.
- Continuous radio: **ffmpeg → Icecast** (Docker) with `stream_auth` token validation; Node builds the schedule and reads Icecast stats.
- Data: **SQLite** (`better-sqlite3`) — single file, no DB server, perfect for a radio of this size; trivially backed up.
- Pros: total control over protected streaming; one language; cheap (~€5–10/mo VPS you already have); no vendor lock-in; local dev = production.
- Cons: you (we) own the server maintenance.

### Option B — PHP 8 + nginx (if the host is shared hosting)

- Viable for the site, library, cart, admin. Weak spot: proxying a continuous protected stream and running a scheduler
  is clumsy in PHP (needs a long-running CLI worker / `stream_socket_server`), and shared hosts often forbid it.
- Only choose this if `81.2.196.19` is shared hosting with no SSH/Docker.

### Option C — Next.js on Vercel + private object storage

- Media never touches the app host: MP3s in Cloudflare R2 / S3 / B2 (private bucket), playback via short-lived
  **presigned URLs** or an edge proxy. No server to patch; great DX and CDN delivery.
- Cons: a _continuous_ stream still needs an origin (Icecast/ffmpeg) somewhere — Vercel cannot hold a long-lived socket;
  egress costs; more moving parts; the radio becomes "long playlist of presigned URLs" (weaker protection than Mode A).

**Recommendation: Option A**, with the storage layer abstracted so the MP3s can live either on the VPS **or** in a private
bucket (your "stored elsewhere, served under IDs" note) without changing a single line of UI code.

### 4.1 Stack detail (Option A)

| Concern     | Choice                                                      | Why                                         |
| ----------- | ----------------------------------------------------------- | ------------------------------------------- |
| Runtime     | Node 24 (already installed)                                 | LTS, native fetch/`node:test`               |
| HTTP        | Express 5                                                   | boring, well understood; Fastify acceptable |
| DB          | `better-sqlite3`                                            | synchronous, fast, single-file backup       |
| Validation  | `zod`                                                       | request/schema safety                       |
| IDs         | `nanoid`                                                    | short, unguessable track IDs                |
| Audio probe | `ffprobe` (ffmpeg 8.0 present)                              | duration, bitrate, channels, loudness       |
| Covers      | `sharp`                                                     | thumbnails, WebP, blur placeholders         |
| Security    | `helmet`, `express-rate-limit`, HMAC tokens (`node:crypto`) | §7                                          |
| Live stream | `ffmpeg` + Icecast 2.4 (Docker)                             | `stream_auth` listener validation           |
| Logs        | `pino` + rotation                                           | ripper-pattern detection                    |
| Tests       | `node:test` + `supertest`                                   | no extra framework                          |
| Frontend    | ES modules, CSS tokens, Web Audio API, no build             | fast, hackable, no toolchain rot            |

### 4.2 Repository layout

```
anomalradio/
├── _data/                        # SOURCE material, never published
│   ├── zadani.md                 # your brief
│   ├── design-offer.md           # this document
│   └── logo/anomalradiocomlogoweb.jpeg   # web lockup (mark + wordmark)
├── public/                       # web root (only static thing nginx serves)
│   ├── index.html                # landing / tune-in
│   ├── player/index.html         # player24 console (+ ?popup=1)
│   ├── tracks/index.html         # library
│   ├── track/index.html          # permalink (server-rendered OG meta)
│   ├── favourites/, cart/, about/, legal/, admin/
│   ├── assets/
│   │   ├── css/tokens.css  base.css  components.css  player.css
│   │   ├── js/api.js  player.js  radio.js  visualizer.js  library.js
│   │   │         favourites.js  cart.js  share.js  shortcuts.js
│   │   ├── fonts/*.woff2         # Orbitron, Inter, JetBrains Mono (self-hosted)
│   │   └── img/logo.png|svg, og-default.jpg, noise.png, icons/
│   └── sw.js                     # PWA service worker (optional)
├── server/
│   ├── index.js                  # bootstrap: static + API + /healthz
│   ├── config.js                 # env parsing (zod)
│   ├── routes/
│   │   ├── playlist.js           # /api/playlist, /api/tracks/:id
│   │   ├── session.js            # /api/session → signed stream token
│   │   ├── stream.js             # /api/stream/:id → protected proxy
│   │   ├── nowplaying.js         # /api/now-playing (SSE), /api/history
│   │   ├── favourites.js         # /api/favourites
│   │   ├── cart.js               # /api/cart, /api/checkout, /api/orders
│   │   ├── share.js              # /api/track/:id/meta (OG payload)
│   │   └── admin.js              # upload, edit, publish (auth + 2FA)
│   ├── lib/
│   │   ├── storage.js            # LocalStorage | S3Storage (driver via env)
│   │   ├── tokens.js             # HMAC sign/verify, nonce store, IP/UA binding
│   │   ├── library.js            # DB queries, play counters, charts
│   │   ├── scheduler.js          # rotation/shuffle + Icecast source control
│   │   ├── icecast.js            # stats, ICY metadata, mount auth callback
│   │   ├── ffprobe.js            # metadata extraction
│   │   └── watermark.js          # ID3 comment stamp on purchased files
│   └── middleware/  auth.js  ratelimit.js  antirip.js  errors.js
├── media/                        # PRIVATE, git-ignored, outside web root
│   ├── tracks/<trackId>.mp3      #   (or: private object-storage bucket)
│   └── covers/<trackId>.webp
├── data/
│   ├── anomalradio.db            # SQLite: tracks, history, favourites, cart, orders
│   └── tracks.json               # human-editable metadata import/export
├── scripts/
│   ├── import-tracks.js          # drop MP3s → probe → DB → publish
│   ├── make-covers.js            # thumbnails
│   └── backup.sh                 # DB + metadata → offsite
├── deploy/
│   ├── nginx/anomalradio.conf
│   ├── systemd/anomalradio-web.service
│   └── docker-compose.yml        # app + icecast
├── .env.example                  # STORAGE_DRIVER, SECRET, STRIPE_KEY, ICECAST_*, ADMIN_*
├── .gitignore                    # media/, data/*.db, .env, **/*.mp3
├── package.json
└── README.md                     # setup, "where to put MP3s", deploy, security notes
```

> **Where you put the MP3s (answering your brief):** either `media/tracks/` on the server (private, git-ignored) **or** a
> **private bucket** (R2/S3/B2) — both are first-class, switched by one env var. You can also just drop files into
> `_data/_incoming/` and run `npm run import`: the script probes them, mints IDs, writes the DB, and moves the audio into
> private storage. No audio ever enters Git (GitHub's 100 MB/file limit and repo size would punish that anyway).

---

## 5. Data model & API surface

### 5.1 Tables (SQLite)

| Table               | Key columns                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracks`            | `id` (PK, opaque), `storage_key`, `title`, `artist`, `album`, `year`, `genre`, `bpm`, `duration_ms`, `bitrate`, `channels`, `size_bytes`, `cover_key`, `price_cents`, `currency`, `buy_url`, `isrc`, `license`, `tags` (JSON), `published`, `plays`, `stars`, `added_at`, `updated_at` |
| `play_history`      | `id`, `track_id`, `started_at`, `listeners` (for charts: spins + listeners, SomaFM-style)                                                                                                                                                                                              |
| `favourites`        | `id`, `owner_key` (anonymous cookie or `user_id`), `track_id`, `created_at`                                                                                                                                                                                                            |
| `users` _(phase 2)_ | `id`, `email`, `magic_token`, `created_at`, `last_login_at`                                                                                                                                                                                                                            |
| `cart_items`        | `id`, `owner_key`, `track_id`, `added_at`                                                                                                                                                                                                                                              |
| `orders`            | `id`, `email`, `provider` (stripe/paypal/manual), `provider_ref`, `amount_cents`, `currency`, `status`, `created_at`                                                                                                                                                                   |
| `order_items`       | `order_id`, `track_id`, `price_cents`, `download_token`, `download_expires_at`, `downloads_used`, `max_downloads`                                                                                                                                                                      |
| `stream_tokens`     | `nonce` (PK), `track_id`, `ip_hash`, `ua_hash`, `issued_at`, `expires_at`, `used` (replay protection)                                                                                                                                                                                  |
| `admin_audit`       | `id`, `action`, `target`, `ip`, `at`                                                                                                                                                                                                                                                   |

### 5.2 Public API (JSON)

| Endpoint                                                    | Returns                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/playlist?page=&q=&genre=&sort=`                   | Published tracks **without any storage path**                   |
| `GET /api/tracks/:id`                                       | One track's public metadata + `starred`/`inCart` for the caller |
| `GET /api/session`                                          | `{ token, expiresAt, mount }` — HMAC stream token (§7)          |
| `GET /api/stream/:id?t=…`                                   | Audio bytes (protected proxy) — never a public file URL         |
| `GET /api/radio`                                            | Live mount URL + token (Mode A)                                 |
| `GET /api/now-playing` (SSE)                                | Current track + `listeners`, pushed on every boundary           |
| `GET /api/history?limit=15`                                 | Recently played                                                 |
| `POST /api/favourites` · `DELETE /api/favourites/:id`       | Star / unstar                                                   |
| `POST /api/cart` · `DELETE /api/cart/:id` · `GET /api/cart` | Basket                                                          |
| `POST /api/checkout`                                        | Stripe Checkout session URL                                     |
| `GET /api/orders/:id/download/:trackId`                     | One-time, expiring, watermarked download (after payment)        |
| `GET /api/track/:id/meta`                                   | OG/Twitter payload for share previews                           |
| `GET /healthz`                                              | Liveness for monitoring                                         |

Server-rendered bits (needed for social previews and SEO): `/track/:id`, `/`, `/tracks` are rendered by Node with
injected `<meta property="og:*">` + JSON-LD `MusicRecording`, so shared links unfurl properly in X/WhatsApp/Telegram/Slack.

---

## 6. Media storage — "stored elsewhere, served under IDs"

This is the part of your brief I want to nail, because it is the foundation of both security and licensing.

### 6.1 The indirection rule

> **The public world only ever sees `id`s. The mapping `id → storage_key → real file` exists only in the database and the server's memory.**

- Track ID: `nanoid`-based, prefixed and non-sequential — e.g. `ar_7Kd3pQx9Lm`. Unguessable, stable, safe in URLs.
- Storage key: `tracks/ar_7Kd3pQx9Lm.mp3` — _never_ the original filename (original names leak artist/label/release info and are enumerable).
- The original filename is kept in an `admin`-only column (`original_name`) for your convenience in the admin UI.
- No endpoint ever returns a `storage_key`. `GET /api/playlist` is proven by a test to never contain a path-like string.

### 6.2 Two storage drivers behind one interface

```ts
// server/lib/storage.js  (interface sketch — implemented as a plain JS class)
interface Storage {
  put(key, readable, opts: { contentType }): Promise<void>;
  createReadStream(key, range?): Promise<Readable>;
  stat(key): Promise<{ size; contentType }>;
  signedUrl?(key, opts: { ttlSeconds; ipHash }): Promise<string>; // object-storage driver only
  delete(key): Promise<void>;
}
```

| Driver                         | `STORAGE_DRIVER=local`                          | `STORAGE_DRIVER=s3` (R2 / S3 / B2 / Wasabi / MinIO)                                                                            |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Where files live               | `media/` on the VPS, **outside** `public/`      | Private bucket, `ACL: private`, no public bucket policy                                                                        |
| How audio reaches the listener | Node stream-proxy from disk                     | Either (a) Node stream-proxy from the bucket, or (b) **302 → presigned URL** (60 s TTL, `response-content-disposition=inline`) |
| Bucket URL visibility          | n/a                                             | With proxy mode the bucket hostname never appears in the browser at all                                                        |
| Cost profile                   | Disk + VPS bandwidth                            | Cheap storage, cheap egress (R2 has zero egress fees)                                                                          |
| Best for                       | Start now, ~hundreds of tracks, modest audience | Bigger catalogues, CDN-ish delivery, keeping audio off the web server entirely                                                 |

Switching driver is an `.env` change plus a one-off `npm run migrate-storage` (copies objects and rewrites `storage_key`).
I recommend **starting with `local`** (simplest, zero external accounts) and keeping `s3` ready, since R2/B2 egress is cheaper
than VPS bandwidth once the audience grows.

### 6.3 Import pipeline (`npm run import`)

```
_data/_incoming/*.mp3
   → validate (real MP3? magic bytes, size cap, duration cap)
   → ffprobe: duration, bitrate, sample rate, channels, ReplayGain/EBU R128 loudness
   → read ID3 tags as *suggestions* for title/artist/album/year/genre
   → mint id (nanoid)  → storage.put('tracks/<id>.mp3', file)
   → optional transcode for the radio mount (see below) → loudness-normalised copy for the stream
   → INSERT tracks row (published = false)  → you review/publish in /admin
```

**Loudness normalisation matters**: radio that jumps between quiet and loud tracks sounds amateur. The import step can
produce a normalised stream master (e.g. `loudnorm` to −14 LUFS / −1 dBTP) kept separate from the untouched original,
so the radio sounds even while sold downloads stay pristine. Both live in private storage under different keys.

---

## 7. Security & anti-download design

### 7.0 The honest part first (please read this)

**Anything a browser can play, a determined person can capture** — audio can always be recorded from the output device.
No client-side trick changes that, and anyone promising "100% undownloadable" is selling something false.
What this design _does_ deliver:

1. **No downloadable file URLs** — nothing to right-click → Save, nothing to paste into a download manager.
2. **No hotlinking / no bulk ripping by bots** — the practical threat (SomaFM literally retired a stream because bots and
   streamrippers abused it, see §1).
3. **A continuous-stream mode** where an individual track's file never reaches the client at all.
4. **Accountability** — every stream request is token-bound and logged, so abuse is visible and bannable.
5. **A sanctioned download path** — paying customers get watermarked files (which also traces leaks to an order).

If you ever need _hard_ DRM (Widevine/FairPlay) that is a different project: licence server, per-device provisioning,
real cost, and it breaks some browsers/Linux. My recommendation: **don't** — use the layers below.

### 7.1 Layer 1 — storage isolation

- Audio lives outside the web root (`media/`, private) or in a private bucket. nginx has no alias pointing at it.
- nginx hard rule: requests matching `\.(mp3|m4a|flac|wav|aac)$` or `/media/` → **404** (not 403 — don't confirm existence).
- No directory listing (`autoindex off`), no `.git`, no source maps, no `.env` reachable.
- Opaque, non-sequential IDs; original filenames never appear in URLs.

### 7.2 Layer 2 — request gating (tokens)

```
GET /api/session
   checks: Origin/Referer ∈ allowlist (anomalradio.com, *.anomalradio.com, localhost in dev)
           Sec-Fetch-Site: same-origin|same-site      (scripts/bots don't send it)
           per-IP rate limit (60/min), per-IP concurrent-stream cap (3)
   issues: token = base64url(payload) . HMAC-SHA256(payload, SECRET)
           payload = { tid, nonce, exp: now+120s, ip: sha256(ip+salt), ua: sha256(UA+salt) }

GET /api/stream/:id?t=<token>
   verifies: signature, exp, nonce unused, tid matches :id, ip/ua hash match, concurrency, referer
   serves:   audio with Cache-Control: no-store, private
             Content-Disposition: inline              (no filename hint)
             X-Robots-Tag: noindex, nofollow, noarchive
             Accept-Ranges: bytes  (seeking) — only while the token window is alive
   on fail:  403 + structured log entry (reason, ip hash, ua, path)
```

Consequences, stated plainly:

- A copied URL is worthless within ~2 minutes and only works from the same IP + browser fingerprint.
- Pasting the stream URL into VLC/IDM/yt-dlp fails (wrong UA/IP, expired token) — and known ripper UAs fail immediately.
- Tokens are issued only after a same-origin page asks for one, so a bare `curl` gets nothing.
- Replay protection: `stream_tokens.nonce` is single-use, purged by a timer.

### 7.3 Layer 3 — continuous stream (strongest, and it _is_ the SomaFM model)

- ffmpeg feeds **Icecast**; the mount is configured with `<authentication type="url">` + `stream_auth` pointing at our Node
  endpoint, so Icecast asks _us_ before admitting a listener (capability verified in the Icecast docs — §1).
- Node answers only if the listener's token (query parameter on the mount URL) is valid, unused, unexpired and within the
  concurrency cap. Icecast's `timelimit_header` can force periodic re-authorisation during long sessions.
- The listener's browser receives **one continuous audio stream** — no per-track resource, nothing to "save".
- Mount hardening: admin interface disabled/closed, source password strong and private, `max-listeners` capped,
  `burst-size`/`client-timeout` tuned, stats endpoint not public, passwords rotated.
- Serve it on `stream.anomalradio.com` (your wildcard CNAME already allows it) so the main origin stays clean and
  per-hostname Cloudflare/caching rules apply.

### 7.4 Layer 4 — anti-bot & abuse controls

- **UA policy on audio routes**: block `streamripper`, `ffmpeg`, `ffprobe`, `wget`, `curl`, `python-requests`, `yt-dlp`,
  `IDM`, `aria2`, `HTTrack`; require a browser-ish UA **plus** `Sec-Fetch-*` headers when issuing tokens.
- **Pattern detection**: alert + temporary ban when one IP requests > N distinct tracks within M minutes (ripper signature),
  on token replay, or on repeated IP/UA mismatch; counters kept per IP hash.
- **Rate limiting** per IP and per route, plus a global cap to protect the box.
- **Cloudflare (free tier) in front**: bot management, DDoS absorption, WAF + rate-limit rules, origin IP hidden;
  firewall restricted to Cloudflare ranges.
- **Host hardening**: `ufw` (80/443/22 only), SSH keys only + root login off, fail2ban, unattended security updates, no
  stray services, nginx `server_tokens off`.
- **Headers** via `helmet` + nginx: strict CSP (nonce'd bootstrap, no inline handlers), HSTS, `Referrer-Policy:
strict-origin-when-cross-origin`, minimal `Permissions-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` except `/embed` which uses an allowlisted `frame-ancestors`.
- **Admin hardening**: non-obvious path, session + **TOTP 2FA**, optional IP allowlist, login rate limit, full audit log, no default credentials.

### 7.5 Layer 5 — client deterrents (cosmetic — labelled honestly)

`controlsList="nodownload noplaybackrate"`, `disablePictureInPicture`, context-menu/drag blocked on the player, no `download`
attribute anywhere, and in on-demand mode the audio element is fed a **blob URL** so the real endpoint never sits in the DOM.
These stop casual users only; they are UX, not security.

### 7.6 Sold files — watermarking (the strongest practical anti-piracy lever)

Purchased downloads get an ID3 `TXXX`/comment frame with the order ID and a hash of the buyer's e-mail, e.g.
`AR-ORDER-8f31c2 · purchaser 4a91…`. A leaked file then points at an order — a far better deterrent than any client-side
blocking. Download links are expiring (24–72 h) and limited (max 3 uses), optionally IP-bound.

---

## 8. Business features — star / basket / share

### 8.1 ⭐ Star (favourites)

| Phase        | Behaviour                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1 (MVP)** | Star stored in `localStorage` + an anonymous `owner_key` cookie, so stars survive a cache clear and can later be claimed by an account. `/favourites` page, "play all", **export as M3U** (a nice radio-specific touch). No login friction. |
| **v2**       | Optional accounts with **e-mail magic links** (no passwords to store/leak): stars move server-side, sync across devices, "your favourite tracks play more often in your rotation" is even possible later.                                   |

UI: same star slot in the player bar, in every history/track row, and on `/track/:id`; `aria-pressed`, filled accent icon when active, and a subtle "★ Saved to favourites" toast with an undo.

### 8.2 🛒 Basket (cart → buy)

Two variants — pick per track, both supported by the same UI:

- **Variant 1 — external buy link (fastest, zero payment infra):** each track has an optional `buy_url` (Bandcamp, own store,
  label). The basket simply collects the tracks and produces a **checkout list** that opens each buy link — or a single
  "Buy all on Bandcamp" link. Live in days, no PCI scope, no fees beyond your existing store.
- **Variant 2 — built-in checkout (real cart):** basket → `/cart` → **Stripe Checkout** (hosted, PCI-safe) → webhook →
  `orders` row → order confirmation page with **expiring, watermarked download links** for the purchased MP3s.
  Per-track price (`price_cents`) and/or "pay what you want" with a minimum; currency selectable (EUR/CZK/USD).

Details worth deciding early: prices per track vs. per album, VAT handling (Stripe Tax or manual), receipts (Stripe sends them),
refund policy, and whether purchases also unlock a lossless/alternate version.

### 8.3 ⇪ Share (social URLs)

- Every track has a **canonical page** `/track/ar_xxxxx` with server-rendered OG/Twitter meta
  (`og:title`, `og:description`, `og:image` = cover, `og:type=music.song`, `og:audio` = short-lived preview URL,
  `twitter:card=player`) and JSON-LD `MusicRecording`. Result: X/Facebook/WhatsApp/Telegram/Slack unfurl a rich card.
- Buttons: **X/Twitter, Facebook, WhatsApp, Telegram, Reddit, LinkedIn, Mastodon**, plus **e-mail** and **Copy link**
  (clipboard API with fallback), plus native **Web Share API** on mobile, plus an optional **QR code** (downloadable PNG) for print/merch.
- "Share current track" in the player bar; "Copy link at current timestamp" is a cheap, genuinely useful extra.
- **Never share the audio file URL** — always the page. That keeps the security model intact while still going viral.
- Optional analytics-lite: count shares per track (no third-party tracking scripts).

---

## 9. Admin & upload (so you can run the station without me)

`/admin` (2FA-protected) gives you:

1. **Upload**: drag & drop multiple MP3s → server probes them, mints IDs, stores them privately, and lists them as drafts.
2. **Edit metadata**: title, artist, album, year, genre, tags, description, price, currency, buy URL, ISRC, licence,
   publish toggle, "featured on homepage" toggle, explicit-content flag.
3. **Cover art**: upload image → auto-square, WebP + thumbnails, blur placeholder, OG image generated.
4. **Rotation controls**: per-track weight ("play more/less often"), "do not play for N days", "play only in this block of the day"
   (a simple dayparting model), and a global "shuffle / sequential" switch.
5. **Dashboard**: listeners right now, tracks played today, top tracks, failed stream requests (abuse signals), storage used,
   last backups, "on air" control (skip current track, jump to next, pause the station with a fallback ambient loop).
6. **Audit log**: who changed what, when, from which IP.

A CLI path exists for everything the UI does (`npm run import`, `npm run publish <id>`, `npm run schedule:rebuild`) so
bulk-loading 300 tracks is one command rather than 300 clicks.

---

## 10. Deployment on `81.2.196.19`

### 10.1 Topology

```
Internet
   │
Cloudflare (free: DNS, DDoS, bot mgmt, WAF, TLS edge)      ← recommended, optional
   │
nginx on 81.2.196.19  (TLS via Let's Encrypt)
   ├── anomalradio.com        → static `public/` + Node API on 127.0.0.1:3000
   ├── stream.anomalradio.com → Icecast on 127.0.0.1:8000  (mount auth → Node)
   └── media/anomalradio.*    → (only if bucket is proxied; otherwise not exposed at all)
```

- **DNS you already have** (`A → 81.2.196.19`, `*.anomalradio.com → CNAME anomalradio.com`) is sufficient — no DNS changes needed
  to launch. If we put Cloudflare in front, the A record becomes a Cloudflare-proxied record and the origin is locked to Cloudflare IPs.
- **TLS**: Let's Encrypt via **DNS-01 wildcard** → one certificate for `anomalradio.com` + `*.anomalradio.com`, auto-renewed.
- **Process management**: systemd units (`anomalradio-web`, `icecast`) or Docker Compose (`app`, `icecast`) — Docker is my
  preference for Icecast (no distro packaging headaches) with Node either containerised or on systemd.
- **Node under load**: run 1–2 instances behind nginx; streams are I/O-bound, not CPU-bound; a 2 vCPU / 2 GB VPS handles
  a few hundred concurrent 128 kbps listeners (≈ 4 Mbps per 100 listeners at 128 kbps — watch the VPS bandwidth allowance).

### 10.2 Operational hygiene

- **Backups**: nightly `sqlite3 .backup` + `tracks.json` export + `rclone` copy to offsite (B2/S3); media backed up weekly;
  a documented one-command restore, tested once.
- **Monitoring**: `/healthz`, uptime checks (UptimeRobot/Healthchecks), Icecast listener count on the dashboard, log rotation,
  alert on error rate spikes or storage thresholds.
- **Performance**: HTTP/2 + Brotli, immutable caching for hashed assets, fonts preloaded, images as WebP/AVIF with
  `loading="lazy"`, no third-party scripts on the critical path (no Google Fonts, no analytics bloat).
- **Privacy**: cookieless analytics (self-hosted Umami/Plausible) or none; only the essential `owner_key` cookie; a plain-language
  privacy page; no ad-tech, no fingerprinting.
- **Staging**: `beta.anomalradio.com` (wildcard already covers it) running the same code against a copy of the DB, so you can
  approve changes before they hit the live station.
- **Rollback**: tagged releases + `git`-based deploy script; DB migrations versioned and reversible.

### 10.3 Cost estimate (monthly, rough)

| Item                                        | Cost                     |
| ------------------------------------------- | ------------------------ |
| VPS you already pay for (`81.2.196.19`)     | —                        |
| Cloudflare free tier                        | €0                       |
| Let's Encrypt TLS                           | €0                       |
| Offsite backup bucket (a few GB)            | < €1                     |
| Optional: R2/B2 for media (zero/low egress) | €1–5                     |
| Optional: Stripe fees on sales              | 1.5 % + €0.25 (EU cards) |
| **Total new spend**                         | **≈ €0–6/month**         |

---

## 11. Roadmap & effort

| Milestone                             | Deliverable                                                                                                                                                                    | Effort                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **M0 — Repo & foundations**           | `git init` + remote `github.com/ullp/anomalradio`, README, `.gitignore` (audio excluded), `package.json`, `.env.example`, lint/format, folder skeleton, `_data/` preserved     | 0.5 d                       |
| **M1 — Visual prototype (no audio)**  | Design tokens, real logo integrated, `/`, `/player`, `/tracks`, `/track/:id` as clickable pages over the real catalogue, signal visualizer, player bar, responsive + a11y pass | 1–2 d                       |
| **M2 — Library + protected playback** | Import script, SQLite schema, `/api/playlist`, `/api/session`, `/api/stream/:id` with all Layer-1/2 hardening, working player with autoplay-next, now-playing, last-15 history | 1–2 d                       |
| **M3 — Continuous radio mode**        | ffmpeg + Icecast with `stream_auth` → Node, scheduler/rotation, ICY metadata, `/api/now-playing` SSE, TUNE IN gate, popup player, listener counter                             | 1–2 d                       |
| **M4 — Star & share**                 | Favourites (v1) + `/favourites` + M3U export; share buttons; `/track/:id` OG/Twitter meta + JSON-LD                                                                            | 1 d                         |
| **M5 — Basket & buy**                 | Cart, Stripe Checkout + webhook, orders, watermarked expiring downloads — _or_ the external-buy-link variant                                                                   | 1–2 d (0.5 d for variant 1) |
| **M6 — Admin UI**                     | Upload/import, metadata editor, covers, publish, rotation weights, dashboard, audit log                                                                                        | 1 d                         |
| **M7 — Hardening & go-live**          | nginx/TLS/systemd or Docker, Cloudflare, firewall, backups, monitoring, abuse-test checklist (direct file, hotlink, token replay, ripper UA, concurrency)                      | 1 d                         |
| **M8 — Extras (optional, on demand)** | Accounts, embed widget, sleep timer, requests/voting, PWA, 64 kbps AAC mount, charts page, analytics, Chromecast                                                               | as agreed                   |

- **Playable + beautiful MVP (M0–M2): ~4 days.** _Full brief (M0–M7): ~8–12 days._
- The security invariants in §7 are pinned by `npm test` (78 cases, ~4 s) — M2 must keep them green.

- M1 is a **hard approval gate**: you see the design in the browser before any backend work starts.
- Everything after M2 is independently shippable — you can go live after M3 and add shopping later.

## 11a. M2 — what shipped, and where it deviates from this offer

Delivered:

- **Catalogue in SQLite** — `node:sqlite` (Node 22+ built-in), WAL mode, versioned migrations in
  `server/migrations/`. Tables: `tracks`, `play_history`, `favourites`, `cart_items`, `stream_tokens`,
  `orders`, `order_items`, `admin_audit`.
- **Private storage behind a driver interface** — `local` (files outside the web root) and `s3` (any
  S3-compatible bucket, private, proxy or presigned-redirect). Switching is one environment variable.
- **Import pipeline** — `npm run import`: hash → ffprobe → id resolution → copy into private storage →
  database upsert → readable metadata export. Idempotent, rename-aware (content hash), with explicit
  publication rules so a new file cannot go live by accident. `--normalise` writes an EBU R128 stream
  master for the radio, leaving the sellable master untouched.
- **Real tokens** — stateless HMAC bound to track + IP + browser (hashed), 120 s TTL, recorded in the
  database so it can be revoked and counted.
- **Server-rendered share metadata** — per-track `og:*`, Twitter card, canonical URL and JSON-LD
  `MusicRecording`. This was scheduled for M4; it belongs with the database because it needs the track
  record, and it makes the ⇪ button actually useful.

Deviations, and why:

| Offered                            | Shipped                                                                                                                      | Reason                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Express 5                          | hand-rolled router on `node:http`                                                                                            | the app needs ~10 routes; zero dependencies means no supply chain, no build step, nothing to upgrade                                       |
| `better-sqlite3`                   | `node:sqlite`                                                                                                                | verified working on Node 24 without flags; no native build. Isolated in `server/db.js` so swapping is a one-file change                    |
| ffmpeg → Icecast for M3            | planned: a **Node-native continuous mount** (one chunked response with ICY metadata), Icecast kept as the documented upgrade | keeps the single-process, no-Docker deployment the rest of the design assumes; still delivers one endless stream and no per-track resource |
| single-use nonce                   | nonce recorded once, token reusable up to `MAX_REQUESTS_PER_TOKEN` (400)                                                     | seeking issues many range requests, so a strictly single-use nonce breaks the player; the cap catches rippers instead                      |
| favourites/cart in the API (M4/M5) | tables exist, API still client-side                                                                                          | deliberately unchanged scope: the browser store works, and the API endpoints land with accounts and checkout                               |

Verification: `npm test` — 119 cases, ~8 s, green locally and in CI. The suite found four real defects
during M2, including a storage-path leak that the _next_ schema change would have introduced, an XSS
vector in the JSON-LD block, and a check-then-act race in the stream cap.

## 11b. M3 — the station, for real

Delivered:

- **One continuous mount** (`GET /radio-128.mp3?t=…`): a single endless response fanned out to every
  listener from one reader. There is no per-track resource at all, which is the strongest protection
  in the whole design — you cannot save what you were never sent.
- **Paced to real time** at the on-air track's own bitrate. This is not cosmetic: an unpaced pump
  hands out a whole file at disk speed, i.e. a download wearing a stream's clothes. (The first
  version did exactly that — 9 MB in 8 s — and the fix is now pinned by a test.)
- **ICY metadata**: `icy-name`, `icy-genre`, `icy-br`, `icy-metaint`, and a `StreamTitle` block at
  _exactly_ every interval, so VLC/foobar show the track. Two subtleties that only show up in strict
  players, both fixed and tested: the block must land on the interval boundary (not a chunk boundary),
  and it must never be written outside the interval — including on a track change.
- **A real listener count** from open connections, in `/api/now-playing` and `/healthz`.
- **Play history**: every track change writes `play_history` and increments `tracks.plays`, which is
  what the charts will read.
- **Station files** for external players: `/radio.pls` and `/radio.m3u`, carrying a longer-lived
  token (`RADIO_TOKEN_TTL`, 6 h) because a player cannot refresh one mid-session. It is still bound
  to IP and browser.
- The client's live mode is now simply "point `<audio>` at the mount" — no source switching, no
  per-track tokens, and the schedule feed only updates the metadata.

Deviations from the original plan: **no Icecast and no ffmpeg** in the serving path. A Node pump
gives the same single endless mount, keeps the deployment a single process with no Docker, and puts
the stream behind the same token/referer/User-Agent/concurrency gates as everything else. Icecast
remains the documented upgrade if we ever want relaying, multiple mounts or external source clients.

Verification: 139 tests (14 new for the mount: gating, ICY headers and layout, real-time pacing,
fan-out, history, station files), plus a manual byte-level check of the ICY blocks.

## 12. Decisions I need from you

| #   | Question                                                                                                             | Why it matters          | My recommendation                                      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| 1   | What exactly is at `81.2.196.19` — VPS with SSH/root + Docker, or shared hosting?                                    | chooses Option A vs B   | Option A if you can SSH in                             |
| 2   | Media on the VPS disk or in a private bucket (R2/B2/S3)? Roughly how many tracks, and expected concurrent listeners? | sizing, bandwidth, cost | start `local`, keep `s3` ready                         |
| 3   | Sell music for real (Stripe) or link out to an existing store (Bandcamp)?                                            | M5 scope, VAT, refunds  | external link first, Stripe later                      |
| 4   | Favourites: anonymous (no login) or accounts with login?                                                             | M4 scope                | anonymous first, magic-link accounts later             |
| 5   | Autoplay: accept the one-click "TUNE IN" gate, or start muted and auto-unmute on interaction?                        | browser policy, UX      | one-click TUNE IN (SomaFM does the same)               |
| 6   | One channel, or several channels/genres later (SomaFM has 30+)?                                                      | schedule model, mounts  | build one channel, keep the schema multi-channel-ready |
| 7   | Stream quality: 128 kbps MP3 only, or also a 64 kbps AAC low-bandwidth mount? Lossless?                              | bandwidth vs. fidelity  | 128k MP3 + optional 64k AAC                            |
| 8   | UI language: English only, or EN + CZ?                                                                               | copy work               | English first, i18n-ready strings                      |
| 9   | Do you own the rights to stream **and sell** all tracks (self-released)?                                             | legality of the shop    | confirm before M5                                      |
| 10  | Who uploads tracks — you via `/admin`, or should I just build the CLI import?                                        | M6 scope                | `/admin` upload + CLI both                             |
| 11  | Is "hard DRM" expected by any stakeholder?                                                                           | sets expectations       | no DRM; layered protection as in §7                    |
| 12  | Brand: keep exactly black / white / azure, and is there a tagline to use?                                            | final visual polish     | keep logo palette; tagline optional                    |

## 13. What I propose to do next (on your go-ahead)

1. **M0 now** — initialise the repo exactly as your brief describes (`git init`, remote `origin → https://github.com/ullp/anomalradio.git`,
   branch `main`), add README/.gitignore/package.json/env example and the folder skeleton. Nothing audio-related is committed.
2. **M1 immediately after** — build the clickable visual prototype with the real logo so you can judge the futuristic design in the browser
   (I can serve it locally on your machine so you see it live, and/or push to `beta.anomalradio.com` once the server access is sorted).
3. Then we answer decisions #1–#4 above and wire the audio (M2), because those four determine the storage and payment plumbing.

**Nothing in this offer is committed to code yet — say the word and I start with M0 + M1.**

_Prepared as a companion to `_data/zadani.md`. All prices/effort are estimates, not quotes._
