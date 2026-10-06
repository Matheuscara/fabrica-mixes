# Fábrica de Mixes

**English** | [Português (Brasil)](README.pt-BR.md)

[![Website](https://img.shields.io/badge/website-matheuscara.github.io%2Ffabrica--mixes-f3a865)](https://matheuscara.github.io/fabrica-mixes/)
[![Release v0.1.0](https://img.shields.io/badge/release-v0.1.0-9fcaa5)](https://github.com/Matheuscara/fabrica-mixes/releases/tag/v0.1.0)
[![License: MIT](https://img.shields.io/badge/license-MIT-eee8de)](LICENSE)

**[Project website](https://matheuscara.github.io/fabrica-mixes/)** ·
**[v0.1.0 release](https://github.com/Matheuscara/fabrica-mixes/releases/tag/v0.1.0)** ·
**[Installation](#quick-start-docker)** · **[MIT License](LICENSE)**

A self-hosted system that assembles long music mixes for YouTube — no GPU required.
You upload songs and images/loops for each channel; the system reserves **N songs of the same style
+ 1 visual** in a draft. You review the songs, their order, the visual and the thumbnail, approve it,
and the rendered video becomes available for download. Publishing to YouTube remains manual.

> **Interface language:** the web interface is currently in Brazilian Portuguese. This README uses
> the Portuguese UI labels where needed, with English explanations alongside.

> **No login.** The site has no authentication: anyone who can reach the port can upload, change and
> delete files. By default, Compose publishes the port only on `127.0.0.1`. Read
> [Secure network access](#secure-network-access) and [SECURITY.md](SECURITY.md) before opening it
> to other devices.

## Screenshots

Captured from an isolated demo instance with fictitious channels, songs and visuals — not production
data. The interface is in Brazilian Portuguese.

![Channel overview ("Visão geral"): charts of videos per stage and new/used songs per style](docs/assets/overview.webp)

*Channel overview ("Visão geral"): videos per stage and new vs. used songs per style.*

![Video board ("Vídeos"): kanban columns from Rascunho (draft) to Publicado (published)](docs/assets/board.webp)

*Video board: Rascunho → Produção → Pronto → Agendado → Publicado (Draft → Production → Ready →
Scheduled → Published).*

![Draft review: song order, visual and thumbnail choice before approval](docs/assets/review.webp)

*Draft review: reorder or swap songs, swap the visual and pick the thumbnail before approving the
render.*

## Features

- **Channels**: each YouTube channel has its own songs, visuals, styles and videos.
- **Per-channel navigation**: overview, videos, production, upload, songs, visuals and settings pages
  in the sidebar. On mobile, open them with the "Menu do canal" (channel menu) button.
- **Video board (kanban)**: Draft → Production → Ready → Scheduled → Published (and Error).
- **Overview**: charts of videos per stage and of new/used songs per style. Animations respect the
  reduced-motion preference, and the charts reflow on mobile.
- **Styles**: every song has a style (e.g. `lofi-jazz-lounge`), and a video never mixes styles.
  When you drag a folder onto the site, the style is the name of the folder containing the song.
- **Prompt per style**: on the Songs page you create a style and store the prompt used to generate its
  tracks, so you can edit and copy it later. The site only stores the recipe; it **does not generate
  music**. Styles created by uploading a folder appear without a prompt until you fill one in.
- **No duplication**:
  - a file with the same content (SHA-256 hash) in the same channel is skipped on upload;
  - a song or visual that is already in a video is not picked again — unless you enable
    "reaproveitar" (reuse) in the channel settings; then the least-used ones go first;
  - discarding a video frees its songs and visual; a published video still counts as used.
- **Draft review**: reorder and swap songs, swap the visual and choose the thumbnail before
  approving. **Nothing is rendered without your approval.**
- **GPU-free rendering**: each uploaded image/video is converted **once** into an H.264 1080p30 loop
  (letterboxed with black bars if it is not 16:9). After that, each render just copies this loop and
  encodes the audio as AAC: roughly 1–2 min per hour of mix on a regular CPU.
- **Automatic mode** (per channel): keeps up to X drafts or unpublished videos, reserving new
  material, but never renders without approval. If any video has an error, it pauses until you
  resolve it.
- **Tracklist**: each video shows the visual used and the songs with their start times, ready to copy
  into the YouTube description.
- **Post-publication**: record the download, planned date, link and publication date; after
  publishing, "Apagar arquivo" (delete file) frees the video's disk space and keeps the record.

## Workflow

1. **Create a channel** on the home page.
2. **Upload material** on the channel's Upload page: songs (with a style) and images or short looping
   videos. Visuals are converted in the background.
3. **Generate drafts** on the Production page (a specific style or rotating through the available
   styles), or enable automatic mode in the settings.
4. **Review** the draft: order, songs, visual and thumbnail.
5. **Approve**: the video enters the queue and videos are rendered one at a time. If it fails, use
   "Tentar de novo" (try again).
6. **Download** the finished MP4 and the thumbnail, and mark it as downloaded.
7. **Schedule and publish** manually on YouTube; record the planned date, link and publication date.
8. Optional: **delete the file** of the published video to free disk space.

Only use songs and images that you own or have licensed. The system does not check usage rights or
YouTube policies; that responsibility stays with whoever publishes.

## Requirements

- **With Docker (recommended)**: Docker Engine with the Compose plugin. The image already ships
  Node 24 and ffmpeg.
- **Without Docker**: Node **≥ 22.18** (uses the built-in `node:sqlite`) and `ffmpeg`/`ffprobe` on the
  `PATH`.
- A regular CPU; **no GPU needed**. Run it in a dedicated VM or container, not directly on a
  hypervisor.
- Disk: see [Disk space](#disk-space).

## Quick start (Docker)

> **The website is informational only.** [matheuscara.github.io/fabrica-mixes](https://matheuscara.github.io/fabrica-mixes/)
> is a static page; there is no hosted or online version of the app. To use Fábrica de Mixes you run
> it yourself on your own machine or server, as below.

```sh
git clone https://github.com/Matheuscara/fabrica-mixes.git
cd fabrica-mixes
cp .env.example .env    # review BIND_HOST, PORT, DATA_PATH and TZ
docker compose up -d --build
```

With the default `.env` (`BIND_HOST=127.0.0.1`), open **http://localhost:8080** on the same machine.
Data is stored in `./data` (or in the `DATA_PATH` you set).

Update to the latest version:

```sh
git pull && docker compose up -d --build
```

### Environment variables

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `BIND_HOST` | `.env` (Compose) | `127.0.0.1` | Server address on which the port is published. Keep the default unless you deliberately bind a restricted private interface. |
| `PORT` | `.env` (Compose) | `8080` | Port published on the server. |
| `DATA_PATH` | `.env` (Compose) | `./data` | Server folder mounted at `/data` in the container. |
| `TZ` | `.env` (Compose) | `America/Sao_Paulo` | Container time zone. |
| `DATA_DIR` | Node process | `data` | Data folder when running without Docker (in the container it is always `/data`). |
| `MAX_UPLOAD_MB` | Node process | `4096` | Maximum size of each uploaded file, in MB. |

## Secure network access

The default `BIND_HOST=127.0.0.1` only accepts connections from the machine itself. To use it from
another device, prefer, in this order:

1. **SSH tunnel** (nothing exposed): on your computer, run
   `ssh -N -L 8080:127.0.0.1:8080 user@server` and open http://localhost:8080.
2. **VPN** (WireGuard, Tailscale, etc.): set `BIND_HOST` to the server's IP **on the VPN interface**,
   so only VPN members can reach the port.
3. **Reverse proxy with login** (SSO, oauth2-proxy, Authelia, Caddy/nginx basic auth, etc.):
   keep `BIND_HOST=127.0.0.1` and let only the proxy talk to the app. Allow large, slow uploads in
   the proxy (in nginx, for example, `client_max_body_size` ≥ `MAX_UPLOAD_MB` and long timeouts).
4. **Trusted local network**: `BIND_HOST=<server IP on the LAN>`, with a firewall allowing only the
   devices that should have access. Anyone on the same network can use the site.

Precautions:

- **Never** use `BIND_HOST=0.0.0.0` or forward the port on your router on untrusted networks or to
  the internet.
- Docker publishes ports with its own iptables rules, which can bypass `ufw`/firewalld.
  Restrict access via `BIND_HOST` and, if needed, the `DOCKER-USER` chain.
- When running **without Docker** (`npm start`/`npm run dev`), the server listens on **all
  interfaces**. Only use it on a trusted machine or block the port in the firewall.

## Disk space

Everything lives in `DATA_PATH`:

```text
data/
├── app.db, app.db-wal, app.db-shm      SQLite database (WAL mode)
├── channels/<channel>/
│   ├── songs/<hash>.<ext>              uploaded songs
│   ├── visuals/<hash>/                 original, loop.mp4 (1080p30) and thumb.jpg
│   └── videos/<video>.mp4              rendered videos
└── tmp/                                in-progress uploads and renders (disposable)
```

Estimates for planning storage:

| Item | Approximate size |
| --- | --- |
| Rendered video | 1–2 GB per hour of mix |
| MP3 songs at 320 kbps | ~145 MB per hour of audio |
| WAV songs, 16-bit/44.1 kHz | ~635 MB per hour of audio |
| Visual | the original + a 1080p loop of a few to tens of MB |
| `tmp/` | free space for at least one full video and the largest upload |

Example: 30 one-hour videos with unused MP3 songs ≈ 4.5 GB of songs + 30–60 GB of videos.
Deleting the files of already-published videos saves the most space.

## Backup and restore

A backup needs two parts: the **database** (`app.db`) and the **`channels/`** folder with the media.
Paths in the database are relative to the data folder, so it can be moved. The `tmp/` folder does
not need to be backed up. In the examples, `DATA_PATH=./data` and the destination is `/backup`.

### Option A — stopped container (consistent, recommended)

```sh
docker compose stop
rsync -a ./data/ /backup/fabrica-$(date +%F)/ --exclude tmp/
docker compose start
```

Copy `app.db`, `app.db-wal` and `app.db-shm` together (the `rsync` above already does): in WAL mode,
some recent data may be in the `-wal` file.

### Option B — with the site running

1. Create a consistent copy of the database with SQLite (`VACUUM INTO` produces a single file, with
   no `-wal`):

   ```sh
   docker compose exec -T fabrica node --disable-warning=ExperimentalWarning -e \
     "new (require('node:sqlite').DatabaseSync)('/data/app.db').exec(\"VACUUM INTO '/data/app-backup.db'\")"
   mkdir -p /backup/fabrica-$(date +%F)
   mv ./data/app-backup.db /backup/fabrica-$(date +%F)/app.db
   ```

   If the host has `sqlite3`, `sqlite3 ./data/app.db ".backup '/backup/fabrica-$(date +%F)/app.db'"`
   does the same.

2. Right afterwards, copy the media (or take a volume/ZFS/LVM snapshot):

   ```sh
   rsync -a ./data/channels/ /backup/fabrica-$(date +%F)/channels/
   ```

The database and the media are copied at different moments: avoid uploading, deleting or rendering
during the backup. If you need a full guarantee, use option A.

### Restore

```sh
docker compose stop
mv ./data ./data-old                         # keep the current state until you have checked
mkdir ./data
rsync -a /backup/fabrica-YYYY-MM-DD/ ./data/
docker compose start
```

Restore `app.db` together with the `app.db-wal`/`app.db-shm` files **from the same backup**; never mix
it with `-wal`/`-shm` files from a different moment. A backup made with option B contains only
`app.db`.

### Test the restore

Test the backup without touching the live site by starting a second instance with a different
project name, port and folder:

```sh
rsync -a /backup/fabrica-YYYY-MM-DD/ /tmp/fabrica-restore/
DATA_PATH=/tmp/fabrica-restore PORT=8081 docker compose -p fabrica-restore up -d --build
```

Open http://localhost:8081 and check channels, songs, visuals and videos (play a few files).
Then run `docker compose -p fabrica-restore down` and delete `/tmp/fabrica-restore`.
Do not leave the test copy running: its worker also processes the render queue.

## Uploading files

**Through the site**: on the Upload page, choose an existing style for loose songs or **Criar novo
estilo** (create new style). When you drag a `<style>/` folder, its songs inherit the folder name;
images and short looping videos are added as the channel's visuals.

**From the terminal** (the channel number is in the URL, `/channels/<id>`). The `style` field must
come before the file:

```sh
for f in songs/lofi-jazz-lounge/*.mp3; do
  curl -fsS -F style=lofi-jazz-lounge -F "file=@$f" http://localhost:8080/channels/1/upload
done
```

The response is JSON with the result for each file (`added`, `restored`, `duplicate` or `error`).
If the server is remote, use the SSH tunnel, VPN or proxy described above.

Supported formats: audio `mp3 wav flac m4a aac ogg opus`; image `jpg jpeg png webp bmp`;
video `mp4 mov webm mkv m4v avi gif`.

## Development

```sh
npm ci
DATA_DIR=/tmp/fabrica npm run dev   # http://localhost:8080, reloads on save
npm run typecheck
npm run smoke
```

`npm run smoke` is the end-to-end test: it starts the real app on a random free port, with a
temporary data folder (deleted at the end; it never touches `./data`), and walks through creating a
channel, uploading short audio and image files, generating a draft, reviewing, approving, rendering,
scheduling and recording the publication. It needs Node ≥ 22.18 (CI uses 24) and `ffmpeg`/`ffprobe`
on the `PATH`; it uses no external network access or credentials and takes from seconds to a few
minutes, depending on the machine. GitHub CI (`.github/workflows/ci.yml`) runs `npm ci`,
`npm run typecheck` and `npm run smoke` on every push and pull request.

### Architecture

TypeScript executed directly by Node (no build step), Express 5, built-in SQLite (`node:sqlite`)
and ffmpeg. Pages are server-rendered HTML with a little JavaScript in the browser.

| File | Responsibility |
| --- | --- |
| `src/server.ts` | HTTP routes, forms, upload and download; starts the worker. |
| `src/config.ts` | Port, data folder, upload limit and output format (1080p30, 320k audio). |
| `src/db.ts` | SQLite schema and access (`$DATA_DIR/app.db`). |
| `src/jobs.ts` | Draft selection, review, automatic mode, queue and render worker. |
| `src/library.ts` | Receiving uploads, hash-based deduplication and deletions. |
| `src/media.ts` | ffmpeg/ffprobe calls: visual loop, thumbnail and mix render. |
| `src/views.ts` | HTML for all pages. |
| `public/app.js` | File/folder upload and page updates during renders. |
| `public/style.css` | Styles. |

## Contributing

Contributions are welcome — bug reports, documentation (including English and Portuguese docs) and
code. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and submit changes. Please report
security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Security

There is no built-in authentication. See [SECURITY.md](SECURITY.md) for the threat model and how to
report vulnerabilities privately.

## License

[MIT](LICENSE).
