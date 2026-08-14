# busybar-manager: API contract (binding for both server and web)

The manager listens on **port 8321** (configurable). One port for everything: proxy, manager API, SSE, and the built web UI (`web/dist`).

## Proxy

Everything under `/api/*` that does NOT start with `/api/_manager` and is not `/events` is forwarded 1-to-1 to the bar. Method, query string, headers (minus hop-by-hop), body, and status code stay intact.

Two transports, selected by `barMode` (string, `"local"` | `"cloud"`, default `"local"`) at the top level of config:

| | `local` (default) | `cloud` |
|---|---|---|
| upstream | `http://<barHost>` (default `10.0.4.20`) | `https://api.busy.app/busybar` (override with `BUSYBAR_CLOUD_API_BASE`) |
| path | verbatim: `/api/<path>` | leading `/api` swapped for the base path: `/busybar/<path>` |
| credential | `token` as header `X-API-Token: <token>` | `cloudToken` as header `Authorization: Bearer <cloudToken>` |

Header handling differs per mode. `local` forwards the caller's headers 1-to-1 (minus hop-by-hop). `cloud` keeps only `content-type`, `content-length`, `accept`, `accept-encoding`, `accept-language` and the `sec-websocket-*` handshake headers, and sends `User-Agent: busybar-manager/<version>`: the request upstream is the manager's, not the app's, and api.busy.app is behind Cloudflare, which rejects forwarded script user-agents with `error code 1010`.

`token` and `cloudToken` (both string|null) are **different secrets** — `token` is the bar's Wi-Fi token, `cloudToken` is the BUSY account token. Both stay stored when the mode is toggled. The configured value overrides anything the caller sent, and the credential for the inactive mode is stripped from forwarded requests. Exception, `local` mode only: WebSocket upgrades (`/api/status/ws`) carry `token` as the `X-API-Token` **query parameter** instead, which is the only form the bar honours there; in `cloud` mode the upgrade is server-to-server, so the `Authorization` header is used there too. NEVER echo either token back in state/settings payloads.

Special case: `POST /api/display/draw`: the manager parses the JSON body:
- records `application_name` (the payload also accepts `app_id`; support both) + response status;
- if the sending app (matched on application_name → slug, see the mapping below) has an active variation with a `priority` override, `priority` in the payload is replaced before forwarding;
- response 200 → this app is the screen owner; 409 → the app is "blocked".

`screenOwner` = the application_name of the last successful draw; falls back to `null` if there has been no successful draw for >10 s.

Mapping application_name→slug: when an app starts, the supervisor remembers which application_names that app uses (the first draw after starting an unknown application_name is attributed to… nothing; matching is based on observed names per draw + a heuristic: if only one managed app is running, every draw is from that app). In practice: keep a counter/last-status per application_name and show the application_name itself in the UI; link it to a slug if the name equals the slug or if the slug's app is the only runner. Exact linking is best-effort; the UI always shows the application_name.

## Manager API (JSON)

- `GET /api/_manager/state` →
```json
{
  "barMode": "local",
  "barHost": "10.0.4.20",
  "tokenSet": false,
  "cloudTokenSet": false,
  "listenPort": 8321,
  "barReachable": true,
  "screenOwner": { "applicationName": "flightradar", "slug": "flightradar", "since": 1730000000000 },
  "apps": [
    {
      "slug": "clock",
      "name": "Clock",
      "description": "…",
      "tags": ["clock"],
      "dir": "/abs/path/apps/clock",
      "options": [ { "flag": "--host", "type": "str", "default": "10.0.4.20", "choices": null, "help": "…" } ],
      "enabled": true,
      "status": "running",            // "running" | "starting" | "stopped" | "crashed"
      "pid": 123,
      "blocked": false,                // last draw got 409
      "lastDraw": { "ts": 1730000000000, "status": 200 },
      "variation": "default",
      "variations": {
        "default": { "args": {}, "env": {}, "priority": null }
      }
    }
  ]
}
```
- `POST /api/_manager/apps/:slug/enable`: enabled=true + start (and persist).
- `POST /api/_manager/apps/:slug/disable`: stop + enabled=false (persist). After stopping, sends a `DELETE /api/display/draw?application_name=<name(s)>` to the bar so the app does not leave its frame behind.
- `POST /api/_manager/apps/:slug/restart`
- `POST /api/_manager/apps/:slug/variation` body `{ "name": "night" }`: select the variation; if the app is running: restart with the new args/env.
- `PUT /api/_manager/apps/:slug/variations/:name` body `{ "args": {"--brightness": "50"}, "env": {"API_KEY": "x"}, "priority": 40 }`: create/overwrite (persist).
- `DELETE /api/_manager/apps/:slug/variations/:name` (the selected one and "default" must not be removed if it is the last one; when the selected one is removed, the selection falls back to "default").
- `DELETE /api/_manager/apps/:slug`: remove the app entirely — stop it, delete its folder under `<projectroot>/apps/`, drop its config entry (persist). Needs no library stamp, so it also covers config-only orphans, zip uploads and manually dropped folders. An `appsDirs` app loses its config entry but its folder is never touched. 400 on an unsafe slug (see Cleanup), 404 when the slug is neither on disk nor in the config, otherwise the new state.
- `GET /api/_manager/apps/:slug/log` → `{ "lines": ["…"] }` (the last ±500 lines, stdout+stderr merged with a prefix).
- `PUT /api/_manager/settings` body `{ "barMode"?, "barHost"?, "token"?, "cloudToken"?, "appsDirs"? }` (persist; changing barMode or barHost reconnects the mirror and the proxy target). `barMode` must be `"local"` or `"cloud"` (400 otherwise). `token` / `cloudToken`: `""` clears it, any other string sets it, omitting the key leaves the stored token untouched — the frontend never receives either token back, so a blank input field means "keep".
- `GET /api/_manager/cleanup` → the stale/duplicate report (see Cleanup below). Read-only, never mutates. Deliberately not part of the state payload: detecting duplicates costs a stamp read per installed app, and state is pushed at up to ~4/s.
```json
{
  "orphans": [ { "slug": "pr-test-10", "enabled": false, "hasSettings": false } ],
  "duplicates": [
    {
      "id": "owner/repo:weather-forecast",
      "keep": "weather-forecast",
      "remove": ["weather_forecast"],
      "confidence": "certain",                 // "certain" | "review"
      "signals": ["same-repo", "identical-files", "normalized-slug", "same-name"],
      "reason": null,                          // why it is review-only, when it is
      "migrate": { "from": "weather_forecast", "to": "weather-forecast", "variations": ["default"] },
      "apps": [
        { "slug": "weather-forecast", "name": "Weather Forecast", "role": "keep",
          "source": "library", "repo": "owner/repo", "enabled": false,
          "installedAt": 0, "updatedAt": 0, "inCatalog": true, "hasSettings": false }
      ]
    }
  ],
  "removable": ["pr-test-10", "weather_forecast"],
  "counts": { "orphans": 1, "duplicateGroups": 1, "removable": 2 }
}
```
- `POST /api/_manager/cleanup` body `{ "slugs": ["…"], "migrateVariations"?: true }` → `{ "removed": [ { "slug", "dirRemoved", "configRemoved" } ], "migrated": [ { "from", "to", "variations" } ], "skipped": [ { "slug", "reason" } ], "errors": [ { "slug", "error" } ], "state": { … } }`. Takes explicit slugs (never a "remove everything stale" flag) and re-validates each against the server's own current `removable` set — anything no longer stale lands in `skipped`, so a stale UI can never widen an irreversible delete. Writes a `config.json.pre-cleanup-<ts>` backup before the first mutation. The only endpoint that nests the state instead of returning it directly, because a batch operation's point is its report.
- `GET /api/_manager/health` → `{ "ok": true }`

Errors: `{ "error": "…" }` with an appropriate 4xx/5xx.

## SSE `GET /events`

Same pattern as busybar-emulator. Events:
- `event: state`: data = the full state payload (like GET state), pushed on every change, throttled (max ~4/s).
- `event: log`: data = `{ "slug": "clock", "line": "…" }`.

(No frames over SSE: the browser does the mirror itself, see below.)

## Bar passthrough `/api/_bar/*` (for the emulator mirror)

`GET /api/_bar/<path>` forwards streaming (pipe, no buffering: SSE must work) to `http://<barHost>/<path>` (in `cloud` mode: `<cloud base>/<path>`). GET only; the query is passed through; 502 when the bar is unreachable. It exists because `/events` on the manager is already taken by its own SSE, and the emulator mirror needs `GET <emulator>/events` + asset paths (`/animations/*`, `/public/*`) same-origin.

## Mirror (frontend)

Source order: (1) firmware ws, (2) `/api/screen` polling (the real bar), (3) **emulator SSE**: `EventSource('/api/_bar/events')` → `state` events contain `frame: { application_name, elements, ts }`; render with the vendored emulator renderer (`web/src/lib/emu/renderer.js` + `atlas.js` + `public/fonts/font-atlas.json`, taken from busybar-emulator) so the image is pixel-identical to the emulator itself. Asset references (animations/images) via `/api/_bar/...`. If this also drops out → placeholder.

1. Primary: the browser opens `ws://<manager>/api/status/ws` (same origin); the manager tunnels the upgrade to `ws://<barHost>/api/status/ws` and, when `token` is configured, appends it as the **`X-API-Token` query parameter** — on a ws upgrade the bar accepts the credential only that way, and a browser `WebSocket` cannot set the `X-API-Token` header. The frontend then sends `{"enable": true}` (text JSON), and receives binary protobuf `BSB_State` messages. Decode + render with npm `@busy-app/busy-lib@^0.17` (exports include `BSB_State`, `BSB_Frame`, `LEDRenderer`, `LocalStateStream`, `convertRGB888toRGBA`). See the firmware reference `StateScreenStream.vue` (copy in docs/reference/). Front display = 72×16, a frame can be RGB (3 bytes/pixel, order BGR→see the convert helpers) or with alpha; RLE compression possible: use the busy-lib helpers instead of decoding yourself where possible.
2. Fallback (ws fails or no frames within 3 s): poll `GET /api/screen?display=0` via the manager proxy (same origin) at 1 fps; the response is base64 BMP → `<img src="data:image/bmp;base64,…">` to a canvas.
3. Neither (e.g. emulator as bar): show a clean "no mirror available" placeholder.

## Config (`config.json` in the project root, written atomically via tmp+rename)

```json
{
  "listenPort": 8321,
  "barMode": "local",
  "barHost": "10.0.4.20",
  "token": null,
  "cloudToken": null,
  "appsDirs": ["/Users/maxswinkels/Developer/busybar-apps/apps"],
  "apps": {
    "clock": {
      "enabled": true,
      "variation": "default",
      "variations": { "default": { "args": {}, "env": {}, "priority": null } }
    }
  }
}
```
Unknown apps in the config (directory gone) are kept but marked in state with `"missing": true`, and can be removed with `DELETE /api/_manager/apps/:slug` or in bulk via the cleanup endpoints. The manager never removes them on its own initiative. Apps without a config entry get runtime defaults (disabled, empty "default" variation) and are only persisted once Max changes something.

## Cleanup

Two kinds of junk accumulate in the installed list. Both are **detected and reported only** — cleanup is always user-initiated and never runs at boot (an `appsDirs` volume that happens to be offline makes every app on it look missing).

- **Orphan** — a `config.apps` entry with no matching folder in the scan, i.e. exactly the `"missing": true` records in state.
- **Duplicate** — one upstream app installed under two slugs, typically because the repo renamed its folder and the install created a copy instead of replacing.

Duplicate signals, ranked. Grouping only ever happens within a single `(source, repo)` bucket: library stamps carry git blob shas and upload stamps carry sha256, so the two namespaces are never compared. `source: "local"` apps are never grouped at all.

| | signal | weight |
|---|---|---|
| S1 | same `repo` + identical `.busybar-library.json` `files` sha map | strongest |
| S2 | slug equality after normalizing (lowercase, `_`/whitespace → `-`) | medium |
| S3 | identical manifest `name` | corroborating only, never on its own — two repos both shipping a "Clock" is normal |

`confidence: "certain"` (pre-checked in the UI, the only thing listed in `removable`) requires `S1 && (S2 || S3)`. Everything else is `confidence: "review"`: surfaced with a `reason`, never auto-removable. That includes two copies that are both enabled (a deliberate dual-run) and two copies that both carry custom settings.

**Keeper rule**, in order: enabled → still in the catalog → newest `updatedAt` (falling back to `installedAt`) → slug ascending. Catalog membership outranks recency because a slug the catalog no longer carries can never receive an update again; `updatedAt` outranks `installedAt` because an update deliberately preserves the original `installedAt`.

**Variation migration** is wholesale or not at all — never a key-by-key merge, which would produce a config that runs but is wrong. It only fires when the keeper's config is still pristine (a single untouched `default` variation) and exactly one of the removed copies carries settings. `enabled` is never migrated: the keeper rule already prefers the enabled copy.

**Containment invariant:** the manager only ever deletes directories that are direct, non-dot, non-symlink children of `<projectroot>/apps/`. A slug is a single path segment — separators, `.`/`..` and leading dots are rejected with a 400, always after decoding. `appsDirs` folders are never deleted under any code path.

## Supervisor behavior

- Start: `<python> app.py --host 127.0.0.1:<listenPort> [variation-args]`, cwd = the app directory, env = process.env + the variation env. `--host` from the variation args is ignored/overwritten (the manager determines the host).
- Python: an app directory with `requirements.txt` → a per-app `.venv` (created with `python3 -m venv`, `pip install -r requirements.txt`, a sha256 stamp of the requirements to know when to refresh: same approach as busybar-emulator server.js). Otherwise the global `python3`.
- Crash (exit ≠ 0 or unexpected): status "crashed", restart with backoff 1s → 2s → 4s → … max 60s; backoff resets after 5 min of stable running.
- Stop: SIGTERM, after 3 s SIGKILL; then a display clear for that app (see disable).
- When the manager itself shuts down (SIGTERM/SIGINT): stop all apps, clear nothing (the bar may keep the last frame), do not change the config.
- Removal stops the app the same way disable does and sends a display clear, but only when it was actually running — a batch of never-started orphans must not spend 5 s per app waiting on an unreachable bar. A removed app never restarts itself: once its config entry is gone it reads back as disabled, which is what the restart guards check.
