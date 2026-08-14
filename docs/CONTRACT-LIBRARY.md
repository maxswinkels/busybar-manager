# busybar-manager: app-library from the GitHub repo (binding contract, supplement to CONTRACT.md)

Goal: install and update apps directly from the community repo (`maxswinkels/busybar-apps`), so that no second manually maintained copy exists. Update detection shows a notification in the dashboard; updating is a single button. Max's decisions: source = GitHub repo; notification + button (no auto-update); everything via the library (appsDirs default empty, local dev happens outside the manager).

## Config (v2, multiple repos)

```json
"library": {
  "checkIntervalHours": 6,
  "repos": [
    { "repo": "maxswinkels/busybar-apps", "branch": "main" }
  ]
}
```
- The server fills in missing `library` defaults when loading config. Migration: an old block with `repo`/`branch` at the library level is automatically converted to `repos: [{repo, branch}]`.
- Multiple repos: the catalog is the merge of all linked repos; each catalog entry gets a `repo` field. Slug clash between repos: both entries appear in the catalog (repo visible on the card); only one can be installed at a time under that slug, installing the second returns 409 with a clear error ("first remove <slug> from <other repo>").
- Repo management: `POST /api/_manager/library/repos` body `{ "repo": "owner/name", "branch"?: "main" }` (validates the `owner/name` format, dedupe, persist, triggers a check); `DELETE /api/_manager/library/repos` body `{ "repo" }` (unlink; installed apps from that repo remain and keep running, but their catalog entry and update detection lapse, in state such an app gets `updateAvailable: false`).
- The library payload (GET/check) becomes: `{ "checkIntervalHours", "repos": [ { "repo", "branch", "lastCheck": ts|null, "error": string|null } ], "checking": bool, "catalog": [ { ..., "repo": "owner/name" } ] }`, errors per repo (one broken repo must not block or empty the catalog of another).
- The `library/install` body becomes `{ "slug", "repo"? }`, `repo` is required when the slug appears in multiple repos (otherwise 400 with an explanation).
- UI empty state: "No apps found" only after a successful check with an empty catalog. When `lastCheck: null`, opening the Library tab itself triggers a `?refresh=1`. If the frontend gets a 404 on `/api/_manager/library` (an old server is still running), then explicitly show "The manager server is running an older version, restart the manager" instead of an empty catalog.
- Installed apps live in `<projectroot>/apps/<slug>/` (fixed location, no config option). This directory is ALWAYS scanned, in addition to any `appsDirs` (which are empty by default).
- Dedupe on duplicate slug: an app from `appsDirs` wins over the library installation and gets `"source": "local"` in state.

## v3 additions: rate limits, token, zip upload, library subtabs

**Rate limits (GitHub 403 "rate limit exceeded", Max ran into it on his Mac):**
- Conditional requests: cache per API URL `{ etag, body }`; send `If-None-Match`; a 304 does NOT count against the rate limit and uses the cache. The cache lives in-memory (per process), good enough.
- Optional GitHub token: `library.token` (string|null) in config. If set: `Authorization: Bearer <token>` on all api.github.com requests (5000/hour instead of 60). NEVER send the token back in state/library payloads, expose only `tokenSet: true|false`. `PUT /api/_manager/settings` accepts `{ "libraryToken": "..." }` (empty string = clear).
- Error copy on a 403 rate limit: the server puts a recognizable message in the repo error ("GitHub rate limit — add a token in Library settings or retry later").
- Frontend: opening the Library tab triggers an auto-refresh only if the last check is older than 10 minutes (or never); manual refresh is always possible.

**Zip upload (your own apps without a repo):**
- `POST /api/_manager/library/upload?slug=<optional>`, body: raw zip bytes (Content-Type `application/zip`), max 5 MB. Zero-dep unzip in server.js: parse the central directory, support compression methods 0 (stored) and 8 (deflate, via `zlib.inflateRawSync`). Reject entries with `..`, absolute paths, or symlinks.
- Shape: the zip contains either `app.py` at the root, or exactly one top-level directory containing `app.py`. Slug = `?slug` > top-directory name > zip filename stem; sanitize to `[a-z0-9_-]`, clash with an existing local/library app → 409.
- Write like install (staging + atomic rename) to `apps/<slug>/`, with a stamp `{ "source": "upload", "files": { "<path>": "<sha256>" }, "installedAt": ts }`. The app appears disabled in state with `source: "upload"`, `updateAvailable` always false. `library/uninstall` also works for upload apps (stamp present = allowed). Response: `{ "slug": "..." }`.
- Upload apps do NOT appear in the catalog (they are not repo apps); they simply live in the Apps list.

**Library subtabs (UI):** the Library tab gets two subtabs in firmware style (segmented/pill nav at the top of the card): **Apps** (the catalog) and **Settings** (manage linked repos with clear UX, a GitHub token field (password input, shows only "token set"), and the zip upload). The "linked repos" block moves from the catalog to this Settings subtab.

**Header (parity with the emulator):** battery indicator like the emulator (`GET /api/status` via the existing proxy → `power.state` + `power.battery_charge`; icons/tiers from the emulator App.vue + icons.js: charging/full/tier low≤20/mid≤50/high, 30s poll, only shown when the bar is reachable), and the connected indicator exactly like the emulator (usb icon + "Connected" + host).

## Installation records

Per installed app: `<projectroot>/apps/<slug>/.busybar-library.json`:
```json
{ "repo": "maxswinkels/busybar-apps", "branch": "main", "commit": "<commitSha at install>",
  "files": { "app.py": "<gitBlobSha>", "manifest.yaml": "<sha>", "requirements.txt": "<sha>" },
  "installedAt": 0, "updatedAt": 0 }
```
- Runtime files + `manifest.yaml` are installed; `preview.*`, `__pycache__`, `.venv` are not (the UI shows previews via a raw URL).
- The scanner ignores `.busybar-library.json` and may mark an app directory with a stamp as `source: "library"`.
- The `files` sha map is also the primary duplicate signal (CONTRACT.md "Cleanup"): two slugs with the same `repo` and an identical map are the same app installed twice. Library stamps carry **git blob shas** and upload stamps carry **sha256**, so the two are never compared with each other. An empty/missing map is never a match — otherwise every stampless app would collide with every other one.

## GitHub access (server, zero-dep, global fetch)

- Check (max 2 API calls): `GET {API}/repos/{repo}/branches/{branch}` → commit sha; `GET {API}/repos/{repo}/git/trees/{sha}?recursive=1` → paths + blob shas. Only paths under `apps/` are relevant.
- File contents NEVER via the API but via `{RAW}/{repo}/{commitSha}/apps/<slug>/<file>` (raw.githubusercontent.com; no rate limit, pinned to the commit).
- Manifests for the catalog: raw URL per app, cached on blob sha (only fetch when opening the library or when the sha changed). Reuse the mini YAML parser from server.js.
- `updateAvailable(slug)` = the tree contains, under `apps/<slug>/`, a tracked file with a different blob sha, or an added/removed runtime file (preview.* and dotfiles do not count).
- Periodic check: at boot (after ~15 s) and then every `checkIntervalHours`. Errors (offline/rate limit): keep the last known catalog, record the error, retry later.
- Env overrides for tests: `BUSYBAR_LIBRARY_API_BASE` (default `https://api.github.com`) and `BUSYBAR_LIBRARY_RAW_BASE` (default `https://raw.githubusercontent.com`). URL construction exactly as above so a mock server can replay them.

## Manager API (supplement)

- `GET /api/_manager/library` → `{ "repo", "branch", "lastCheck": ts|null, "checking": bool, "error": string|null, "catalog": [ { "slug", "name", "description", "tags": [], "installed": bool, "updateAvailable": bool, "previewUrl": string|null, "source": "library"|"local"|null } ] }`, catalog from the last check cache; `?refresh=1` forces a new check (waits for it, timeout ~10 s).
- `POST /api/_manager/library/check` → same payload, forces a check.
- `POST /api/_manager/library/install` body `{ "slug" }` → installs at the last checked commit; the app appears disabled in state (Max enables it himself). 409 if the slug already exists locally (appsDirs), 404 if unknown in the catalog.
- `POST /api/_manager/library/update` body `{ "slug" }` → reinstalls files at the newest commit; if the app was running, it is automatically restarted afterward. Config/variations remain untouched. The per-app `.venv` is removed if `requirements.txt` changed (the sha stamp does the rest).
- `POST /api/_manager/library/uninstall` body `{ "slug" }` → stops the app if necessary, removes `<projectroot>/apps/<slug>/` and the config entry. Only allowed for apps with a library stamp. Superseded by `DELETE /api/_manager/apps/:slug` (CONTRACT.md), which does the same thing without requiring a stamp and therefore also handles config-only orphans and manually dropped folders; kept for compatibility.
- `GET /api/_manager/state` additions: per app `"source": "library"|"local"`, `"updateAvailable": bool`; top-level `"library": { "lastCheck", "updatesAvailable": <count>, "error" }`.
- SSE `state` events contain the additions; after a check that changes something, state is pushed.

## UI

- The Apps card gets, top-right (next to the LIVE chip), a "Library" button (pill with a book/download icon).
- Library modal (glass, same visual language as the rest): header with the repo name + "last checked …" + refresh button; grid/list of catalog apps with a preview image (previewUrl, with a neat fallback), name, description, tags; per app: an "Install" button (brand), or an "installed" chip + optionally an "Update" button, or a "local" chip (not installable); a secondary "Remove" action on installed apps (confirm in the button itself: first click → "Sure?"). Error banner on library.error.
- App row in the main list: an "update available" chip (brand color) + a small "Update" pill when updateAvailable; a subtle "local" source chip for appsDirs apps.
- All UI text is English (the dashboard UI is intentionally English); visual style exactly the existing design system.

## Behavior & edge cases

- Installing never starts an app automatically; updating only restarts what was already running.
- Atomic writes: first to `apps/.staging-<slug>-<ts>/`, then rename over the target directory (move the old directory to `.trash-<ts>` first and clean it up); a half-successful download must never wreck a working app.
- Removed-app config: on uninstall the config entry disappears (so variations too), that is fine.
- `missing: true` apps from config that exist in the catalog → the UI does not show them twice; install restores them.
- An install that lands the same upstream app under a **second** slug (because the repo renamed its folder) does not auto-replace the old copy — silently deleting an app the user did not mention, during an "Install" click, is exactly the surprise cleanup exists to undo. It surfaces as a detected duplicate instead (CONTRACT.md "Cleanup"), and the frontend refetches the cleanup report right after an install so the badge appears immediately.
