// Vite dev-server middleware that fakes the busybar-manager backend
// (manager API + SSE + screen fallback) so the dashboard can be built and
// screenshotted without the real Node daemon running. Mirrors the shape
// defined in docs/CONTRACT.md and docs/CONTRACT-LIBRARY.md (v2, multi-repo)
// exactly.
//
// Enabled by default in `npm run dev`. Set VITE_MANAGER_MOCK=0 to disable it
// and proxy straight to a real manager on 127.0.0.1:8321 instead (see
// vite.config.js).

function nowMs() {
  return Date.now()
}

function makeApp(overrides) {
  return {
    slug: '',
    name: '',
    description: '',
    tags: [],
    dir: '/fake/apps/x',
    options: [],
    enabled: true,
    status: 'stopped',
    pid: null,
    blocked: false,
    lastDraw: null,
    variation: 'default',
    variations: { default: { args: {}, env: {}, priority: null } },
    missing: false,
    source: null, // "library" | "local" | null — see docs/CONTRACT-LIBRARY.md
    updateAvailable: false,
    ...overrides,
  }
}

// The firmware's `key` enum for POST /api/input (openapi.yaml), mirrored here
// so the mock rejects the same keys the real bar would.
const INPUT_KEYS = ['up', 'down', 'ok', 'back', 'start', 'busy', 'custom', 'off', 'apps', 'settings']

const REPO_A = 'maxswinkels/busybar-apps'
const REPO_B = 'pixelfriends/busybar-community' // fake third-party repo, for the dev mock only
const RAW_BASE_A = `https://raw.githubusercontent.com/${REPO_A}/main/apps`
const RAW_BASE_B = `https://raw.githubusercontent.com/${REPO_B}/main/apps`

function makeCatalogApp(overrides) {
  return {
    slug: '',
    name: '',
    description: '',
    tags: [],
    installed: false,
    updateAvailable: false,
    previewUrl: null,
    source: null,
    repo: REPO_A,
    ...overrides,
  }
}

// slug -> repo it was actually installed from (library-sourced apps only).
// Mirrors the server's ".busybar-library.json" stamp for the purposes of the
// mock: it's what makes a same-slug entry in a *different* linked repo read
// as "not installed" (collision) and what a second install attempt from that
// other repo would 409 against.
const installedFrom = {
  flightradar: REPO_A,
  clock: REPO_A,
}

function createCatalog() {
  return [
    makeCatalogApp({
      slug: 'flightradar',
      name: 'Flightradar',
      description: 'Shows the nearest overflying aircraft on the bar.',
      tags: ['live', 'adsb'],
      installed: true,
      updateAvailable: true,
      source: 'library',
      previewUrl: `${RAW_BASE_A}/flightradar/preview.png`,
      repo: REPO_A,
    }),
    makeCatalogApp({
      slug: 'clock',
      name: 'Clock',
      description: 'Simple digital clock with a blinking seconds separator.',
      tags: ['clock', 'basic'],
      installed: true,
      updateAvailable: false,
      source: 'library',
      previewUrl: `${RAW_BASE_A}/clock/preview.png`,
      repo: REPO_A,
    }),
    makeCatalogApp({
      slug: 'weather',
      name: 'Weather',
      description: 'Current weather with temperature and icon.',
      tags: ['weather'],
      installed: false,
      source: 'local',
      previewUrl: `${RAW_BASE_A}/weather/preview.png`,
      repo: REPO_A,
    }),
    makeCatalogApp({
      slug: 'pixel-fire',
      name: 'Pixel Fire',
      description: 'A calming animation of a crackling pixel fire.',
      tags: ['ambient', 'animation'],
      installed: false,
      source: null,
      previewUrl: `${RAW_BASE_A}/pixel-fire/preview.gif`,
      repo: REPO_A,
    }),
    makeCatalogApp({
      slug: 'nyan-cat',
      name: 'Nyan Cat',
      description: 'The classic rainbow cat, endlessly airborne.',
      tags: ['meme', 'animation'],
      installed: false,
      source: null,
      previewUrl: `${RAW_BASE_A}/nyan-cat/preview.gif`,
      repo: REPO_A,
    }),
    makeCatalogApp({
      slug: 'pomodoro',
      name: 'Pomodoro',
      description: 'Focus timer with short work and break blocks.',
      tags: ['productivity'],
      installed: false,
      source: null,
      previewUrl: `${RAW_BASE_A}/pomodoro/preview.png`,
      repo: REPO_A,
    }),
    // Cross-repo slug collision: "clock" also exists in the third-party repo,
    // but the installed one is from REPO_A — so this card must render
    // side-by-side with the one above, showing installed: false here.
    makeCatalogApp({
      slug: 'clock',
      name: 'Retro Clock',
      description: 'A community fork of Clock with a CRT scanline effect.',
      tags: ['clock', 'community'],
      installed: false,
      updateAvailable: false,
      source: null,
      previewUrl: `${RAW_BASE_B}/clock/preview.png`,
      repo: REPO_B,
    }),
    makeCatalogApp({
      slug: 'retro-radio',
      name: 'Retro Radio',
      description: 'Animated VU meter for a paired internet radio stream.',
      tags: ['audio', 'community'],
      installed: false,
      source: null,
      previewUrl: `${RAW_BASE_B}/retro-radio/preview.gif`,
      repo: REPO_B,
    }),
  ]
}

function createLibraryState() {
  return {
    checkIntervalHours: 6,
    repos: [
      { repo: REPO_A, branch: 'main', lastCheck: nowMs() - 5 * 60 * 1000, error: null },
      // Deliberately in an error state in the dev mock, so the per-repo error
      // banner + "failing repo never hides the others' catalog" behavior is
      // clickable/visible without a real GitHub outage.
      {
        repo: REPO_B,
        branch: 'main',
        lastCheck: nowMs() - 40 * 60 * 1000,
        error: 'GitHub API rate limit exceeded — add a personal access token in Library settings or retry later',
      },
    ],
    checking: false,
    catalog: createCatalog(),
    // Optional GitHub token (v3-aanvullingen). Never sent to the frontend —
    // only `tokenSet` (see libraryPayload() below) — mirrors the real server.
    token: null,
  }
}

// Mirrors the server's own summary derivation (docs/CONTRACT-LIBRARY.md /
// CONTRACT.md "library" block on GET state): overall lastCheck is the latest
// across repos, error is the first repo error found, updatesAvailable is
// counted off the *app* records (so unlinking a repo — which only clears its
// catalog entries — correctly zeroes it via apiLibraryRemoveRepo below).
function librarySummary(library, apps) {
  let lastCheck = null
  let error = null
  for (const r of library.repos) {
    if (r.lastCheck && (!lastCheck || r.lastCheck > lastCheck)) lastCheck = r.lastCheck
    if (r.error && !error) error = r.error
  }
  const updatesAvailable = apps.filter((a) => a.source === 'library' && a.updateAvailable).length
  return { lastCheck, updatesAvailable, error }
}

function createMockState() {
  return {
    barMode: 'local',
    barHost: '10.0.4.20',
    tokenSet: false,
    cloudTokenSet: false,
    listenPort: 8321,
    barReachable: true,
    screenOwner: { applicationName: 'flightradar', slug: 'flightradar', since: nowMs() - 42_000 },
    apps: [
      makeApp({
        slug: 'flightradar',
        name: 'Flightradar',
        description: 'Shows the nearest overflying aircraft on the bar.',
        tags: ['live', 'adsb'],
        status: 'running',
        pid: 4821,
        blocked: false,
        lastDraw: { ts: nowMs() - 1200, status: 200 },
        source: 'library',
        updateAvailable: true,
        variation: 'default',
        variations: {
          default: { args: { '--radius': '15' }, env: {}, priority: null },
          night: { args: { '--radius': '15', '--dim': 'true' }, env: {}, priority: 30 },
        },
        options: [
          { flag: '--host', type: 'str', default: '10.0.4.20', choices: null, help: 'BUSY Bar host (managed by the manager)' },
          { flag: '--radius', type: 'int', default: '25', choices: null, help: 'Search radius in kilometers' },
          { flag: '--dim', type: 'bool', default: false, choices: null, help: 'Use dimmed colors' },
          { flag: '--units', type: 'str', default: 'metric', choices: ['metric', 'imperial'], help: 'Units' },
        ],
      }),
      makeApp({
        slug: 'clock',
        name: 'Clock',
        description: 'Simple digital clock with a blinking seconds separator.',
        tags: ['clock', 'basic'],
        status: 'running',
        pid: 4900,
        blocked: true,
        lastDraw: { ts: nowMs() - 800, status: 409 },
        source: 'library',
        updateAvailable: false,
        variation: 'default',
        variations: { default: { args: {}, env: {}, priority: null } },
        options: [
          { flag: '--host', type: 'str', default: '10.0.4.20', choices: null, help: 'BUSY Bar host (managed by the manager)' },
          { flag: '--format', type: 'str', default: '24h', choices: ['24h', '12h'], help: 'Time format' },
        ],
      }),
      // A duplicate pair (the repo renamed its folder, so the install made a
      // second copy) plus a config-only orphan, so the cleanup panel has
      // something to show in `npm run dev`. See docs/CONTRACT.md "Cleanup".
      makeApp({
        slug: 'weather-forecast',
        name: 'Weather Forecast',
        description: 'Current weather and multi-day forecasts for BUSY Bar.',
        tags: ['weather', 'info'],
        status: 'stopped',
        pid: null,
        enabled: false,
        source: 'library',
        variations: { default: { args: {}, env: {}, priority: null } },
      }),
      makeApp({
        slug: 'weather_forecast',
        name: 'Weather Forecast',
        description: 'Current weather and multi-day forecasts for BUSY Bar.',
        tags: ['weather', 'info'],
        status: 'stopped',
        pid: null,
        enabled: false,
        source: 'library',
        variations: { default: { args: { '--city': 'Rijnsburg', '--days': '7' }, env: {}, priority: null } },
      }),
      makeApp({
        slug: 'pr-test-13',
        name: 'pr-test-13',
        description: '',
        tags: [],
        dir: null,
        status: 'stopped',
        pid: null,
        enabled: false,
        missing: true,
      }),
      makeApp({
        slug: 'weather',
        name: 'Weather',
        description: 'Current weather with temperature and icon.',
        tags: ['weather'],
        status: 'stopped',
        pid: null,
        enabled: false,
        blocked: false,
        lastDraw: null,
        source: 'local',
        updateAvailable: false,
        variation: 'default',
        variations: { default: { args: { '--city': 'Amsterdam' }, env: {}, priority: null } },
        options: [
          { flag: '--host', type: 'str', default: '10.0.4.20', choices: null, help: 'BUSY Bar host (managed by the manager)' },
          { flag: '--city', type: 'str', default: 'Amsterdam', choices: null, help: 'City for the weather forecast' },
          { flag: '--interval', type: 'float', default: '10', choices: null, help: 'Refresh interval in minutes' },
        ],
      }),
    ],
  }
}

const LOG_LINES = {
  flightradar: [
    '[stdout] booting flightradar app…',
    '[stdout] ADS-B feed connected',
    '[stdout] draw ok (200) — PH-BGA @ FL340',
  ],
  clock: [
    '[stdout] clock tick',
    '[stderr] draw blocked: 409 (higher priority owns screen)',
  ],
  weather: [
    '[stdout] app stopped',
  ],
}

// A tiny 72x16 24-bit BMP with a soft gradient + a bright "on" pixel block,
// so the mirror fallback has something real to render in the screenshot.
function buildFakeBmpBase64() {
  const W = 72, H = 16
  const rowSize = Math.ceil((W * 3) / 4) * 4
  const pixelArrSize = rowSize * H
  const fileSize = 54 + pixelArrSize
  const buf = Buffer.alloc(fileSize)
  buf.write('BM', 0)
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(0, 6)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(W, 18)
  buf.writeInt32LE(H, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(0, 30)
  buf.writeUInt32LE(pixelArrSize, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < H; y++) {
    // BMP rows are stored bottom-up.
    const srcY = H - 1 - y
    for (let x = 0; x < W; x++) {
      const off = 54 + srcY * rowSize + x * 3
      // Simulate a "FLIGHTRADAR" style readout: dim amber background,
      // brighter block simulating text, matching the screenOwner app.
      const inText = y >= 4 && y <= 11 && x >= 4 && x <= 46 && (x % 6 < 4)
      const r = inText ? 255 : 30
      const g = inText ? 170 : 18
      const b = inText ? 20 : 4
      buf[off] = b
      buf[off + 1] = g
      buf[off + 2] = r
    }
  }
  return buf.toString('base64')
}

const FAKE_BMP_BASE64 = buildFakeBmpBase64()

function isValidRepoFormat(s) {
  return typeof s === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s)
}

export function managerMockPlugin() {
  const state = createMockState()
  const library = createLibraryState()
  state.library = librarySummary(library, state.apps)
  /** @type {Set<import('http').ServerResponse>} */
  const sseClients = new Set()
  let logTimer = null

  function broadcastState() {
    state.library = librarySummary(library, state.apps)
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`
    for (const res of sseClients) res.write(payload)
  }

  function libraryPayload() {
    return {
      checkIntervalHours: library.checkIntervalHours,
      repos: library.repos,
      checking: library.checking,
      catalog: library.catalog,
      tokenSet: !!library.token,
    }
  }

  // Simulates the ~600ms round-trip a real GitHub check would take, so the
  // "checking…" state is visible while developing/screenshotting. REPO_B
  // deliberately keeps failing every check (deterministic for
  // dev/screenshot purposes) while REPO_A's lastCheck advances normally —
  // a failing repo never blocks or empties the others' catalog.
  function runLibraryCheck(res) {
    library.checking = true
    broadcastState()
    setTimeout(() => {
      library.checking = false
      for (const r of library.repos) {
        if (r.repo === REPO_B) continue // stays broken on purpose, see above
        r.lastCheck = nowMs()
        r.error = null
      }
      broadcastState()
      if (res) sendJson(res, 200, libraryPayload())
    }, 600)
  }

  function broadcastLog(slug, line) {
    const payload = `event: log\ndata: ${JSON.stringify({ slug, line })}\n\n`
    for (const res of sseClients) res.write(payload)
  }

  function findApp(slug) {
    return state.apps.find((a) => a.slug === slug)
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (_) {
          resolve({})
        }
      })
    })
  }

  // Raw-bytes body reader for the zip upload endpoint (v3-aanvullingen) —
  // Content-Type: application/zip, not JSON.
  function readRawBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  function sendJson(res, status, obj) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(obj))
  }

  // Derived from the live mock state rather than hardcoded, so removing an app
  // in the dev UI actually empties the panel. The real detector compares
  // .busybar-library.json sha maps; here "same name, normalized-equal slugs"
  // stands in for that, which is enough to exercise the UI.
  function hasSettings(app) {
    const v = (app.variations && app.variations[app.variation]) || {}
    return !!(Object.keys(v.args || {}).length || Object.keys(v.env || {}).length || v.priority != null)
  }
  function buildMockCleanup() {
    const orphans = state.apps
      .filter((a) => a.missing)
      .map((a) => ({ slug: a.slug, enabled: a.enabled, hasSettings: hasSettings(a) }))

    const byName = {}
    for (const a of state.apps) {
      if (a.missing || a.source === 'local') continue
      ;(byName[a.name] = byName[a.name] || []).push(a)
    }
    const duplicates = Object.values(byName)
      .filter((group) => group.length > 1)
      .map((group) => {
        const keep = group.find((a) => a.enabled) || group.find((a) => !hasSettings(a)) || group[0]
        const losers = group.filter((a) => a.slug !== keep.slug)
        const bothDirty = hasSettings(keep) && losers.some(hasSettings)
        const bothOn = group.filter((a) => a.enabled).length > 1
        const confidence = bothDirty || bothOn ? 'review' : 'certain'
        const donor = losers.find(hasSettings)
        return {
          id: `mock:${keep.slug}`,
          keep: keep.slug,
          remove: losers.map((a) => a.slug),
          confidence,
          signals: ['same-repo', 'identical-files', 'normalized-slug', 'same-name'],
          reason: bothOn
            ? 'both copies are enabled — disable the one you don\'t want first'
            : bothDirty
              ? 'both copies have custom settings'
              : null,
          migrate:
            confidence === 'certain' && donor && !hasSettings(keep)
              ? { from: donor.slug, to: keep.slug, variations: Object.keys(donor.variations || {}) }
              : null,
          apps: group.map((a) => ({
            slug: a.slug, name: a.name, role: a.slug === keep.slug ? 'keep' : 'remove',
            source: a.source, repo: installedFrom[a.slug] || REPO_A, enabled: a.enabled,
            installedAt: nowMs() - 86_400_000, updatedAt: nowMs() - 86_400_000,
            inCatalog: a.slug === keep.slug, hasSettings: hasSettings(a),
          })),
        }
      })

    const removable = orphans
      .map((o) => o.slug)
      .concat(duplicates.filter((g) => g.confidence === 'certain').flatMap((g) => g.remove))
      .sort()
    return {
      orphans,
      duplicates,
      removable,
      counts: { orphans: orphans.length, duplicateGroups: duplicates.length, removable: removable.length },
    }
  }

  return {
    name: 'busybar-manager-mock',
    configureServer(server) {
      // Periodically wiggle the mock state a bit so the SSE stream and log
      // panel visibly do something while developing.
      logTimer = setInterval(() => {
        const slugs = Object.keys(LOG_LINES)
        const slug = slugs[Math.floor(Math.random() * slugs.length)]
        const lines = LOG_LINES[slug]
        const line = `[${new Date().toLocaleTimeString('en-GB')}] ${lines[Math.floor(Math.random() * lines.length)]}`
        broadcastLog(slug, line)
        const app = findApp('flightradar')
        if (app && app.status === 'running') app.lastDraw = { ts: nowMs(), status: 200 }
        broadcastState()
      }, 4000)
      server.httpServer?.once('close', () => clearInterval(logTimer))

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const p = url.pathname

        if (p === '/events') {
          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-cache')
          res.setHeader('connection', 'keep-alive')
          res.flushHeaders?.()
          res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return
        }

        if (p === '/api/_manager/state' && req.method === 'GET') {
          return sendJson(res, 200, state)
        }

        if (p === '/api/_manager/health' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true })
        }

        if (p === '/api/screen' && req.method === 'GET') {
          // Contract: response body is the frame encoded as base64 BMP.
          res.statusCode = 200
          res.setHeader('content-type', 'text/plain')
          res.end(FAKE_BMP_BASE64)
          return
        }

        const appMatch = p.match(/^\/api\/_manager\/apps\/([^/]+)\/(enable|disable|restart|variation)$/)
        if (appMatch && req.method === 'POST') {
          const [, slug, action] = appMatch
          const app = findApp(slug)
          if (!app) return sendJson(res, 404, { error: 'unknown app' })
          if (action === 'enable') {
            app.enabled = true
            app.status = 'starting'
            setTimeout(() => {
              app.status = 'running'
              app.pid = 5000 + Math.floor(Math.random() * 1000)
              broadcastState()
            }, 700)
          } else if (action === 'disable') {
            app.enabled = false
            app.status = 'stopped'
            app.pid = null
            app.blocked = false
          } else if (action === 'restart') {
            app.status = 'starting'
            setTimeout(() => {
              app.status = 'running'
              broadcastState()
            }, 700)
          } else if (action === 'variation') {
            readJsonBody(req).then((body) => {
              if (body.name && app.variations[body.name]) {
                app.variation = body.name
                app.status = 'starting'
                broadcastState()
                setTimeout(() => {
                  app.status = 'running'
                  broadcastState()
                }, 600)
              }
              sendJson(res, 200, { ok: true })
              broadcastState()
            })
            return
          }
          broadcastState()
          return sendJson(res, 200, { ok: true })
        }

        const removeMatch = p.match(/^\/api\/_manager\/apps\/([^/]+)$/)
        if (removeMatch && req.method === 'DELETE') {
          const slug = decodeURIComponent(removeMatch[1])
          if (!findApp(slug)) return sendJson(res, 404, { error: `unknown app: ${slug}` })
          state.apps = state.apps.filter((a) => a.slug !== slug)
          const entry = library.catalog.find((c) => c.slug === slug && c.installed)
          if (entry) {
            entry.installed = false
            entry.updateAvailable = false
            entry.source = null
            delete installedFrom[slug]
          }
          broadcastState()
          return sendJson(res, 200, state)
        }

        const varMatch = p.match(/^\/api\/_manager\/apps\/([^/]+)\/variations\/([^/]+)$/)
        if (varMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
          const [, slug, name] = varMatch
          const app = findApp(slug)
          if (!app) return sendJson(res, 404, { error: 'unknown app' })
          if (req.method === 'PUT') {
            readJsonBody(req).then((body) => {
              app.variations[decodeURIComponent(name)] = {
                args: body.args || {},
                env: body.env || {},
                priority: body.priority ?? null,
              }
              broadcastState()
              sendJson(res, 200, { ok: true })
            })
            return
          } else {
            delete app.variations[decodeURIComponent(name)]
            if (app.variation === decodeURIComponent(name)) app.variation = 'default'
            broadcastState()
            return sendJson(res, 200, { ok: true })
          }
        }

        const logMatch = p.match(/^\/api\/_manager\/apps\/([^/]+)\/log$/)
        if (logMatch && req.method === 'GET') {
          const [, slug] = logMatch
          const lines = (LOG_LINES[slug] || []).map((l) => `[--:--:--] ${l}`)
          return sendJson(res, 200, { lines })
        }

        if (p === '/api/_manager/settings' && req.method === 'PUT') {
          readJsonBody(req).then((body) => {
            if (body.barMode === 'local' || body.barMode === 'cloud') state.barMode = body.barMode
            if (body.barHost) state.barHost = body.barHost
            if (body.appsDirs) state.appsDirs = body.appsDirs
            // Bar token: `""` clears it, any other string sets it. Never
            // echoed back — state only carries `tokenSet`.
            if (typeof body.token === 'string') state.tokenSet = body.token !== ''
            // Cloud account token (barMode 'cloud'), same rule — only
            // `cloudTokenSet` is echoed back.
            if (typeof body.cloudToken === 'string') state.cloudTokenSet = body.cloudToken !== ''
            // Optional GitHub token (v3-aanvullingen): `""` clears it, any
            // other string sets it. Never echoed back — only `tokenSet`.
            if (typeof body.libraryToken === 'string') {
              library.token = body.libraryToken === '' ? null : body.libraryToken
            }
            broadcastState()
            sendJson(res, 200, { ok: true })
          })
          return
        }

        // Battery indicator data source (v3-aanvullingen): proxied 1:1 from
        // the real bar/emulator in production via the generic bar-proxy; the
        // dev mock fakes a plausible reading here instead.
        if (p === '/api/status' && req.method === 'GET') {
          return sendJson(res, 200, { power: { state: 'discharging', battery_charge: 63 } })
        }

        // Remote control (Controller tab): proxied 1:1 to the bar in
        // production; here it just validates the key against the firmware's
        // enum (openapi.yaml POST /api/input) and acknowledges it.
        if (p === '/api/input' && req.method === 'POST') {
          const key = url.searchParams.get('key')
          if (!INPUT_KEYS.includes(key)) return sendJson(res, 400, { error: `invalid key: ${key}` })
          return sendJson(res, 200, { result: 'OK' })
        }

        /* --------------------------- app library v2 (mock) ------------------------- */

        if (p === '/api/_manager/library' && req.method === 'GET') {
          if (url.searchParams.get('refresh') === '1') return runLibraryCheck(res)
          return sendJson(res, 200, libraryPayload())
        }

        if (p === '/api/_manager/library/check' && req.method === 'POST') {
          return runLibraryCheck(res)
        }

        if (p === '/api/_manager/library/install' && req.method === 'POST') {
          readJsonBody(req).then((body) => {
            const slug = body.slug
            const matches = library.catalog.filter((c) => c.slug === slug)
            if (!matches.length) return sendJson(res, 404, { error: `unknown app in library catalog: ${slug}` })

            let entry
            if (matches.length > 1) {
              if (!body.repo) {
                return sendJson(res, 400, {
                  error: `slug '${slug}' exists in multiple repos (${matches.map((m) => m.repo).join(', ')}); specify "repo"`,
                })
              }
              entry = matches.find((c) => c.repo === body.repo)
              if (!entry) return sendJson(res, 404, { error: `slug '${slug}' not found in repo '${body.repo}'` })
            } else {
              entry = matches[0]
              if (body.repo && body.repo !== entry.repo) {
                return sendJson(res, 404, { error: `slug '${slug}' not found in repo '${body.repo}'` })
              }
            }

            if (entry.source === 'local') return sendJson(res, 409, { error: 'app already exists locally (appsDirs)' })
            if (installedFrom[slug] && installedFrom[slug] !== entry.repo) {
              return sendJson(res, 409, {
                error: `'${slug}' is already installed from ${installedFrom[slug]}; remove it first before installing from ${entry.repo}`,
              })
            }

            for (const c of matches) c.installed = c.repo === entry.repo
            entry.updateAvailable = false
            entry.source = 'library'
            installedFrom[slug] = entry.repo
            if (!findApp(entry.slug)) {
              state.apps.push(
                makeApp({
                  slug: entry.slug,
                  name: entry.name,
                  description: entry.description,
                  tags: entry.tags,
                  enabled: false,
                  status: 'stopped',
                  source: 'library',
                  updateAvailable: false,
                })
              )
            } else {
              findApp(entry.slug).source = 'library'
              findApp(entry.slug).updateAvailable = false
            }
            broadcastState()
            sendJson(res, 200, { ok: true })
          })
          return
        }

        if (p === '/api/_manager/library/update' && req.method === 'POST') {
          readJsonBody(req).then((body) => {
            const repo = installedFrom[body.slug]
            const entry = library.catalog.find((c) => c.slug === body.slug && c.repo === repo && c.installed)
            if (!entry) return sendJson(res, 404, { error: 'not installed' })
            entry.updateAvailable = false
            const app = findApp(body.slug)
            if (app) {
              app.updateAvailable = false
              if (app.status === 'running') {
                app.status = 'starting'
                broadcastState()
                setTimeout(() => {
                  app.status = 'running'
                  broadcastState()
                }, 700)
              }
            }
            broadcastState()
            sendJson(res, 200, { ok: true })
          })
          return
        }

        if (p === '/api/_manager/library/uninstall' && req.method === 'POST') {
          readJsonBody(req).then((body) => {
            const repo = installedFrom[body.slug]
            const entry = library.catalog.find((c) => c.slug === body.slug && c.repo === repo && c.installed)
            if (!entry) return sendJson(res, 404, { error: `app '${body.slug}' is not a library-installed app` })
            entry.installed = false
            entry.updateAvailable = false
            entry.source = null
            delete installedFrom[body.slug]
            state.apps = state.apps.filter((a) => a.slug !== entry.slug)
            broadcastState()
            sendJson(res, 200, { ok: true })
          })
          return
        }

        // Cleanup (docs/CONTRACT.md "Cleanup"). The report is derived from the
        // mock state, so removing an app here really does empty the panel.
        if (p === '/api/_manager/cleanup' && req.method === 'GET') {
          return sendJson(res, 200, buildMockCleanup())
        }

        if (p === '/api/_manager/cleanup' && req.method === 'POST') {
          readJsonBody(req).then((body) => {
            const slugs = Array.isArray(body.slugs) ? body.slugs : null
            if (!slugs) return sendJson(res, 400, { error: 'slugs array required' })
            const report = buildMockCleanup()
            const removable = new Set(report.removable)
            const removed = []
            const migrated = []
            const skipped = []
            for (const slug of slugs) {
              if (!removable.has(slug)) {
                skipped.push({ slug, reason: 'not stale' })
                continue
              }
              const group = report.duplicates.find((g) => g.migrate && g.migrate.from === slug)
              if (group && body.migrateVariations !== false) {
                const donor = findApp(slug)
                const keeper = findApp(group.migrate.to)
                if (donor && keeper) {
                  keeper.variations = JSON.parse(JSON.stringify(donor.variations))
                  keeper.variation = donor.variation
                  migrated.push({ from: slug, to: keeper.slug, variations: Object.keys(keeper.variations) })
                }
              }
              state.apps = state.apps.filter((a) => a.slug !== slug)
              removed.push({ slug, dirRemoved: true, configRemoved: true })
            }
            broadcastState()
            sendJson(res, 200, { removed, migrated, skipped, errors: [], state })
          })
          return
        }

        if (p === '/api/_manager/library/repos' && req.method === 'POST') {
          readJsonBody(req).then((body) => {
            if (!isValidRepoFormat(body.repo)) return sendJson(res, 400, { error: "repo must look like 'owner/name'" })
            if (library.repos.some((r) => r.repo === body.repo)) {
              return sendJson(res, 409, { error: `repo '${body.repo}' is already linked` })
            }
            const branch = (typeof body.branch === 'string' && body.branch) || 'main'
            // The dev mock has no real GitHub data for an arbitrary user-typed
            // repo — link it with an empty catalog after a simulated check, so
            // the flow (loading -> appears in "Linked repos") is still exercisable.
            library.repos.push({ repo: body.repo, branch, lastCheck: null, error: null })
            broadcastState()
            sendJson(res, 200, libraryPayload())
            setTimeout(() => {
              const r = library.repos.find((x) => x.repo === body.repo)
              if (r) r.lastCheck = nowMs()
              broadcastState()
            }, 600)
          })
          return
        }

        if (p === '/api/_manager/library/repos' && req.method === 'DELETE') {
          readJsonBody(req).then((body) => {
            const idx = library.repos.findIndex((r) => r.repo === body.repo)
            if (idx === -1) return sendJson(res, 404, { error: `repo '${body.repo}' is not linked` })
            library.repos.splice(idx, 1)
            library.catalog = library.catalog.filter((c) => c.repo !== body.repo)
            // Unlink-only: installed apps from this repo keep running, they
            // just lose their catalog entry + update badge.
            for (const [slug, r] of Object.entries(installedFrom)) {
              if (r !== body.repo) continue
              const app = findApp(slug)
              if (app) app.updateAvailable = false
            }
            broadcastState()
            sendJson(res, 200, libraryPayload())
          })
          return
        }

        // Zip upload (v3-aanvullingen): raw bytes, ?slug optional. The mock
        // doesn't actually unpack the zip (no real filesystem apps dir to
        // extract into) — it just derives a slug and fabricates an app entry
        // with source: "upload", so the UI flow (progress -> success/error)
        // is exercisable without a real backend.
        if (p === '/api/_manager/library/upload' && req.method === 'POST') {
          readRawBody(req).then((buf) => {
            if (!buf.length) return sendJson(res, 400, { error: 'empty request body' })
            if (buf.length > 5 * 1024 * 1024) return sendJson(res, 413, { error: 'zip exceeds 5MB limit' })
            // Real zips start with a "PK" local-file-header signature — cheap
            // way to exercise the error path in the mock without needing a
            // special filename trick (just upload any non-zip file).
            if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
              return sendJson(res, 400, { error: 'not a valid zip archive — expected app.py at the root or in a single top-level folder' })
            }

            const qSlug = url.searchParams.get('slug')
            const qFilename = url.searchParams.get('filename')
            let slug = qSlug
            if (!slug && qFilename) {
              slug = qFilename.replace(/\.zip$/i, '').trim()
            }
            if (!slug) slug = 'uploaded-app'
            slug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'uploaded-app'

            if (findApp(slug)) {
              return sendJson(res, 409, { error: `an app with slug '${slug}' already exists` })
            }

            state.apps.push(
              makeApp({
                slug,
                name: slug,
                description: 'Uploaded app.',
                tags: [],
                enabled: false,
                status: 'stopped',
                source: 'upload',
                updateAvailable: false,
              })
            )
            broadcastState()
            sendJson(res, 200, { slug })
          })
          return
        }

        next()
      })
    },
  }
}
