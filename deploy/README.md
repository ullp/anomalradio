# Deploying the station on a host that stays free

## The short answer

**Oracle Cloud Infrastructure — the "Always Free" tier.** It is the only free tier that gives you an
always-on machine _and_ a traffic allowance a radio can actually live inside.

|                        | Oracle Always Free                                   | Google Cloud free tier | Render / Koyeb / Railway     | AWS · Azure · DO · Vultr |
| ---------------------- | ---------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------ |
| What it really is      | an always-on VM, root, public IP                     | an always-on VM        | an app container that sleeps | credits with an expiry   |
| Compute                | 2 OCPU / 12 GB (Ampere A1, ARM64) **+ 2× x86 micro** | e2-micro, 1 GB, x86    | scale-to-zero                | 30–180 days              |
| Disk                   | 200 GB block storage (47 GB minimum boot volume)     | 30 GB                  | ephemeral                    | varies                   |
| **Outbound traffic**   | **10 TB / month**                                    | **1 GB / month**       | metered                      | ~100 GB for a year       |
| Long-lived connections | yes                                                  | yes                    | no — idle means sleep        | yes                      |
| Cost                   | €0                                                   | €0                     | €0 while asleep              | —                        |

The deciding column is traffic, and it is not close. GCP's free 1 GB/month is about **seven hours of
one listener** — it cannot host a radio at all. Everything else in that table is either a trial with
an expiry date or a container that sleeps when nobody is listening, which for a radio is the moment
it matters.

Oracle's allocation was halved in June 2026 (4 OCPU / 24 GB → 2 OCPU / 12 GB). Even halved it is
still, by a wide margin, the largest permanent free machine available.

### What 10 TB/month actually buys

| Master bitrate | One listener-hour | Listener-hours per month | ≈ listeners running 24/7 |
| -------------- | ----------------- | ------------------------ | ------------------------ |
| 320 kbps       | 144 MB            | ~69,400                  | ~96                      |
| 256 kbps       | 115 MB            | ~87,000                  | ~120                     |
| 128 kbps       | 58 MB             | ~174,000                 | ~238                     |

One 320 kbps listener listening day and night costs ≈104 GB/month, so about 96 of them exhaust the
allowance. SomaFM-scale traffic would not fit in any free tier — this is a station for its own
audience, and the numbers are written down here so the ceiling is never a surprise. (`STREAM_BITRATE`
in the environment file is the advertised nominal; the mount carries each master at its own rate, so
320 kbps masters cost 320 kbps.)

## The two things that go wrong on Oracle, and how this repo handles them

### 1. Oracle stops instances it considers idle

The published policy: an Always Free instance **may be reclaimed** if, over a 7-day window, the 95th
percentile of CPU, network _and_ memory utilisation are all below 10%. A radio is exactly that shape
— pacing a 320 kbps stream is nearly free in CPU and nowhere near 10% of a 1 Gbps NIC — so this is a
real risk, not a footnote. A reclaimed instance can be restarted only if the shape is still available.

**Mitigation, in order of preference:**

1. **Convert the account to Pay As You Go.** This is the documented escape hatch: PAYG accounts are
   not subject to idle reclamation, and Oracle does not charge while usage stays inside the Always
   Free limits. It needs a card on file, and that is the only reason it is not the default advice.
2. If you stay on the free plan, run a small always-on heartbeat. Anything that keeps CPU or memory
   above the threshold for a while each day is enough; it is not worth doing anything cleverer.
3. Keep the boot volume and take the nightly backup (below) so a reclaim costs a restart, not data.

### 2. "Out of host capacity"

Ampere A1 capacity in the free tier is genuinely contended. When creating the instance, if you get
`Out of host capacity`: try another availability domain in the same region, try again later, or fall
back to the two free **`VM.Standard.E2.1.Micro`** instances (x86, 1 OCPU / 1 GB each — one of them is
enough for this app, and they share the same 10 TB allowance). The repo is architecture-neutral: no
native modules, `node:sqlite` is built in, and Node and ffmpeg both ship arm64 builds, so ARM64 is
not a constraint.

## Why not the host you already have

`81.2.196.19` is Forpsi **shared hosting**: nginx placeholder, port 22 filtered, no shell, no
long-running processes. It cannot run a Node process, and a radio _is_ a long-running process.
GitHub Pages can only serve files. That is why the domain currently shows a static snapshot — see the
main README, "Deployment: two hosts". Oracle is the free way to have the real thing.

## The runbook

### 0. What you need

- An Oracle Cloud account. Signup is free; verification asks for a card even if you never spend.
- The SSH public key you will upload at creation time.
- Control of DNS for `anomalradio.com`.

### 1. Create the instance (the console, click by click)

Sign up at <https://signup.cloud.oracle.com>. It is free, but verification asks for a card and a phone
number even if you never spend. **Your "home region" is permanent** and the Always Free resources are
created there, so pick one near your audience (Frankfurt or Amsterdam for Europe).

Then **Compute → Instances → Create instance**:

| Field            | What to choose                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Name**         | `anomalradio`                                                                                                                 |
| **Compartment**  | your root compartment (fine)                                                                                                  |
| **Image**        | _Change image_ → **Canonical Ubuntu** → **24.04** (aarch64 comes with an ARM shape)                                           |
| **Shape**        | _Change shape_ → **Ampere** → `VM.Standard.A1.Flex` → **2 OCPU / 12 GB** — the most that is still free                        |
| **Primary VNIC** | defaults are fine; make sure **Assign a public IPv4 address** is _Yes_                                                        |
| **SSH keys**     | _Upload public key file_ → your `~/.ssh/id_ed25519.pub` (or let the console generate a pair and **download the private key**) |
| **Boot volume**  | _Specify a custom boot volume size_ → **100 GB** (free up to 200 GB)                                                          |
| **Cloud-init**   | _Show advanced options_ → **Management** tab → **Cloud-init script** → paste the whole of `deploy/cloud-init.yaml`            |

Click **Create**. Provisioning takes a couple of minutes, then cloud-init runs for another 3–6 minutes
(package upgrade, Node 24, nginx, certbot, ffmpeg, the repo, the systemd unit).

**What "it worked" looks like.** Note the **Public IP address** on the instance page, then:

```bash
ssh ubuntu@<ip> 'cloud-init status --long'        # → status: done
ssh ubuntu@<ip> 'systemctl is-active anomalradio nginx'
ssh ubuntu@<ip> 'curl -fsS http://127.0.0.1:3000/healthz'
```

The last one prints JSON containing `"streaming":true` and a track title. If cloud-init is still
running, wait. If it reports `error`, this shows which step failed:

```bash
ssh ubuntu@<ip> 'sudo grep -iE "Traceback|error" /var/log/cloud-init-output.log | tail -20'
```

Two notes on that file, because both would have bitten us:

- The `users:` block keeps `- default`. cloud-init only creates the distro default user (`ubuntu`)
  when it is listed, and Oracle puts the SSH key you uploaded into _that_ user — drop it and there is
  no way into the box except the serial console.
- `runcmd` runs under `/bin/sh` (dash on Ubuntu), so the steps are POSIX (`set -eu`, no `pipefail`).
  `set -o pipefail` there is a fatal error, not a warning.

### 2. Open the ports — in **both** places

This is the step that catches everyone.

1. **The cloud firewall** — _Networking → Virtual Cloud Networks → your VCN → Security Lists →
   Default Security List → Add Ingress Rules_: Source CIDR `0.0.0.0/0`, IP Protocol **TCP**,
   Destination Port Range `80,443` (one rule covers both), then **Add Ingress Rules**.
2. **The host firewall**: Oracle's Ubuntu images ship a persisted iptables ruleset whose INPUT chain
   ends in `REJECT`, so the box answers perfectly on localhost and looks dead from the internet.
   `deploy/cloud-init.yaml` already inserts the ACCEPT rules ahead of that REJECT (position 6, where
   Oracle's own documentation puts them) and persists them. If you built the instance without
   cloud-init, run that block by hand.

If `curl http://localhost/` works on the box but `curl http://<ip>/` does not from your laptop, it is
one of these two — in that order.

### 3. Point DNS at it

At your registrar, change the `A` record for `anomalradio.com` from GitHub Pages
(`185.199.108–111.153`) to the instance's public IP. Leave `*.anomalradio.com` as it is; the wildcard
still points at the apex, which is now this box.

**Delete any `AAAA` record.** If one exists and points somewhere else, Let's Encrypt tries IPv6 first:
a stale AAAA that answers gives a hard failure, and a refused one is not retried over IPv4. It must
come back empty, and the A record must already be visible from outside before the next step:

```bash
dig +short AAAA anomalradio.com     # must print nothing
dig +short A anomalradio.com        # must print the instance's IP
```

### 4. Deploy

```bash
ssh ubuntu@<ip> 'sudo /srv/anomalradio/deploy/bin/deploy.sh'
```

Idempotent — run it after every push, and after every music import. It pulls `main`, installs
dependencies, imports anything new, installs the unit and the nginx config, restarts the station and
then _proves it_: it health-checks the app, dumps the journal if the service did not stay up, and
reports what the domain answers from outside.

### 5. Add music

```bash
rsync -av ~/music/ ubuntu@<ip>:/srv/anomalradio-inbox/
ssh ubuntu@<ip> 'sudo /srv/anomalradio/deploy/bin/deploy.sh'
```

The import hashes each file, reads its metadata with ffprobe, copies it into private storage
(`/var/lib/anomalradio/media`, outside the repository and outside any web root), and publishes it.
Re-running is safe: unchanged files are recognised by content hash.

### 6. TLS

```bash
ssh ubuntu@<ip> 'sudo CERTBOT_EMAIL=you@example.com /srv/anomalradio/deploy/bin/deploy.sh --tls'
```

Certbot answers the HTTP-01 challenge over plain HTTP — which is exactly why there are two nginx
configs: the TLS one cannot load before a certificate exists, so the bootstrap config serves HTTP and
the ACME path until it does. `--tls` refuses to run until the domain resolves. After it succeeds, the
TLS config is installed and HTTP redirects to HTTPS.

Two things worth knowing:

- **Port 80 stays open forever**, not just for the first issuance — renewal repeats the same HTTP-01
  challenge every ~60 days, and a firewall that opens only 443 breaks it silently.
- **A renewal only helps if nginx reloads.** certbot's `--webroot` mode does not touch the running
  server, so nginx would keep serving the old certificate from memory and the site would break around
  day 90 even though renewal reported success every time. cloud-init therefore installs a deploy hook
  at `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`. Prove the whole loop now, not in two months:

```bash
ssh ubuntu@<ip> 'sudo certbot renew --dry-run'
```

### 7. Prove it

```bash
curl -sI https://anomalradio.com/ | head -1              # 200, and HSTS present
curl -s  https://anomalradio.com/healthz                 # {"status":"ok",...}
curl -s -A 'VLC/3.0.21 LibVLC/3.0.21' https://anomalradio.com/radio.pls
```

Then actually listen: open `https://anomalradio.com/radio.pls` in VLC, or press **TUNE IN** on the
site. The console shows the real listener count.

### 8. Keep it alive

```bash
# nightly database backup, off the box
ssh ubuntu@<ip> 'sqlite3 /var/lib/anomalradio/data/anomalradio.db ".backup /tmp/anomalradio.db"'
rsync ubuntu@<ip>:/tmp/anomalradio.db ~/backups/
```

`unattended-upgrades` is installed and enabled by cloud-init, so security patches land on their own.
The instance is subject to Oracle's idle policy — re-read the section above before assuming it will
be there forever.

## What has been verified, and what has not

Verified by `npm test` in this repository (see `tests/deploy.test.js`):

- the nginx configs **overwrite** `X-Forwarded-For` with `$remote_addr` and never use
  `$proxy_add_x_forwarded_for`. Appending keeps the client's own value first, and the app takes the
  first value — so one word here would let any client choose its apparent IP and walk around the
  per-IP rate limit, the stream cap and token/IP binding at once;
- the mount location never buffers, never times out early, and never gzip-compresses;
- `MOUNT_PATH` and the nginx location cannot drift apart: a test matches the one against the other;
- the systemd unit is unprivileged, confined (`ProtectSystem=strict`), and cannot write next to its
  own code — the only writable path is `/var/lib/anomalradio`;
- cloud-init generates `SECRET` on the machine, and the repository contains no secret;
- cloud-init keeps the distro default user, so the SSH key Oracle injects still works — and its
  `runcmd` steps stay POSIX, because they run under `/bin/sh` (dash on Ubuntu);
- cloud-init opens 80/443 at the host level, not only in the VCN, and installs a certbot deploy hook
  so a renewal actually reaches nginx;
- the deploy script is strict, never writes a secret, runs app commands as the unprivileged user,
  validates nginx before reloading it, and refuses to claim success if the station is not up.

Every one of those assertions was checked by **mutation**: the property was deliberately broken and
the suite was confirmed to fail. A test that cannot fail is a comment.

Not verified here, because it needs your account: creating the instance, the VCN rules, the DNS
change, and the Let's Encrypt issuance. Steps 1–7 are the sequence; step 7 is the proof.

## Fixed while writing this

Writing a runbook means checking that its claims are true, and several were not:

1. **The station files were decorative.** `/radio.pls` and `/radio.m3u` required a browser context (a
   Referer) and issued a token bound to the browser's User-Agent. VLC sends no Referer and is not the
   browser, so it could neither fetch the file nor use the token inside it.
2. **The mount itself demanded a Referer**, so even a hand-written station file would not have played.

Both now accept a player — a _missing_ referer is not a _foreign_ referer — while a foreign referer is
still refused, the User-Agent denylist still applies, and `/api/session` (the real anti-hotlink gate)
still requires a browser context. Station-file tokens are bound to the requesting address but not to a
browser, which is what makes the browser→player handoff work. `tests/radio.test.js` now drives that
handoff end to end, and still refuses a station-file token presented from another address.

**Two more, in the provisioning file itself**, found while writing the console walkthrough above:

3. **It would have locked you out of the box.** The `users:` list did not include `default`, and
   cloud-init only creates the distro default user when it is listed — so `ubuntu`, the account Oracle
   injects your SSH key into, would never have existed. (`home:` is also not a cloud-init key; the real
   one is `homedir:`.)
4. **`set -o pipefail` in `runcmd`.** Those entries run under `/bin/sh`, which is dash on Ubuntu, where
   that option is a _fatal_ error rather than a warning — the step would have aborted partway through,
   leaving a half-provisioned box.

Both are now pinned by tests, because neither fails loudly: one fails at login, the other only in
console output nobody reads on a good day.

## Cost

| Item                                     | Cost       |
| ---------------------------------------- | ---------- |
| VPS — Oracle Cloud Always Free           | €0         |
| TLS — Let's Encrypt                      | €0         |
| DNS                                      | €0 (yours) |
| Offsite backup bucket (optional, few GB) | < €1/month |
| **Total**                                | **≈ €0**   |

The real cost of "free" is the idle-instance policy above, and the fact that a free tier is not an
SLA. Keep the nightly backup.
