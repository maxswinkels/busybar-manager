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
      "options": [ { "flag": "--lang", "type": "choice", "default": "en", "choices": ["de","en"], "min": null, "max": null, "step": null, "meta": "{de,en}", "help": "…" } ],
      "envSpec": [ { "key": "WEATHER_API_KEY", "example": "your-api-key-here", "help": "…" } ],
      "enabled": true,
      "status": "running",            // "running" | "starting" | "stopped" | "crashed"
      "pid": 123,
      "blocked": false,                // last draw got 409
      "lastDraw": { "ts": 1730000000000, "status": 200 },
      "variation": "default",
      "scheduledVariation": null,      // runtime override while a slot or a scroller owns this app
      "runtimeOwner": null,            // { "kind": "schedule" | "scroller", "id": "…", "name": "…" } | null
      "variations": {
        "default": { "args": {}, "env": {}, "priority": 10 }
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

## Schedule

A weekly repeating timetable. A **slot** pins one app + one of its variations — or one whole scroller — to a `[start, end)` window on one or more weekdays, so "Mon–Fri 08:00–10:00" is a single slot rather than five:

```json
{ "id": "8f1c…", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "10:00", "kind": "app", "slug": "clock", "variation": "night" }
{ "id": "3b0d…", "days": [0, 6], "start": "10:00", "end": "18:00", "kind": "scroller", "scrollerId": "a71e…" }
```

- `kind`: `"app"` (default) or `"scroller"`. An `"app"` slot carries `slug` + `variation`, a `"scroller"` slot carries `scrollerId`. `kind` is optional on input — a body with a `slug` is an app slot, which is exactly the shape slots had before scrollers existed — and always present in state and on disk.
- `days`: non-empty array of integers 0–6, **0 = Sunday** (same as JS `Date#getDay`), stored sorted and deduped. A single `day: 1` is accepted on input (and in configs written before multi-day slots) and normalized to `days: [1]`.
- `start` / `end`: `"HH:MM"`, 24h, local time. `end` also accepts `"24:00"` ("until the end of the day"); `end` must be later than `start`, so a slot never crosses midnight — spanning it means two slots.
- **No two slots may overlap on a day they share**, whatever app they name: at most one app is ever scheduled at any moment. Gaps are allowed, and in a gap the scheduler runs nothing.
- `id` is server-minted (uuid) on create and preserved on update.

State: `schedule: { "enabled": false, "slots": [ … ], "activeSlotId": null }` — `activeSlotId` is the slot being served right now (`null` when the schedule is off or the current moment falls in a gap).

Endpoints (all of them, except the GET, answer with the full state payload):

- `GET /api/_manager/schedule` → `{ enabled, slots, activeSlotId }`
- `PUT /api/_manager/schedule` body `{ "enabled": true }` — the master switch (persist; applied immediately).
- `POST /api/_manager/schedule/slots` body `{ days, start, end, kind?, slug, variation? }` (or `{ days, start, end, kind: "scroller", scrollerId }`) — create. `400` on malformed days/times or a bad `kind`, `404` on an unknown app, variation or scroller, `409` on an overlap (the message names the clashing slot's target and the days they share). `variation` defaults to `"default"`.
- `PUT /api/_manager/schedule/slots/:id` — same body and same errors; the slot being edited is excluded from the overlap check. `404` when the id is unknown.
- `DELETE /api/_manager/schedule/slots/:id` — `404` when the id is unknown.

Behavior:

- The scheduler **only manages the apps its own slots name**. An app the user enabled by hand keeps running alongside the scheduled one and is never stopped by a slot starting or ending.
- Starting a slot does **not** set `enabled` on the app: the run is runtime-only, so the window can end without rewriting the user's own on/off choice. The same goes for the variation — the slot's variation is applied as a runtime override, exposed per app in state as `scheduledVariation` (`null` when nothing owns the app), while `variation` keeps showing the user's own selection. `runtimeOwner` says which mechanism is holding the app up.
- A `"scroller"` slot hands the window to the scroller engine, which cycles the scroller's steps for as long as the slot lasts. It does **not** set `enabled` on the scroller either (state exposes that as `scheduled: true`), and when the window ends the cycle stops and the last step's app is stopped and cleared like any other scheduled app.
- When a slot ends: if the user also has the app enabled it is restarted under their own variation, otherwise it is stopped and its frame is cleared off the bar (`DELETE /api/display/draw`, exactly like a manual disable).
- Back-to-back slots for the same app only restart it when the variation differs.
- A crash inside a window is restarted by the normal supervisor backoff.
- The engine re-evaluates every 15 s (and immediately on any schedule change or at boot, so a manager restart mid-window brings the app back up). Local wall-clock time is re-read every tick, so DST shifts need no special handling.
- Deleting a variation a slot refers to is allowed; the slot then falls back to the app's own selected variation and logs a line.
- A hand-edited `config.json` containing overlapping slots, duplicate ids or malformed slots is not fatal: the offending entries are dropped on load and the rest is kept.

## Scrollers

A **scroller** is a named, ordered cycle of apps: each step puts one app + variation on the bar for a few seconds and then hands over to the next, wrapping at the end. It lets single-purpose apps stay simple — the bar pages through them instead of one app paging through everything.

```json
{
  "id": "a71e…",
  "name": "Desk",
  "enabled": false,
  "baseDurationSec": 30,
  "steps": [
    { "id": "0b2f…", "slug": "clock", "variation": "default", "durationSec": null },
    { "id": "9d51…", "slug": "weather", "variation": "night", "durationSec": 20 }
  ]
}
```

- `name`: non-empty, ≤ 60 characters, trimmed. Free text, not an id.
- `baseDurationSec`: whole seconds, 1–3600, default 30 — how long each step holds the bar.
- `steps`: ordered, may be empty (a scroller with nothing in it simply shows nothing). **The array order is the cycle order, so reordering is expressed by sending `steps` in the new order.** Every step names a `variation` explicitly (`"default"` when the body leaves it out) and may set `durationSec` (1–3600) to override `baseDurationSec` for that step only; `null` means "use the base duration".
- `id` (scroller and step alike) is server-minted on create. Step ids sent back on an update are preserved, so a reorder does not renumber the steps.

State: each entry of `scrollers` is the stored scroller plus what it is doing right now — `running` (a cycle is going), `scheduled` (a schedule slot is driving it), `activeStepId` and `activeSlug` (the step on the bar, `null` between/without steps).

Endpoints (all of them, except the GET, answer with the full state payload):

- `GET /api/_manager/scrollers` → `{ scrollers: [ … ] }`
- `POST /api/_manager/scrollers` body `{ name, baseDurationSec?, steps?, enabled? }` — create. `400` on a missing name or a bad duration, `404` on an unknown app or variation.
- `PUT /api/_manager/scrollers/:id` — same body and same errors; every field is optional and an omitted one keeps its stored value. `404` when the id is unknown.
- `DELETE /api/_manager/scrollers/:id` — also **drops every schedule slot that named this scroller**, which could otherwise only be a silent no-op in the calendar. `404` when the id is unknown.
- `POST /api/_manager/scrollers/:id/enable` | `/disable` — the scroller's own switch (persist; applied immediately).

Behavior:

- A scroller runs while the user enabled it **or** while a schedule slot names it. While running it holds exactly one app at a time, as a runtime claim: `enabled` in `config.apps` is never written, so a step handing over does not rewrite the user's own on/off choice. The app's row carries the claim in `scheduledVariation` + `runtimeOwner`.
- Handing over stops the previous step's app and clears its frame off the bar (`DELETE /api/display/draw`, exactly like a manual disable) — unless the user has that app enabled too, in which case it stays up and simply goes back to their own variation.
- Two scrollers may name the same app: the first claim decides the variation and the app stays up until the last claim is gone. An app the user enabled by hand is never stopped by a scroller stepping over it.
- Steps whose app is not installed are **skipped**, so a removed app costs no screen time; if that leaves nothing runnable the scroller keeps checking every 5 s instead of ending. Deleting a variation a step refers to is allowed: the step falls back to the app's own selected variation and logs a line.
- Renaming a scroller or toggling its switch does not disturb what is on the bar. Changing its `steps` or `baseDurationSec` restarts the cycle from step one, since continuing at the old index would land on an unrelated app.
- A manager restart brings an enabled scroller straight back up, starting its cycle from the first step.
- A hand-edited `config.json` containing malformed steps, unusable durations or duplicate scroller ids is not fatal: the offending entries are dropped (or fall back to the defaults) on load and the rest is kept.

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
      "variations": { "default": { "args": {}, "env": {}, "priority": 10 } }
    }
  },
  "scrollers": [
    {
      "id": "a71e…",
      "name": "Desk",
      "enabled": false,
      "baseDurationSec": 30,
      "steps": [{ "id": "0b2f…", "slug": "clock", "variation": "default", "durationSec": null }]
    }
  ],
  "schedule": {
    "enabled": false,
    "slots": [
      { "id": "8f1c…", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "10:00", "kind": "app", "slug": "clock", "variation": "default" }
    ]
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

## Option discovery (`options`)

An app that mentions `argparse` is run once with `--help` during the scan (cached on the script's mtime and on its `.venv`'s, so a venv built after a failed scan re-discovers), and its option lines become the fields the variation editor renders: `{ flag, type, default, choices, min, max, step, meta, help }`.

argparse prints each option as an invocation column (its names plus a metavar) and a help column separated by 2+ spaces, with the help moving to the next line when the invocation is too wide. The names are parsed strictly, the metavar loosely, because argparse never validates a metavar (issue #20):

- **Several names per option** are read in both layouts argparse uses: `--language, --lang {de,en}` (Python ≥ 3.13) and `--language {de,en}, --lang {de,en}` (older). The option is reported once, under its **longest** name, which is also the name a variation stores; the aliases are not listed separately. A short-only option (`-q`) is reported under its short name.
- **Any metavar** is accepted and reported verbatim as `meta`, which the dashboard shows as the field's placeholder when there is no default: `OWNER/NAME`, `NAME=URL`, `FIVE,WEEK`, `START:END`, `[QUERY]` (`nargs="?"`), `W H` (`nargs=2`), `TAGS [TAGS ...]` (`nargs="+"`).
- **`type`**: no metavar → `bool`; `{a,b,c}` (also bracketed, `[{a,b,c}]`) → `choice`; a numeric range metavar (`0-100`, `1..10`, `-10-10`, `0.0-1.0`) or a long run of consecutive int choices → `int`/`float` with `min`/`max`/`step`, rendered as a slider; anything else → `str`.
- **`default`** is read from a `(default: …)` in the help text, not from argparse itself.
- `-h/--help`, `--host`, `--token` and `--test` are never offered: the supervisor owns them.
- A metavar naming several values (`W H`, `TAGS [TAGS ...]`) is passed to the app as separate argv entries, so a variation stores `"--size": "10 20"` and the app is started with `--size 10 20`.

## Env var discovery (`envSpec`)

An app folder containing `.env.example` (also accepted: `env.example`, `.env.sample`) declares which env vars it reads. The manager parses it during the scan — cached on the file's mtime, same as argparse option discovery — and reports the result per app as `envSpec`, an ordered list of `{ key, example, help }`:

- `KEY=value` and `export KEY=value` lines; `#` comment lines directly above an entry (no blank line in between) become its `help`; a value may be quoted, and an unquoted trailing `# note` is stripped.
- `example` is `null` when the template leaves the value empty. First occurrence of a key wins.
- The dashboard renders one field per entry with the **name fixed** and the example value as the input's placeholder; env vars stored on a variation that the template does not declare stay editable free-form KEY/value rows.

**Example values are never applied.** They are documentation (`your-api-key-here`), so the manager passes only what the variation actually stores; an empty field means the key is not set at all and the app falls back to its own default. A flat `<appsDir>/<slug>.py` app has `envSpec: []` — it shares its folder with every other flat script there, so a folder-level template cannot be attributed to it.

## Supervisor behavior

- Start: `<python> app.py --host 127.0.0.1:<listenPort> [variation-args]`, cwd = the app directory, env = process.env + the variation env. `--host` from the variation args is ignored/overwritten (the manager determines the host).
- Python: an app directory with `requirements.txt` → a per-app `.venv` (created with `python3 -m venv`, `pip install -r requirements.txt`, a sha256 stamp of the requirements to know when to refresh: same approach as busybar-emulator server.js). Otherwise the global `python3`.
- Crash (exit ≠ 0 or unexpected): status "crashed", restart with backoff 1s → 2s → 4s → … max 60s; backoff resets after 5 min of stable running.
- Stop: SIGTERM, after 3 s SIGKILL; then a display clear for that app (see disable).
- When the manager itself shuts down (SIGTERM/SIGINT): stop all apps, clear nothing (the bar may keep the last frame), do not change the config.
- Removal stops the app the same way disable does and sends a display clear, but only when it was actually running — a batch of never-started orphans must not spend 5 s per app waiting on an unreachable bar. A removed app never restarts itself: once its config entry is gone it reads back as disabled, which is what the restart guards check.
