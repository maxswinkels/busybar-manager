import { computed, reactive, watch } from 'vue'

// Global manager state, mirrored from the backend over SSE (GET /events).
// Shape matches GET /api/_manager/state exactly (see docs/CONTRACT.md).
export const manager = reactive({
  barMode: 'local', // 'local' = LAN bar at barHost, 'cloud' = api.busy.app
  barHost: '',
  tokenSet: false, // whether a bar token is configured; the token itself is never sent to the frontend
  cloudTokenSet: false, // same, for the cloud account token (a different secret)
  listenPort: 8321,
  barReachable: false,
  screenOwner: null, // { applicationName, slug, since } | null
  apps: [],
  appsDirs: [],
  connected: false, // SSE connection to the manager itself
  library: { lastCheck: null, updatesAvailable: 0, error: null }, // summary, see docs/CONTRACT-LIBRARY.md
})

// Per-app log line buffers, appended to live via SSE `log` events and
// seeded from GET /api/_manager/apps/:slug/log on demand.
export const logs = reactive({}) // slug -> string[]

// Full app-library catalog (GitHub repo apps), fetched on demand when the
// Library tab opens — NOT pushed over SSE (only the summary above is).
// Shape matches GET /api/_manager/library exactly, v2 / multi-repo + v3
// (docs/CONTRACT-LIBRARY.md "Config v2 — meerdere repos" / "v3-aanvullingen"):
// { checkIntervalHours, repos: [{repo, branch, lastCheck, error}], checking,
//   catalog, tokenSet }. The token itself is never sent to the frontend —
// only whether one is set.
export const library = reactive({
  checkIntervalHours: 6,
  repos: [],
  checking: false,
  catalog: [],
  tokenSet: false,
})

function applyState(st) {
  Object.assign(manager, st)
}

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => {
    try {
      applyState(JSON.parse(e.data))
    } catch (_) {
      /* ignore malformed frame */
    }
  })
  es.addEventListener('log', (e) => {
    try {
      const { slug, line } = JSON.parse(e.data)
      if (!slug) return
      if (!logs[slug]) logs[slug] = []
      logs[slug].push(line)
      if (logs[slug].length > 1000) logs[slug].splice(0, logs[slug].length - 1000)
    } catch (_) {
      /* ignore malformed frame */
    }
  })
  es.onopen = () => {
    manager.connected = true
  }
  es.onerror = () => {
    manager.connected = false
  }
  return es
}
connect()

async function apiJson(method, path, body) {
  try {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = await r.json().catch(() => ({}))
    return { status: r.status, ok: r.ok, json }
  } catch (err) {
    return { status: 0, ok: false, json: { error: String(err) } }
  }
}

export async function fetchState() {
  const r = await apiJson('GET', '/api/_manager/state')
  if (r.ok) applyState(r.json)
  return r
}

export async function enableApp(slug) {
  return apiJson('POST', `/api/_manager/apps/${encodeURIComponent(slug)}/enable`)
}
export async function disableApp(slug) {
  return apiJson('POST', `/api/_manager/apps/${encodeURIComponent(slug)}/disable`)
}
export async function restartApp(slug) {
  return apiJson('POST', `/api/_manager/apps/${encodeURIComponent(slug)}/restart`)
}
export async function setVariation(slug, name) {
  return apiJson('POST', `/api/_manager/apps/${encodeURIComponent(slug)}/variation`, { name })
}
export async function putVariation(slug, name, { args, env, priority }) {
  return apiJson(
    'PUT',
    `/api/_manager/apps/${encodeURIComponent(slug)}/variations/${encodeURIComponent(name)}`,
    { args: args || {}, env: env || {}, priority: priority ?? null }
  )
}
export async function deleteVariation(slug, name) {
  return apiJson(
    'DELETE',
    `/api/_manager/apps/${encodeURIComponent(slug)}/variations/${encodeURIComponent(name)}`
  )
}
export async function fetchLog(slug) {
  const r = await apiJson('GET', `/api/_manager/apps/${encodeURIComponent(slug)}/log`)
  if (r.ok) logs[slug] = r.json.lines || []
  return r
}
export async function updateSettings(patch) {
  const r = await apiJson('PUT', '/api/_manager/settings', patch)
  if (r.ok) await fetchState()
  return r
}

/* --------------------------- stale / duplicate apps ------------------------ */

// Cleanup report, shape matches GET /api/_manager/cleanup exactly (see
// docs/CONTRACT.md "Cleanup"). NOT pushed over SSE — the server keeps it out of
// the state payload because detecting duplicates costs a stamp read per app,
// same split as the library catalog. Refetched whenever the set of app slugs
// changes, which is the only way a duplicate or orphan can appear.
export const cleanup = reactive({
  orphans: [],
  duplicates: [],
  removable: [],
  counts: { orphans: 0, duplicateGroups: 0, removable: 0 },
  loading: false,
  loaded: false,
})

export async function fetchCleanup() {
  cleanup.loading = true
  const r = await apiJson('GET', '/api/_manager/cleanup')
  cleanup.loading = false
  if (r.ok) {
    Object.assign(cleanup, r.json)
    cleanup.loaded = true
  }
  return r
}

// Remove one app: stops it, deletes its managed folder (never an appsDirs
// folder — the server enforces that) and drops its config entry. Unlike
// uninstallApp this needs no library stamp, so it also covers orphans,
// uploads and manually dropped folders.
export async function removeApp(slug) {
  const r = await apiJson('DELETE', `/api/_manager/apps/${encodeURIComponent(slug)}`)
  if (r.ok) {
    applyState(r.json)
    await fetchCleanup()
  }
  return r
}

// Batch removal. Sends back exactly the slugs the panel rendered; the server
// re-validates each against its own current report and skips anything that is
// no longer stale, so a stale tab can never widen the delete.
export async function runCleanup(slugs, migrateVariations = true) {
  const r = await apiJson('POST', '/api/_manager/cleanup', { slugs, migrateVariations })
  if (r.ok) {
    if (r.json.state) applyState(r.json.state)
    await fetchCleanup()
  }
  return r
}

const slugKey = computed(() =>
  manager.apps
    .map((a) => a.slug)
    .sort()
    .join('|')
)
watch(slugKey, () => {
  fetchCleanup()
})

/* ---------------------------- remote control ------------------------------- */

// Single key press on the bar (openapi.yaml: POST /api/input?key=…). Goes out
// over the manager's generic /api/* bar-proxy, so it picks up the configured
// credential and works in both `local` and `cloud` mode. Fire-and-forget: the
// bar acknowledges the event but never reports which state it ended up in, so
// there is nothing to fold back into `manager`.
export const INPUT_KEYS = ['up', 'down', 'ok', 'back', 'start', 'busy', 'custom', 'off', 'apps', 'settings']
export async function sendInput(key) {
  return apiJson('POST', `/api/input?key=${encodeURIComponent(key)}`)
}

/* ------------------------------ app library -------------------------------- */

// Note: r.status === 404 here means an old (pre-multi-repo) server binary is
// still running (this has happened on Max's Mac) — the caller (LibrarySection)
// is responsible for surfacing that distinctly instead of an empty catalog.
export async function fetchLibrary(refresh) {
  const r = await apiJson('GET', `/api/_manager/library${refresh ? '?refresh=1' : ''}`)
  if (r.ok) Object.assign(library, r.json)
  return r
}
export async function checkLibrary() {
  const r = await apiJson('POST', '/api/_manager/library/check')
  if (r.ok) Object.assign(library, r.json)
  return r
}
// `repo` is required by the backend only when `slug` collides across linked
// repos, but it's harmless (and correct) to always pass it along — the
// catalog entry always knows which repo it came from.
// fetchCleanup here is the guard against a repo-side folder rename quietly
// leaving a second copy behind: the "Clean up" badge lights up right away
// instead of the duplicate going unnoticed.
export async function installApp(slug, repo) {
  const r = await apiJson('POST', '/api/_manager/library/install', repo ? { slug, repo } : { slug })
  if (r.ok) await Promise.all([fetchState(), fetchLibrary(false), fetchCleanup()])
  return r
}
export async function updateApp(slug) {
  const r = await apiJson('POST', '/api/_manager/library/update', { slug })
  if (r.ok) await Promise.all([fetchState(), fetchLibrary(false)])
  return r
}
export async function uninstallApp(slug) {
  const r = await apiJson('POST', '/api/_manager/library/uninstall', { slug })
  if (r.ok) await Promise.all([fetchState(), fetchLibrary(false), fetchCleanup()])
  return r
}
export async function addLibraryRepo(repo, branch) {
  const r = await apiJson('POST', '/api/_manager/library/repos', branch ? { repo, branch } : { repo })
  if (r.ok) Object.assign(library, r.json)
  return r
}
export async function removeLibraryRepo(repo) {
  const r = await apiJson('DELETE', '/api/_manager/library/repos', { repo })
  if (r.ok) Object.assign(library, r.json)
  return r
}

// Optional GitHub token (v3-aanvullingen): saved via the same settings
// endpoint as barHost/appsDirs; empty string clears it. The server never
// echoes the token back — re-fetch the library payload afterward so
// `library.tokenSet` reflects the new state.
export async function saveLibraryToken(token) {
  const r = await updateSettings({ libraryToken: token })
  if (r.ok) await fetchLibrary(false)
  return r
}

// Zip upload (v3-aanvullingen): raw bytes, not JSON — bypasses apiJson.
// `filename` is an optional hint (matches the server's own fallback: slug =
// ?slug > zip's single top-folder > this filename hint > "uploaded-app").
export async function uploadLibraryApp(file) {
  try {
    const buf = await file.arrayBuffer()
    const qs = new URLSearchParams({ filename: file.name || '' })
    const r = await fetch(`/api/_manager/library/upload?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: buf,
    })
    const json = await r.json().catch(() => ({}))
    if (r.ok) await Promise.all([fetchState(), fetchLibrary(false), fetchCleanup()])
    return { status: r.status, ok: r.ok, json }
  } catch (err) {
    return { status: 0, ok: false, json: { error: String(err) } }
  }
}

fetchState()
fetchCleanup()
