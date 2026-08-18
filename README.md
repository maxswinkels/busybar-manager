<p align="center">
  <img src=".github/logo.svg" width="180" alt="BUSY" />
</p>

<h1 align="center">BUSY Bar Manager</h1>

<p align="center">
  Run, manage and monitor apps for the <code>BUSY Bar</code>.<br>
  Toggle apps on and off, see who owns the screen, install from the community library, and autostart everything after a reboot.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &middot; <a href="#app-library">App library</a> &middot; <a href="#the-api">API</a> &middot; <a href="#autostart-macos">Autostart</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/requires-Node%20%E2%89%A522-339933" alt="Node" />
  <img src="https://img.shields.io/badge/and-python3-3776ab" alt="Python" />
  <img src="https://img.shields.io/badge/web%20UI-Vue%203-42b883" alt="Vue 3" />
  <img src="https://img.shields.io/badge/code-MIT-yellow" alt="License" />
</p>

<p align="center">
  <img src="docs/screenshot-dashboard.png" width="720" alt="BUSY Bar Manager dashboard" />
</p>

---

> [!TIP]
> **Part of a small family of tools.** Build and test apps against [busybar-emulator](https://github.com/maxswinkels/busybar-emulator), a local BUSY Bar that needs no hardware, and browse or share them in [busybar-apps](https://github.com/maxswinkels/busybar-apps), the community gallery this manager installs from.

> [!IMPORTANT]
> **Unofficial community project.** Built and maintained by [Max Swinkels](https://github.com/maxswinkels), **not** an official Flipper Devices / BUSY product, and not affiliated with, endorsed by, or supported by them. "BUSY Bar" remains their trademark. For the real hardware and official apps, visit **[busy.app](https://busy.app)**.

## Why

- **Manage many apps at once.** Toggle apps on and off from the dashboard, with a live view of who's running and who currently owns the bar's screen.
- **Named variations per app.** Save presets of argparse flags + environment variables + an optional priority override. Switch a variation and the manager restarts the app for you.
- **Install from the community library.** Pull apps straight from [busybar-apps](https://github.com/maxswinkels/busybar-apps) with one click, with update detection — a notification and an Update button, never a silent auto-update.
- **Autostart after reboot.** One command (`scripts/install.sh`) turns it into a macOS LaunchAgent: after login the manager runs and every enabled app starts in its chosen variation.

## Quick start

```bash
git clone https://github.com/maxswinkels/busybar-manager.git
cd busybar-manager
npm run build   # builds the dashboard into web/dist (once, and after web changes)
node server.js
# → Dashboard: http://127.0.0.1:8321
```

Open **http://127.0.0.1:8321**, install apps from the **Library** tab (pulled from [busybar-apps](https://github.com/maxswinkels/busybar-apps)), and toggle them on. The manager listens on `127.0.0.1:8321` and starts each app with `--host 127.0.0.1:8321`, forwarding its draws to the bar. The server itself is zero-dependency, so `npm run build` only installs what Vite needs for the dashboard; skip it and the server still runs, it just serves a plain-text page instead of the UI.

> [!TIP]
> No hardware yet? Point the manager at the [emulator](https://github.com/maxswinkels/busybar-emulator) instead: set **Bar host** to `127.0.0.1:8080` in the Settings tab. Everything works the same.

## Dashboard

The Vue 3 dashboard is served by `server.js` itself (no separate web server) and has four tabs, each on its own URL:

- **Apps** (`/apps`) — every discovered app with an on/off switch, a variation picker, restart, live logs, and a badge showing who owns the screen.
- **Schedule** (`/schedule`) — a weekly repeating timetable: pin an app + variation to a time window on a weekday.
- **Controller** (`/controller`) — press the bar's buttons remotely over `POST /api/input`: the main **Start** button, the state keys (busy, custom, off, apps, settings) and the up/ok/down/back navigation pad.
- **Library** (`/library`) — browse the community catalog with previews; install, update or remove apps, or upload a zipped one.
- **Settings** (`/settings`) — the bar host (real bar or emulator) and any local dev folders.

The header shows a live **connection** indicator and the bar's **battery** state, and the device preview mirrors the real 72×16 LEDs frame-by-frame.

## Schedule

The **Schedule** tab runs a weekly repeating timetable, drawn as a week calendar: hours down the side, seven day columns, each slot a block at its own time so the same window across several days lines up. Click empty space to add a slot there, or a block to edit it.

A slot pins one app and one of its variations to a `[start, end)` window on **one or more weekdays** — "Mon–Fri 08:00–10:00" is one slot, not five. Slots never overlap on a day they share, so at most one scheduled app runs at a time, and a gap simply means nothing is scheduled then.

- The **master switch** pauses the whole timetable without deleting anything.
- The scheduler **only manages the apps its own slots name**. An app you switched on yourself on the Apps tab keeps running alongside, and a slot ending never touches it.
- A scheduled run does **not** flip the app's own on/off switch, and the slot's variation is applied as a runtime override — your own selection on the Apps tab stays as you left it. While a slot owns an app, its row shows a `SCHEDULED · <variation>` chip.
- When a slot ends the app is stopped and its frame is cleared off the bar, unless you also have it enabled — then it just goes back to your own variation.
- Times are local, slots never cross midnight (use two slots), and `end` may be `24:00` for "until the end of the day". A manager restart mid-window brings the app straight back up.

## App library

The manager installs apps directly from the community repository ([maxswinkels/busybar-apps](https://github.com/maxswinkels/busybar-apps)), so you always have the latest versions.

- **Install** from the Library tab; installed apps are yours to enable. They land in `<project>/apps/<slug>/` with a hidden `.busybar-library.json` recording the source repo + commit SHA.
- **Updates** are checked every 6 hours (`library.checkIntervalHours`) or on demand with the refresh button. An "update available" chip and a small Update button appear on the app row; updating restarts the app only if it was already running. If GitHub is unreachable, the last known catalog is kept.
- **Local dev apps**: add folders to `appsDirs` in `config.json`. They're scanned alongside library apps; on a name clash the local app wins (marked `source: local`) and is edited through your dev folder, not the manager.

### App structure (both sources)

```
app-folder/
  app.py           # Python entry point (takes --host)
  manifest.yaml    # name, description, tags
  requirements.txt # dependencies (optional)
```

`app.py` accepts `--host`, e.g. `python3 app.py --host 10.0.4.20` (real bar) or `--host 127.0.0.1:8321` (manager). Argparse options like `add_argument('--brightness', type=int, default=80)` become dashboard form controls (sliders, dropdowns with `choices`, …); the manifest supplies name, description and tags.

## Variations

A variation is a named preset of:

1. **Argparse options** — auto-detected from the app's `--help` (e.g. `--host`, `--brightness`, `--color`).
2. **Environment variables** — free key/value pairs.
3. **Priority override** (optional) — a number 1–100 injected into this app's `POST /api/display/draw` payloads.

Example: app `clock` has a variation `night` = `{"args": {"--brightness": "30"}, "env": {}, "priority": 60}`. Select `night` in the dashboard and the manager restarts it as `python3 app.py --host 127.0.0.1:8321 --brightness 30`, injecting priority 60 into every draw.

## Screen-owner detection

The firmware exposes no endpoint for the current screen owner's `application_name`, so the manager runs as a local HTTP proxy:

1. Apps start with `--host 127.0.0.1:8321`.
2. Every `POST /api/display/draw` is forwarded to the bar (`barHost`, default `10.0.4.20`).
3. The manager records the `application_name` and the response: **200** → this app owns the screen; **409** → its priority was too low (blocked).
4. `screenOwner` expires ~10 s after the last successful draw (a firmware app — e.g. the BUSY timer — is probably drawing then).

The dashboard shows who owns the screen live, plus who's actively trying to draw.

## Autostart (macOS)

Two ways to keep the manager running: this LaunchAgent, or [Docker](#docker). Both work, so pick whichever fits your machine. They can't run side by side, because both want port 8321.

Run the installer once:

```bash
./scripts/install.sh
```

It checks Node ≥22 + python3, builds the dashboard (`web/dist`), creates `logs/`, installs the LaunchAgent to `~/Library/LaunchAgents/nl.backspaced.busybar-manager.plist` (substituting the real node path + project dir), bootstraps it with `launchctl`, and starts it. After login the manager always runs and every enabled app starts in its chosen variation.

```bash
tail -f logs/manager.log logs/manager.err.log   # view logs
./scripts/uninstall.sh                           # remove the LaunchAgent (project files stay)
```

## Docker

Running in a container is an alternative to the [LaunchAgent](#autostart-macos), not a replacement for it: same manager, different runtime. Use it if you'd rather keep Node and Python off your machine, or run the manager on a Linux box.

> [!NOTE]
> If running the LaunchAgent, `docker compose up` will fail because the LaunchAgent already binds 8321. Either stop the LaunchAgent first, or change `BUSYBAR_PORT` in `.env` to a free port.

```bash
docker compose up -d          # build + start, dashboard on http://127.0.0.1:8321
docker compose logs -f        # follow the manager log (it logs to stdout)
docker compose down           # stop
```

The image is `node:22-slim` plus `python3`/`python3-venv`/`python3-pip`, since every community app gets its own `.venv` created at start. The dashboard is built from `web/src` in a first build stage.

| Host | Container | Holds |
| --- | --- | --- |
| `./docker/data` | `/data` | `config.json` (path set via `BUSYBAR_MANAGER_CONFIG`) |
| `./docker/apps` | `/app/apps` | apps installed from the library/uploads, plus their `.venv`s |

`config.json` is mounted as a *directory*, not a single file: the manager saves it with a tmp-file + `rename`, which fails against a bind-mounted file. Seed it by copying `config.example.json` to `docker/data/config.json` — a missing file just boots the defaults.

A few things differ from a bare-metal run:

- **Set `TZ` in `.env` to your own timezone.** A container with no `TZ` runs on UTC, and the scheduler matches slots against local time (`getDay()`/`getHours()` in `activeSlotAt`), so a slot set for 08:00 would fire at 10:00 on a CEST host. The compose file defaults to `TZ=Europe/Amsterdam`; `docker compose exec busybar-manager date` shows what the container actually thinks the time is.

- `BUSYBAR_PUBLISH_HOST` (default `127.0.0.1`) set to `0.0.0.0` to make it reachable from the LAN. The dashboard has no authentication, so only do that on a trusted network.
- **`config.json`'s `listenPort` is ignored**; instead set `BUSYBAR_PORT` in `.env` (default 8321).
- In `local` bar mode, `barHost` must be an IP or DNS name the container can resolve. Docker's bridge network reaches the LAN fine, but it does not do mDNS — a `*.local` bar hostname needs the IP instead, or `network_mode: host`.
- **Autostart is Docker's job here, not launchd's.** The container restarts itself (`restart: always`), but only once the daemon runs, so on macOS turn on Docker Desktop's *Settings → General → Start Docker Desktop when you sign in*. Without it, a reboot leaves the bar dark.

## The API

Everything under `/api/*` that isn't `/api/_manager/*` is forwarded 1:1 to the bar. The manager's own endpoints live under `/api/_manager/`:

```bash
curl -s localhost:8321/api/_manager/state | jq
```

<details>
<summary>Manager endpoints</summary>

| Method &amp; path | Purpose |
|---|---|
| `GET /api/_manager/state` | Full state: apps, status, `screenOwner`, bar connection, library |
| `POST /api/_manager/apps/<slug>/enable` · `/disable` · `/restart` | App control |
| `POST /api/_manager/apps/<slug>/variation` | Switch the selected variation |
| `PUT /api/_manager/apps/<slug>/variations/<name>` | Create/update a preset (`args`, `env`, `priority`) |
| `GET /api/_manager/apps/<slug>/log` | Last ~500 log lines |
| `DELETE /api/_manager/apps/<slug>` | Remove an app: stop it, delete its folder, drop its config entry |
| `GET /api/_manager/cleanup` · `POST …/cleanup` | Find and remove stale config entries + duplicate installs |
| `PUT /api/_manager/settings` | Update `barHost` / `appsDirs` / library token |
| `GET /api/_manager/library` · `POST …/install` · `…/update` · `…/uninstall` | App library |
| `GET /events` | SSE stream for live updates (state, logs) |
| `GET /api/_bar/…` | Read-only passthrough to the bar (e.g. its SSE) |
| `/api/*` | Everything else forwarded 1:1 to the bar |

See [docs/CONTRACT.md](docs/CONTRACT.md) for the full specification.

</details>

## Architecture

```
Python apps (--host 127.0.0.1:8321)
        │ HTTP
        ▼
busybar-manager (server.js, Node ≥22, zero-dependency)
        ├─ Proxy ───────────▶ BUSY Bar (10.0.4.20) or emulator
        ├─ WebSocket client ◀─ frames from the firmware
        ├─ SSE /events ─────▶ browser
        └─ Dashboard (Vue 3, served from web/dist)
```

Zero-dependency Node server, Vue 3 frontend built with Vite, SSE for live updates, `config.json` for persistence.

### Building the dashboard

`server.js` serves the built web UI from `web/dist/`. That folder is **not committed** (it's gitignored): everyone builds it from `web/src/`, so frontend PRs never collide over a generated bundle. Build it once after cloning, and again after changing anything in `web/src/`:

```bash
npm run build          # from the repo root
cd web && npm run dev  # or: live-reloading Vite dev server
```

`scripts/install.sh` builds it for you as part of setting up the LaunchAgent. There's deliberately no automated build on `node server.js`, and no git hook: do it manually after web changes. Without a build the server still starts and the API works; `/` just answers with a note explaining how to build the dashboard.

## Configuration

Settings live in `config.json` (atomic writes; changes from the dashboard persist automatically). Copy `config.example.json` to start:

```json
{
  "listenPort": 8321,
  "barHost": "10.0.4.20",
  "appsDirs": [],
  "library": {
    "checkIntervalHours": 6,
    "repos": [
      { "repo": "maxswinkels/busybar-apps", "branch": "main" }
    ]
  },
  "apps": {
    "clock": {
      "enabled": true,
      "variation": "default",
      "variations": {
        "default": { "args": { "--brightness": "80" }, "env": {}, "priority": null }
      }
    }
  }
}
```

- `listenPort` — port the manager listens on (default 8321). The `PORT` env var overrides it, which is what the Docker setup uses; see [Docker](#docker).
- `barMode` — `"local"` (default) talks to the bar on your network; `"cloud"` routes every bar request through `https://api.busy.app/busybar/…` instead, so the bar doesn't have to be reachable from this machine.
- `barHost` — IP or `host:port` of the bar, `barMode: "local"` only (default `10.0.4.20`; use `127.0.0.1:8080` for the emulator).
- `token` — the bar's Wi-Fi token, sent as `X-API-Token` in local mode.
- `cloudToken` — your BUSY account token, sent as `Authorization: Bearer` in cloud mode. Create one at [cloud.busy.app/api-tokens](https://cloud.busy.app/api-tokens). Different secret from `token`; both are kept when you switch modes.
- `appsDirs` — folders of local apps in development (default empty).
- `library.repos[]` — GitHub repos to install from (`repo`, `branch`); `library.checkIntervalHours` sets the update-check cadence.
- `apps.<slug>` — per app: `enabled`, the selected `variation`, and named `variations` (`args`, `env`, optional `priority` 1–100).

> `config.json` is git-ignored — it holds your local args and any library token. Commit `config.example.json` as the template instead.

## Testing

```bash
npm test
```

A zero-dependency end-to-end suite against a mock BUSY Bar + mock GitHub, covering app scanning and the supervisor, proxy behavior and priority/409 attribution, state persistence across restarts, variation switching and crash recovery, the library flow (ETag caching, token handling, install/update/uninstall, zip upload with path-traversal rejection), cleanup of stale and duplicate apps (orphan removal, path containment, duplicate detection and wholesale settings migration), the bar passthrough, and the remote-control key presses behind the Controller tab.

## Requirements

- **Node.js ≥ 22**
- **python3**
- **macOS** for autostart (the LaunchAgent is macOS-specific; the server itself is cross-platform)
- …or **Docker** — the compose setup ships both runtimes, see [Docker](#docker)
- A **BUSY Bar** over USB-ethernet (default `10.0.4.20`) or Wi-Fi — or the [emulator](https://github.com/maxswinkels/busybar-emulator)

## Related projects

- **[busybar-emulator](https://github.com/maxswinkels/busybar-emulator)**: the device. A faithful local BUSY Bar with the same HTTP API, fonts and pixels, to build and test against without hardware.
- **[busybar-apps](https://github.com/maxswinkels/busybar-apps)**: the apps. A community gallery of 72×16 apps this manager installs from.
- **[busy.app](https://busy.app)**: the real hardware and official apps from Flipper Devices.

## License

Code is [MIT](LICENSE). Bundled BUSY logo, app icon and device artwork are © Flipper Devices, from the open-source [firmware](https://github.com/busy-app/busybar-firmware) under CC-BY 4.0. See [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for the details.

"BUSY Bar" is a trademark of Flipper Devices. This project is unaffiliated and unofficial.

## Author

**Max Swinkels**
