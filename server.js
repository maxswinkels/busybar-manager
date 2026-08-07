"use strict";
/*
 * busybar-manager: supervisor + reverse proxy for the BUSY Bar community apps.
 *
 * Single-file, zero-dependency Node >=22 server. Style mirrors Max's own
 * busybar-emulator/server.js: compact helpers, section banners, no
 * classes-for-everything. See docs/CONTRACT.md for the binding API/behavior
 * spec this file implements.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");

const PKG = require("./package.json");
const PYTHON = process.env.BUSYBAR_PYTHON || "python3";
const ROOT = __dirname;
const WEB_DIST = path.join(ROOT, "web", "dist");
const CONFIG_PATH = process.env.BUSYBAR_MANAGER_CONFIG || path.join(ROOT, "config.json");
// Fixed location for library-installed apps — not a config option (CONTRACT-LIBRARY.md).
const APPS_INSTALL_DIR = path.join(ROOT, "apps");
function libraryApiBase() {
  return process.env.BUSYBAR_LIBRARY_API_BASE || "https://api.github.com";
}
function libraryRawBase() {
  return process.env.BUSYBAR_LIBRARY_RAW_BASE || "https://raw.githubusercontent.com";
}
// Cloud transport (config.barMode === "cloud"): the bar is reached through
// BUSY's hosted API instead of over the LAN. Same paths, different root —
// `/api/<path>` becomes `<base>/<path>` — and a different credential
// (config.cloudToken, an account token, NOT the Wi-Fi bar token).
function cloudApiBase() {
  return process.env.BUSYBAR_CLOUD_API_BASE || "https://api.busy.app/busybar";
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/* --------------------------------- config -------------------------------- */

function isValidRepoFormat(s) {
  return typeof s === "string" && /^[\w.-]+\/[\w.-]+$/.test(s);
}

// v2 (CONTRACT-LIBRARY.md "Config v2"): library.repos is an array, so the
// catalog can merge multiple linked repos. Migrates an old single-repo block
// (top-level `repo`/`branch` on `library`) into `repos: [{repo, branch}]`.
// An explicitly-empty `repos: []` (e.g. persisted after unlinking the last
// repo) is respected as-is — only a *missing* `repos` key triggers migration
// or the fresh-install default.
function normalizeLibrary(rawLib) {
  const lib = rawLib && typeof rawLib === "object" ? rawLib : {};
  let repos;
  if (Array.isArray(lib.repos)) {
    repos = lib.repos;
  } else if (typeof lib.repo === "string" && lib.repo) {
    repos = [{ repo: lib.repo, branch: typeof lib.branch === "string" && lib.branch ? lib.branch : "main" }];
  } else {
    repos = [{ repo: "maxswinkels/busybar-apps", branch: "main" }];
  }
  const seen = new Set();
  repos = repos
    .filter((r) => r && isValidRepoFormat(r.repo))
    .map((r) => ({ repo: r.repo, branch: typeof r.branch === "string" && r.branch ? r.branch : "main" }))
    .filter((r) => {
      if (seen.has(r.repo)) return false;
      seen.add(r.repo);
      return true;
    });
  const checkIntervalHours = typeof lib.checkIntervalHours === "number" && lib.checkIntervalHours > 0 ? lib.checkIntervalHours : 6;
  const token = typeof lib.token === "string" && lib.token ? lib.token : null;
  return { checkIntervalHours, repos, token };
}

function defaultConfig() {
  return {
    listenPort: 8321, barMode: "local", barHost: "10.0.4.20", token: null,
    cloudToken: null, appsDirs: [], apps: {}, library: normalizeLibrary(undefined),
  };
}

function defaultVariation() {
  return { args: {}, env: {}, priority: null };
}

function defaultAppConfig() {
  return { enabled: false, variation: "default", variations: { default: defaultVariation() } };
}

// Normalize whatever was loaded from disk into a well-shaped config object,
// tolerating a hand-edited or partial config.json. Existing appsDirs values
// are never migrated/rewritten — only missing pieces (incl. the `library`
// block, for configs written before this feature existed) get filled in.
function normalizeConfig(raw) {
  const cfg = Object.assign(defaultConfig(), raw && typeof raw === "object" ? raw : {});
  if (typeof cfg.listenPort !== "number") cfg.listenPort = 8321;
  if (cfg.barMode !== "cloud") cfg.barMode = "local";
  if (typeof cfg.barHost !== "string" || !cfg.barHost) cfg.barHost = "10.0.4.20";
  cfg.token = typeof cfg.token === "string" && cfg.token ? cfg.token : null;
  cfg.cloudToken = typeof cfg.cloudToken === "string" && cfg.cloudToken ? cfg.cloudToken : null;
  if (!Array.isArray(cfg.appsDirs)) cfg.appsDirs = [];
  if (!cfg.apps || typeof cfg.apps !== "object") cfg.apps = {};
  cfg.library = normalizeLibrary(raw && raw.library);
  for (const slug of Object.keys(cfg.apps)) {
    const a = cfg.apps[slug] || {};
    if (typeof a.enabled !== "boolean") a.enabled = false;
    if (!a.variations || typeof a.variations !== "object" || !Object.keys(a.variations).length) {
      a.variations = { default: defaultVariation() };
    }
    for (const name of Object.keys(a.variations)) {
      const v = a.variations[name] || {};
      a.variations[name] = {
        args: v.args && typeof v.args === "object" ? v.args : {},
        env: v.env && typeof v.env === "object" ? v.env : {},
        priority: typeof v.priority === "number" ? v.priority : null,
      };
    }
    if (typeof a.variation !== "string" || !a.variations[a.variation]) {
      a.variation = a.variations.default ? "default" : Object.keys(a.variations)[0];
    }
    cfg.apps[slug] = a;
  }
  return cfg;
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (_) {
    // No config yet (fresh install) — start from defaults.
    return defaultConfig();
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (e) {
    // The file exists but is corrupt/unparseable. Do NOT silently reset to
    // defaults — persist() overwrites config.json at boot, which would destroy
    // the user's saved app config. Preserve it in a timestamped backup first.
    const backup = CONFIG_PATH + ".corrupt-" + Date.now();
    try {
      fs.copyFileSync(CONFIG_PATH, backup);
      log(`config.json is corrupt (${e.message}); backed up to ${path.basename(backup)}, starting from defaults`);
    } catch (e2) {
      log(`config.json is corrupt (${e.message}) and backup failed (${e2.message}); starting from defaults`);
    }
    return defaultConfig();
  }
}

let config = loadConfig();

// Atomic write: tmp file + rename, per contract.
function persist() {
  try {
    const tmp = CONFIG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    log("config save failed:", e.message);
  }
}

// Materialize any migration (e.g. old single-repo `library` block -> v2
// `library.repos`) on disk right away, so a hand-edited/old config.json
// converges to the current shape from the very first boot.
persist();

// Read-only view of an app's config: does NOT persist a default entry, per
// contract ("apps without a config entry get runtime defaults ... and are
// only persisted once Max changes something").
function getAppConfigView(slug) {
  return config.apps[slug] || defaultAppConfig();
}

// Mutating accessor: creates+stores a default entry if missing. Caller is
// expected to persist() after mutating the returned object.
function ensureAppConfig(slug) {
  if (!config.apps[slug]) config.apps[slug] = defaultAppConfig();
  return config.apps[slug];
}

function getListenPort() {
  return process.env.PORT ? Number(process.env.PORT) : config.listenPort;
}

/* ------------------------------ tiny YAML -------------------------------- */
// Hand-rolled subset: `key: value` scalars and `key:` followed by `- item`
// lists. Enough for the manifest.yaml files busybar-apps ships (name/author/
// description/tags/preview). No external yaml dependency.
function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function parseYamlSubset(text) {
  const out = {};
  let curKey = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const listMatch = raw.match(/^\s*-\s+(.*)$/);
    if (listMatch && curKey) {
      if (!Array.isArray(out[curKey])) out[curKey] = [];
      out[curKey].push(stripQuotes(listMatch[1].trim()));
      continue;
    }
    const kvMatch = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].trim();
      curKey = key;
      out[key] = val === "" ? null : stripQuotes(val);
    }
  }
  return out;
}

/* -------------------------------- scanner --------------------------------- */
// Port of busybar-emulator's scanApps/argparseParams: discover apps under
// appsDirs (a folder with app.py [+ manifest.yaml], or a flat *.py file),
// and auto-discover their argparse options by parsing `--help` output.

const ARG_SKIP = new Set(["-h", "--help", "--host", "--token", "--test"]);
const optionsCache = {}; // scriptPath -> { mtime, options }

function discoverOptions(scriptPath) {
  let mtime;
  try {
    mtime = fs.statSync(scriptPath).mtimeMs;
  } catch (_) {
    return [];
  }
  const hit = optionsCache[scriptPath];
  if (hit && hit.mtime === mtime) return hit.options;
  let options = [];
  try {
    if (fs.readFileSync(scriptPath, "utf8").includes("argparse")) {
      const r = spawnSync(PYTHON, [scriptPath, "--help"], { timeout: 3000, encoding: "utf8" });
      if (r.status === 0 && r.stdout) options = parseHelpOptions(r.stdout);
    }
  } catch (_) {}
  optionsCache[scriptPath] = { mtime, options };
  return options;
}

function parseHelpOptions(help) {
  const options = [];
  // "  --theme {a,b,c}  help text" / "  --lat LAT  help text" / "  --test  help"
  const re = /^[ ]{2}(--[\w-]+)(?:[ =](\{[^}]*\}|[A-Z][\w-]*))?(?:[ \t]{2,}(\S.*))?$/gm;
  let m;
  while ((m = re.exec(help)) !== null) {
    const [, flag, meta, rest] = m;
    if (ARG_SKIP.has(flag)) continue;
    let hint = rest || "";
    if (!hint) {
      const after = help.slice(m.index + m[0].length);
      const cont = after.match(/^\n\s{10,}(\S.*)/);
      if (cont) hint = cont[1];
    }
    const def = (hint.match(/\(default:\s*([^)]+)\)/) || [])[1] || null;
    if (meta && meta.startsWith("{")) {
      const choices = meta.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      options.push({ flag, type: "choice", default: def, choices, help: hint });
    } else if (!meta) {
      options.push({ flag, type: "bool", default: def, choices: null, help: hint });
    } else {
      options.push({ flag, type: "str", default: def, choices: null, help: hint });
    }
  }
  return options;
}

function describeFromDocstring(scriptPath, fallback) {
  try {
    const head = fs.readFileSync(scriptPath, "utf8").slice(0, 2048);
    const m = head.match(/"""[\s\n]*([^\n"]+)/);
    if (m) return m[1].trim();
  } catch (_) {}
  return fallback;
}

// Lite entries (no argparse discovery — cheap, safe to call often for
// supervisor/proxy bookkeeping). Options are attached separately for state.
function makeLiteEntry(slug, dir, scriptPath, source) {
  const manifestPath = path.join(dir, "manifest.yaml");
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseYamlSubset(fs.readFileSync(manifestPath, "utf8"));
    } catch (_) {}
  }
  const name = (manifest && manifest.name) || slug;
  const description = (manifest && manifest.description) || describeFromDocstring(scriptPath, slug);
  const tags = manifest && Array.isArray(manifest.tags) ? manifest.tags : [];
  return {
    slug,
    name,
    description,
    tags,
    dir,
    scriptPath,
    hasRequirements: fs.existsSync(path.join(dir, "requirements.txt")),
    source, // "local" (appsDirs) | "library" (installed from a repo) | "upload" (zip-installed) | null
  };
}

// appsDirs entries — "local" apps. Dedupe by slug within appsDirs itself
// (first dir wins), independent of the library dir.
function doScanLocal(appsDirs) {
  const out = [];
  const seen = new Set();
  for (const dir of appsDirs || []) {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const d of ents) {
      if (d.name.startsWith(".") || d.name.startsWith("_")) continue;
      if (d.isDirectory()) {
        const full = path.join(dir, d.name);
        const scriptPath = path.join(full, "app.py");
        if (!fs.existsSync(scriptPath)) continue;
        const slug = d.name;
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push(makeLiteEntry(slug, full, scriptPath, "local"));
      } else if (d.isFile() && d.name.endsWith(".py")) {
        const slug = d.name.slice(0, -3);
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push(makeLiteEntry(slug, dir, path.join(dir, d.name), "local"));
      }
    }
  }
  return out;
}

// <projectroot>/apps/<slug> — library-installed apps. Always scanned, per
// CONTRACT-LIBRARY.md. A folder carrying the .busybar-library.json stamp is
// tagged "library"; anything else found there (e.g. manually dropped in) is
// still listed so it's runnable, just without a library/local badge.
function doScanLibrary() {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(APPS_INSTALL_DIR, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const d of ents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith(".") || d.name.startsWith("_")) continue;
    const full = path.join(APPS_INSTALL_DIR, d.name);
    const scriptPath = path.join(full, "app.py");
    if (!fs.existsSync(scriptPath)) continue;
    let source = null;
    try {
      const stamp = JSON.parse(fs.readFileSync(path.join(full, ".busybar-library.json"), "utf8"));
      source = stamp && stamp.source === "upload" ? "upload" : "library";
    } catch (_) {}
    out.push(makeLiteEntry(d.name, full, scriptPath, source));
  }
  return out;
}

// Local appsDirs apps win on a slug collision with a library install.
function doScan(appsDirs) {
  const out = [];
  const seen = new Set();
  for (const e of doScanLocal(appsDirs)) {
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    out.push(e);
  }
  for (const e of doScanLibrary()) {
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    out.push(e);
  }
  return out;
}

let scanCache = { ts: 0, entries: [], dirsKey: "" };
function invalidateScanCache() {
  scanCache = { ts: 0, entries: [], dirsKey: "" };
}
function scanAppsLite() {
  const dirsKey = JSON.stringify(config.appsDirs);
  const now = Date.now();
  if (now - scanCache.ts < 1000 && scanCache.dirsKey === dirsKey) return scanCache.entries;
  const entries = doScan(config.appsDirs);
  scanCache = { ts: now, entries, dirsKey };
  return entries;
}
function scanAppsFull() {
  return scanAppsLite().map((e) => Object.assign({}, e, { options: discoverOptions(e.scriptPath) }));
}
function findEntry(slug) {
  return scanAppsLite().find((e) => e.slug === slug) || null;
}
function isLocalSlug(slug) {
  return doScanLocal(config.appsDirs).some((e) => e.slug === slug);
}

/* ------------------------------- supervisor ------------------------------- */

const runtime = {}; // slug -> { status, pid, child, backoffMs, restartTimer, stableTimer, stopping, logs, applicationNames, lastDraw, blocked }
function getRuntime(slug) {
  if (!runtime[slug]) {
    runtime[slug] = {
      status: "stopped",
      pid: null,
      child: null,
      backoffMs: 1000,
      restartTimer: null,
      stableTimer: null,
      stopping: false,
      starting: false,
      logs: [],
      applicationNames: new Set(),
      lastDraw: null,
      blocked: false,
    };
  }
  return runtime[slug];
}

function pushLog(slug, stream, line) {
  const rt = getRuntime(slug);
  if (line.length > 500) line = line.slice(0, 500) + "…";
  const entry = `[${stream}] ${line}`;
  rt.logs.push(entry);
  if (rt.logs.length > 500) rt.logs.shift();
  emitSSE("log", { slug, line: entry });
}

function wireStreams(child, slug) {
  const bufs = { out: "", err: "" };
  function lineBuffer(stream, key) {
    child[stream].on("data", (chunk) => {
      bufs[key] += chunk.toString("utf8");
      let nl;
      while ((nl = bufs[key].indexOf("\n")) !== -1) {
        pushLog(slug, key, bufs[key].slice(0, nl));
        bufs[key] = bufs[key].slice(nl + 1);
      }
    });
  }
  lineBuffer("stdout", "out");
  lineBuffer("stderr", "err");
}

function runChild(cmd, args, slug) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    wireStreams(child, slug);
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

// Per-app venv with a sha256 stamp of requirements.txt, same approach as
// busybar-emulator/server.js.
async function ensureVenv(entry, slug) {
  const venvDir = path.join(entry.dir, ".venv");
  const pyBinPath = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python3");
  const reqFile = path.join(entry.dir, "requirements.txt");
  const stampFile = path.join(venvDir, ".req-sha256");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(reqFile)).digest("hex");

  let needSetup = true;
  if (fs.existsSync(pyBinPath)) {
    try {
      needSetup = fs.readFileSync(stampFile, "utf8").trim() !== sha;
    } catch (_) {}
  }
  if (needSetup) {
    if (!fs.existsSync(pyBinPath)) {
      pushLog(slug, "out", "[venv] creating .venv ...");
      await runChild(PYTHON, ["-m", "venv", venvDir], slug);
    }
    pushLog(slug, "out", "[venv] pip install -r requirements.txt ...");
    await runChild(pyBinPath, ["-m", "pip", "install", "-r", reqFile], slug);
    fs.writeFileSync(stampFile, sha);
    pushLog(slug, "out", "[venv] ready");
  }
  return pyBinPath;
}

// Convert a variation's {flag: value} args object into an argv array.
// --host is always supplied by the supervisor, so any variation-supplied
// --host is dropped (per contract).
function buildArgv(argsObj) {
  const out = [];
  for (const [flag, value] of Object.entries(argsObj || {})) {
    if (flag === "--host") continue;
    if (value === true) out.push(flag);
    else if (value === false || value === null || value === undefined) continue;
    else {
      out.push(flag);
      out.push(String(value));
    }
  }
  return out;
}

function clearRestartTimers(rt) {
  if (rt.restartTimer) {
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }
  if (rt.stableTimer) {
    clearTimeout(rt.stableTimer);
    rt.stableTimer = null;
  }
}

async function startApp(slug) {
  const entry = findEntry(slug);
  if (!entry) return false;
  const rt = getRuntime(slug);
  if (rt.child || rt.starting) return true;
  rt.starting = true;
  rt.status = "starting";
  rt.stopping = false;
  scheduleStateBroadcast();

  let pyBin = PYTHON;
  if (entry.hasRequirements) {
    try {
      pyBin = await ensureVenv(entry, slug);
    } catch (e) {
      pushLog(slug, "err", `[venv] setup failed: ${e.message}`);
      rt.starting = false;
      rt.status = "crashed";
      scheduleRestart(slug);
      scheduleStateBroadcast();
      return false;
    }
  }

  const appCfg = getAppConfigView(slug);
  const variation = appCfg.variations[appCfg.variation] || appCfg.variations.default || defaultVariation();
  const argv = [entry.scriptPath, "--host", `127.0.0.1:${getListenPort()}`, ...buildArgv(variation.args)];
  const env = Object.assign({}, process.env, variation.env || {}, { PYTHONUNBUFFERED: "1" });

  let child;
  try {
    child = spawn(pyBin, argv, { cwd: entry.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    rt.starting = false;
    rt.status = "crashed";
    pushLog(slug, "err", `[spawn error] ${e.message}`);
    scheduleRestart(slug);
    scheduleStateBroadcast();
    return false;
  }

  rt.child = child;
  rt.pid = child.pid || null;
  rt.starting = false;
  rt.status = "running";
  scheduleStateBroadcast();
  wireStreams(child, slug);

  clearTimeout(rt.stableTimer);
  rt.stableTimer = setTimeout(() => {
    rt.backoffMs = 1000;
  }, 5 * 60 * 1000);

  child.on("error", (err) => {
    pushLog(slug, "err", `[spawn error] ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    rt.child = null;
    rt.pid = null;
    clearTimeout(rt.stableTimer);
    rt.stableTimer = null;
    if (rt.stopping) {
      rt.status = "stopped";
      rt.stopping = false;
      scheduleStateBroadcast();
      return;
    }
    rt.status = "crashed";
    pushLog(slug, "out", `[process exited: code=${code} signal=${signal}]`);
    scheduleStateBroadcast();
    scheduleRestart(slug);
  });

  return true;
}

function scheduleRestart(slug) {
  if (!getAppConfigView(slug).enabled) return;
  const rt = getRuntime(slug);
  clearTimeout(rt.restartTimer);
  const delay = rt.backoffMs;
  rt.restartTimer = setTimeout(() => {
    rt.restartTimer = null;
    if (!getAppConfigView(slug).enabled) return;
    startApp(slug);
  }, delay);
  rt.backoffMs = Math.min(rt.backoffMs * 2, 60000);
}

function stopApp(slug) {
  return new Promise((resolve) => {
    const rt = getRuntime(slug);
    clearRestartTimers(rt);
    if (!rt.child) {
      if (rt.status !== "stopped") {
        rt.status = "stopped";
        scheduleStateBroadcast();
      }
      resolve(false);
      return;
    }
    rt.stopping = true;
    const child = rt.child;
    let done = false;
    let killTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      resolve(true);
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, 3000);
  });
}

async function restartApp(slug) {
  await stopApp(slug);
  return startApp(slug);
}

/* ---------------------------- draw attribution ---------------------------- */

function rememberAppName(slug, appName) {
  getRuntime(slug).applicationNames.add(appName);
}

// Best-effort application_name -> slug attribution (see CONTRACT.md): exact
// slug match first, then previously-learned names, then "only one managed
// app is active" heuristic. Returns null if it can't be resolved.
function attributeSlug(appName) {
  const entries = scanAppsLite();
  for (const e of entries) {
    if (e.slug === appName) {
      rememberAppName(e.slug, appName);
      return e.slug;
    }
  }
  for (const slug of Object.keys(runtime)) {
    if (runtime[slug].applicationNames.has(appName)) return slug;
  }
  const active = entries.filter((e) => {
    const rt = runtime[e.slug];
    return rt && (rt.status === "running" || rt.status === "starting");
  });
  if (active.length === 1) {
    rememberAppName(active[0].slug, appName);
    return active[0].slug;
  }
  return null;
}

let lastSuccessfulDraw = null; // { applicationName, slug, since, ts }
function currentScreenOwner() {
  if (!lastSuccessfulDraw) return null;
  if (Date.now() - lastSuccessfulDraw.ts > 10000) return null;
  return { applicationName: lastSuccessfulDraw.applicationName, slug: lastSuccessfulDraw.slug, since: lastSuccessfulDraw.since };
}

/* --------------------------------- proxy ---------------------------------- */

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

function parseHostPort(raw) {
  const s = String(raw || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
  const i = s.lastIndexOf(":");
  if (i > -1 && /^\d+$/.test(s.slice(i + 1))) return { hostname: s.slice(0, i), port: Number(s.slice(i + 1)) };
  return { hostname: s, port: 80 };
}

function cloudMode() {
  return config.barMode === "cloud";
}

// Resolve a manager-side bar path into the concrete upstream request. In
// `local` mode that is the LAN bar verbatim over http; in `cloud` mode the
// leading `/api` is swapped for the cloud base path (`/busybar`) and the
// request goes out over https to api.busy.app.
function barUpstream(urlPath) {
  if (cloudMode()) {
    const base = new URL(cloudApiBase());
    const rest = urlPath.startsWith("/api/") ? urlPath.slice("/api".length) : urlPath;
    const port = base.port ? Number(base.port) : base.protocol === "http:" ? 80 : 443;
    return {
      transport: base.protocol === "http:" ? http : https,
      hostname: base.hostname,
      port,
      path: base.pathname.replace(/\/+$/, "") + rest,
      origin: base.origin,
    };
  }
  const t = parseHostPort(config.barHost);
  return { transport: http, hostname: t.hostname, port: t.port, path: urlPath, origin: `http://${t.hostname}:${t.port}` };
}

function barTargetLabel() {
  return cloudMode() ? cloudApiBase() : barUpstream("/").origin;
}

function dropHeader(headers, lowerName) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lowerName) delete headers[k];
  }
}

// Optional bar credential. In `local` mode that's config.token, riding along
// on every bar-bound request as the `X-API-Token` header (the only form the
// bar honours). In `cloud` mode it's config.cloudToken — a different secret —
// sent as `Authorization: Bearer <token>`. The configured value always wins
// over anything the caller sent.
function withBarAuth(headers) {
  // Case-insensitive: inbound req.headers keys are always lowercased by node,
  // while the ones set below are not — deleting only one casing would leave a
  // caller-sent credential in place and send *two* auth headers upstream.
  dropHeader(headers, "authorization");
  dropHeader(headers, "x-api-token");
  if (cloudMode()) {
    if (config.cloudToken) headers["Authorization"] = `Bearer ${config.cloudToken}`;
    return headers;
  }
  if (config.token) headers["X-API-Token"] = config.token;
  return headers;
}

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/*
 * Cloudflare protection against api.busy.app
 *
 * Script-like User-Agent headers (e.g. Python-urllib/3.14) are rejected with
 * error 1010.
 * Thus remove all unnecessary headers and set a proper User-Agent for the manager.
 */
const MANAGER_UA = `busybar-manager/${PKG.version} (+https://github.com/maxswinkels/busybar-manager)`;
const CLOUD_KEEP_HEADERS = new Set([
  "content-type", "content-length", "accept", "accept-encoding", "accept-language",
  // ws handshake — dropping these turns the upgrade into a plain GET
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions",
]);
function scrubForCloud(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (CLOUD_KEEP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out["User-Agent"] = MANAGER_UA;
  return out;
}

// The one place bar-bound headers are built: hop-by-hop stripped, scrubbed for
// the cloud when that's the transport, then the configured credential applied.
function barHeaders(reqHeaders) {
  const filtered = filterHeaders(reqHeaders);
  return withBarAuth(cloudMode() ? scrubForCloud(filtered) : filtered);
}

function forwardToBar(method, urlPath, reqHeaders, body) {
  return new Promise((resolve) => {
    const up = barUpstream(urlPath);
    const headers = barHeaders(reqHeaders);
    if (body && body.length) headers["content-length"] = String(body.length);
    else delete headers["content-length"];
    const options = { hostname: up.hostname, port: up.port, path: up.path, method, headers, timeout: 10000 };
    const proxyReq = up.transport.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", () => {
        resolve({ status: proxyRes.statusCode, headers: filterHeaders(proxyRes.headers), respBody: Buffer.concat(chunks) });
      });
      proxyRes.on("error", () => resolve({ status: 502, headers: { "content-type": "application/json" }, respBody: Buffer.from(JSON.stringify({ error: "bar response error" })) }));
    });
    proxyReq.on("error", (err) => resolve({ status: 502, headers: { "content-type": "application/json" }, respBody: Buffer.from(JSON.stringify({ error: `bar unreachable: ${err.message}` })) }));
    proxyReq.on("timeout", () => proxyReq.destroy(new Error("timeout")));
    if (body && body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

function sendDisplayClear(appName) {
  return new Promise((resolve) => {
    const up = barUpstream(`/api/display/draw?application_name=${encodeURIComponent(appName)}`);
    const headers = barHeaders({});
    const options = { hostname: up.hostname, port: up.port, path: up.path, method: "DELETE", headers, timeout: 5000 };
    const r = up.transport.request(options, (resp) => {
      resp.resume();
      resp.on("end", () => resolve(resp.statusCode));
    });
    r.on("error", () => resolve(null));
    r.on("timeout", () => r.destroy());
    r.end();
  });
}

async function handleDraw(req, res, body) {
  let payload = null;
  try {
    payload = JSON.parse(body.length ? body.toString("utf8") : "{}");
  } catch (_) {
    payload = null;
  }
  let appName = null;
  let slug = null;
  if (payload && typeof payload === "object") {
    appName = payload.application_name || payload.app_id || null;
    if (appName) {
      slug = attributeSlug(appName);
      if (slug) {
        const appCfg = getAppConfigView(slug);
        const variation = appCfg.variations[appCfg.variation];
        if (variation && variation.priority != null) payload.priority = variation.priority;
      }
    }
  }
  const outBody = payload !== null ? Buffer.from(JSON.stringify(payload)) : body;
  const { status, headers, respBody } = await forwardToBar(req.method, req.url, req.headers, outBody);

  if (appName) {
    const rt = slug ? getRuntime(slug) : null;
    if (rt) {
      rt.lastDraw = { ts: Date.now(), status };
      rt.blocked = status === 409;
    }
    if (status === 200 || status === 201) {
      const now = Date.now();
      if (!lastSuccessfulDraw || lastSuccessfulDraw.applicationName !== appName) {
        lastSuccessfulDraw = { applicationName: appName, slug, since: now, ts: now };
      } else {
        lastSuccessfulDraw.ts = now;
        lastSuccessfulDraw.slug = slug;
      }
    }
    scheduleStateBroadcast();
  }

  res.writeHead(status, headers);
  res.end(respBody);
}

async function handleProxy(req, res, p, method) {
  try {
    const body = await readBody(req);
    if (p === "/api/display/draw" && method === "POST") return handleDraw(req, res, body);
    const { status, headers, respBody } = await forwardToBar(method, req.url, req.headers, body);
    res.writeHead(status, headers);
    res.end(respBody);
  } catch (err) {
    sendJSON(res, 502, { error: err.message || "proxy error" });
  }
}

// Streaming bar passthrough, for the frontend mirror (docs/CONTRACT.md,
// "Bar-passthrough /api/_bar/*"): GET-only, query preserved, piped straight
// through with no buffering and no request timeout so a long-lived SSE
// stream (the emulator's GET /events) can flow indefinitely. Ends downstream
// when upstream ends and vice versa; aborts the upstream request if the
// client disconnects first.
function handleBarPassthrough(req, res, p) {
  if (req.method !== "GET") {
    return sendJSON(res, 405, { error: "only GET is supported for /api/_bar/*" });
  }
  const up = barUpstream(req.url.slice("/api/_bar".length) || "/");
  const headers = barHeaders(req.headers);
  delete headers["content-length"];

  // No `timeout` option: the socket must stay open indefinitely for SSE.
  const proxyReq = up.transport.request({ hostname: up.hostname, port: up.port, path: up.path, method: "GET", headers }, (proxyRes) => {
    if (res.writableEnded) {
      proxyRes.resume();
      return;
    }
    res.writeHead(proxyRes.statusCode, filterHeaders(proxyRes.headers));
    proxyRes.pipe(res);
    proxyRes.on("error", () => {
      try {
        res.end();
      } catch (_) {}
    });
  });
  proxyReq.on("error", (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: `bar unreachable: ${err.message}` });
    else {
      try {
        res.end();
      } catch (_) {}
    }
  });
  const abortUpstream = () => {
    try {
      proxyReq.destroy();
    } catch (_) {}
  };
  req.on("close", abortUpstream);
  res.on("close", abortUpstream);
  proxyReq.end();
}

// WebSocket passthrough for /api/* upgrades — in practice the firmware status
// stream `/api/status/ws` that feeds the frontend mirror. It has to go through
// the manager (rather than the browser dialling the bar directly) because the
// bar credential never leaves the server, and on a ws upgrade the firmware only
// accepts it as the `X-API-Token` *query parameter* — a browser WebSocket can't
// set the X-API-Token header. Raw tunnel: forward the handshake, then pipe the
// two sockets, so no ws framing/dependency is needed here.
function handleUpgrade(req, socket, head) {
  socket.on("error", () => {});
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch (_) {
    return socket.destroy();
  }
  // Manager's own API has no ws endpoints; everything else under /api/ is the bar.
  if (!u.pathname.startsWith("/api/") || u.pathname.startsWith("/api/_manager/")) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  // Local mode only: the firmware accepts the credential on a ws upgrade as a
  // query parameter. The cloud API takes the Authorization header instead
  // (withBarAuth below) — this hop is server-to-server, so the header is fine.
  if (!cloudMode() && config.token) u.searchParams.set("X-API-Token", config.token);
  const up = barUpstream(u.pathname + u.search);
  // filterHeaders() drops the hop-by-hop handshake headers; the ws-specific
  // ones (sec-websocket-key/version/protocol/extensions) survive and must.
  const headers = barHeaders(req.headers);
  delete headers["content-length"];
  headers.host = up.port === 80 || up.port === 443 ? up.hostname : `${up.hostname}:${up.port}`;
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade || "websocket";
  if (cloudMode()) headers.origin = `https://${up.hostname}`;

  // No `timeout`: the tunnel stays open for as long as the stream lasts.
  const proxyReq = up.transport.request({
    hostname: up.hostname,
    port: up.port,
    path: up.path,
    method: req.method,
    headers,
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on("error", () => socket.destroy());
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || "Switching Protocols"}`];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    // Bytes the client already sent after its handshake belong on the wire
    // upstream, ahead of anything piped later.
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    socket.on("close", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
  });
  // The bar refused the upgrade (e.g. 401 on a wrong/missing token): pass the
  // status line on so the browser's ws just fails and the mirror falls back.
  proxyReq.on("response", (proxyRes) => {
    proxyRes.resume();
    socket.end(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ""}\r\n\r\n`);
  });
  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
}

/* ---------------------------- bar reachability ----------------------------- */

let barReachable = false;
async function checkBarReachable() {
  try {
    const up = barUpstream("/api/version");
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    let ok = false;
    try {
      const resp = await fetch(`${up.origin}${up.path}`, {
        signal: controller.signal,
        headers: barHeaders({}),
      });
      ok = resp.ok;
    } finally {
      clearTimeout(t);
    }
    if (ok !== barReachable) scheduleStateBroadcast();
    barReachable = ok;
  } catch (_) {
    if (barReachable) scheduleStateBroadcast();
    barReachable = false;
  }
}

/* -------------------------------- app library ------------------------------ */
// Install/update apps straight from linked community repos instead of a
// locally maintained copy. See docs/CONTRACT-LIBRARY.md ("Config v2") for
// the binding multi-repo spec.

// Per-repo check state, keyed by "owner/name". Never touched for a repo that
// isn't (or is no longer) in config.library.repos.
//   { branch, lastCheck: ts|null, error: string|null, commitSha: string|null,
//     catalog: [{ slug, name, description, tags, previewUrl, files, repo }] }
const libraryRepoStates = {};
let libraryChecking = false;
let libraryCheckInFlight = null;
const manifestCache = {}; // blobSha -> parsed manifest.yaml

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// Per-URL ETag cache for the two api.github.com calls (branches, trees) — a
// 304 (served from cache) doesn't count against GitHub's rate limit. Kept
// in-memory only (per process); good enough per CONTRACT-LIBRARY.md.
const githubEtagCache = {}; // url -> { etag, body }

async function githubJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 10000);
  try {
    const headers = { "User-Agent": "busybar-manager" };
    const cached = githubEtagCache[url];
    if (cached && cached.etag) headers["If-None-Match"] = cached.etag;
    if (config.library.token) headers["Authorization"] = `Bearer ${config.library.token}`;
    const resp = await fetch(url, { signal: controller.signal, headers });
    if (resp.status === 304 && cached) return cached.body;
    if (!resp.ok) {
      let detail = "";
      try {
        detail = await resp.text();
      } catch (_) {}
      const err = new Error(`GitHub ${resp.status} ${resp.statusText} for ${url}${detail ? `: ${detail}` : ""}`);
      err.status = resp.status;
      throw err;
    }
    const body = await resp.json();
    const etag = resp.headers.get("etag");
    if (etag) githubEtagCache[url] = { etag, body };
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function githubRawFetch(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 10000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "busybar-manager" } });
    if (!resp.ok) throw new Error(`raw fetch ${resp.status} for ${url}`);
    return resp;
  } finally {
    clearTimeout(t);
  }
}

// Two API calls total per repo: branch -> commit sha, then the recursive
// tree at that commit. Only paths under apps/<slug>/ (one level deep —
// runtime files sit flat in the app folder) are relevant. preview.* and
// dotfiles are tracked separately (for previewUrl) and excluded from the
// installable file set.
async function performRepoCheck(repo, branch) {
  const branchInfo = await githubJson(`${libraryApiBase()}/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  const commitSha = branchInfo && branchInfo.commit && branchInfo.commit.sha;
  if (!commitSha) throw new Error("branch response missing commit sha");
  const treeInfo = await githubJson(`${libraryApiBase()}/repos/${repo}/git/trees/${commitSha}?recursive=1`);
  const tree = Array.isArray(treeInfo.tree) ? treeInfo.tree : [];

  const bySlug = {}; // slug -> { files: {rel: sha}, previewFile: string|null }
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const m = item.path.match(/^apps\/([^/]+)\/([^/]+)$/); // flat files directly under apps/<slug>/
    if (!m) continue;
    const [, slug, file] = m;
    if (!bySlug[slug]) bySlug[slug] = { files: {}, previewFile: null };
    if (file.startsWith(".") || file.startsWith("__pycache__")) continue;
    if (/^preview\./i.test(file)) {
      bySlug[slug].previewFile = file;
      continue;
    }
    bySlug[slug].files[file] = item.sha;
  }

  const catalog = [];
  for (const slug of Object.keys(bySlug)) {
    const { files, previewFile } = bySlug[slug];
    if (!files["app.py"]) continue; // not a real app
    let name = slug, description = slug, tags = [];
    const manifestSha = files["manifest.yaml"];
    if (manifestSha) {
      const cacheKey = `${repo}#${manifestSha}`;
      let manifest = manifestCache[cacheKey];
      if (!manifest) {
        try {
          const resp = await githubRawFetch(`${libraryRawBase()}/${repo}/${commitSha}/apps/${slug}/manifest.yaml`);
          manifest = parseYamlSubset(await resp.text());
          manifestCache[cacheKey] = manifest;
        } catch (_) {
          manifest = null;
        }
      }
      if (manifest) {
        name = manifest.name || slug;
        description = manifest.description || slug;
        tags = Array.isArray(manifest.tags) ? manifest.tags : [];
      }
    }
    const previewUrl = previewFile ? `${libraryRawBase()}/${repo}/${commitSha}/apps/${slug}/${previewFile}` : null;
    catalog.push({ slug, name, description, tags, previewUrl, files, repo });
  }
  return { commitSha, catalog };
}

// Checks every linked repo in parallel. Conservative on failure, per repo: a
// broken/unreachable repo never blocks or empties another repo's catalog —
// it just records that repo's `error` and keeps its last known good catalog
// (lastCheck only advances on success, so it always reflects "last successful
// check" for that repo).
function checkLibrary() {
  if (libraryCheckInFlight) return libraryCheckInFlight;
  libraryChecking = true;
  scheduleStateBroadcast();
  const repos = config.library.repos.slice();
  libraryCheckInFlight = Promise.all(
    repos.map(({ repo, branch }) =>
      performRepoCheck(repo, branch)
        .then(({ commitSha, catalog }) => {
          libraryRepoStates[repo] = { branch, lastCheck: Date.now(), error: null, commitSha, catalog };
        })
        .catch((e) => {
          const prev = libraryRepoStates[repo];
          const rawMessage = e.message || String(e);
          const isRateLimit = e.status === 403 && /rate limit/i.test(rawMessage);
          libraryRepoStates[repo] = {
            branch,
            lastCheck: prev ? prev.lastCheck : null,
            error: isRateLimit ? "GitHub rate limit — add a token in Library settings or retry later" : rawMessage,
            commitSha: prev ? prev.commitSha : null,
            catalog: prev ? prev.catalog : [],
          };
        })
    )
  ).finally(() => {
    libraryChecking = false;
    libraryCheckInFlight = null;
    scheduleStateBroadcast();
  });
  return libraryCheckInFlight;
}

// Merged catalog across every currently-linked repo (an unlinked repo's
// stale state, if any lingers, is never consulted since we only iterate
// config.library.repos).
function aggregatedCatalog() {
  const out = [];
  for (const { repo } of config.library.repos) {
    const st = libraryRepoStates[repo];
    if (st && Array.isArray(st.catalog)) out.push(...st.catalog);
  }
  return out;
}

function readLibraryStamp(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(APPS_INSTALL_DIR, slug, ".busybar-library.json"), "utf8"));
  } catch (_) {
    return null;
  }
}

function isInstalledFromRepo(slug, repo) {
  const stamp = readLibraryStamp(slug);
  return !!(stamp && stamp.repo === repo);
}

// updateAvailable(slug): computed against the app's OWN stamped repo (not
// "any repo with that slug"). A tracked file has a different blob sha, or a
// tracked file was added/removed, vs. the stamp recorded at install/update
// time. False when there's no stamp, the stamped repo is no longer linked,
// or that repo's catalog doesn't (or no longer) has this slug.
function computeUpdateAvailable(slug) {
  const stamp = readLibraryStamp(slug);
  if (!stamp) return false;
  const repoEntry = config.library.repos.find((r) => r.repo === stamp.repo);
  if (!repoEntry) return false; // stamped repo unlinked: no update info available
  const st = libraryRepoStates[stamp.repo];
  const catEntry = st && st.catalog.find((c) => c.slug === slug);
  if (!catEntry) return false;
  const stampFiles = stamp.files || {};
  const remoteFiles = catEntry.files || {};
  const keysA = Object.keys(stampFiles);
  const keysB = Object.keys(remoteFiles);
  if (keysA.length !== keysB.length) return true;
  for (const k of keysA) {
    if (remoteFiles[k] === undefined || remoteFiles[k] !== stampFiles[k]) return true;
  }
  return false;
}

function libraryUpdatesAvailableCount() {
  let n = 0;
  for (const e of scanAppsLite()) {
    if (e.source === "library" && computeUpdateAvailable(e.slug)) n++;
  }
  return n;
}

// Newest successful check across all linked repos (lastCheck only advances
// on success, see checkLibrary), and the first repo (in config order) that
// currently has an error — keeps the existing single-badge UI working.
function libraryOverallLastCheck() {
  let latest = null;
  for (const { repo } of config.library.repos) {
    const st = libraryRepoStates[repo];
    if (st && st.lastCheck && (!latest || st.lastCheck > latest)) latest = st.lastCheck;
  }
  return latest;
}
function libraryFirstError() {
  for (const { repo } of config.library.repos) {
    const st = libraryRepoStates[repo];
    if (st && st.error) return st.error;
  }
  return null;
}

async function downloadLibraryFile(repo, commitSha, slug, file) {
  const resp = await githubRawFetch(`${libraryRawBase()}/${repo}/${commitSha}/apps/${slug}/${file}`, 15000);
  return Buffer.from(await resp.arrayBuffer());
}

// Atomic install/update: download into apps/.staging-<slug>-<ts>/, then swap
// it over the target dir (old dir parked at apps/.trash-<ts>/ first, removed
// after the rename succeeds) so a half-finished download never leaves a
// broken or missing app directory behind. Preserves the per-app .venv across
// an update when requirements.txt's blob sha didn't change.
async function deployLibraryApp(slug, catEntry, commitSha, repo, branch) {
  const ts = Date.now();
  const targetDir = path.join(APPS_INSTALL_DIR, slug);
  const stagingDir = path.join(APPS_INSTALL_DIR, `.staging-${slug}-${ts}`);
  const oldStamp = readLibraryStamp(slug);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const file of Object.keys(catEntry.files)) {
      const buf = await downloadLibraryFile(repo, commitSha, slug, file);
      fs.writeFileSync(path.join(stagingDir, file), buf);
    }
    const stamp = {
      repo, branch, commit: commitSha,
      files: Object.assign({}, catEntry.files),
      installedAt: oldStamp && oldStamp.installedAt ? oldStamp.installedAt : ts,
      updatedAt: ts,
    };
    fs.writeFileSync(path.join(stagingDir, ".busybar-library.json"), JSON.stringify(stamp, null, 2));

    const oldReqSha = oldStamp && oldStamp.files ? oldStamp.files["requirements.txt"] : null;
    const newReqSha = catEntry.files["requirements.txt"] || null;
    const oldVenvDir = path.join(targetDir, ".venv");
    if (oldReqSha && oldReqSha === newReqSha && fs.existsSync(oldVenvDir)) {
      fs.renameSync(oldVenvDir, path.join(stagingDir, ".venv"));
    }

    if (fs.existsSync(targetDir)) {
      const trashDir = path.join(APPS_INSTALL_DIR, `.trash-${ts}`);
      fs.renameSync(targetDir, trashDir);
      fs.renameSync(stagingDir, targetDir);
      fs.rmSync(trashDir, { recursive: true, force: true });
    } else {
      fs.renameSync(stagingDir, targetDir);
    }
  } catch (e) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (_) {}
    throw e;
  } finally {
    invalidateScanCache();
  }
  return targetDir;
}

/* ------------------------------- zip upload -------------------------------- */
// Zero-dep zip reader for "install my own app without a repo"
// (CONTRACT-LIBRARY.md v3-aanvullingen). Parses just enough of the zip format
// (End Of Central Directory -> central directory entries -> local file
// headers) to support compression methods 0 (stored) and 8 (deflate).

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

function findZipEOCD(buf) {
  const minLen = 22;
  if (buf.length < minLen) throw new Error("not a zip file (too small)");
  const maxCommentLen = 65535;
  const searchFloor = Math.max(0, buf.length - minLen - maxCommentLen);
  for (let i = buf.length - minLen; i >= searchFloor; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  throw new Error("not a zip file (no end-of-central-directory record)");
}

function readZipEntryData(buf, entry) {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== ZIP_LFH_SIG) {
    throw new Error(`corrupt zip local file header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method ${entry.compressionMethod} for ${entry.name}`);
}

function parseZipCentralDirectory(buf) {
  const eocdOffset = findZipEOCD(buf);
  const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < cdEntryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== ZIP_CDH_SIG) {
      throw new Error("corrupt zip central directory");
    }
    const compressionMethod = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttrs = buf.readUInt32LE(off + 38);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const nameStart = off + 46;
    const name = buf.toString("utf8", nameStart, nameStart + nameLen);
    entries.push({ name, compressionMethod, compressedSize, externalAttrs, localHeaderOffset });
    off = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Rejects `..` segments, absolute paths (unix or windows-drive), and
// backslash-separated paths trying to escape via a mix of separators.
function isSafeZipEntryName(name) {
  if (!name || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) return false;
  const parts = name.split(/[\\/]/);
  return !parts.some((p) => p === "..");
}

function isSymlinkZipEntry(entry) {
  const unixMode = entry.externalAttrs >>> 16;
  return (unixMode & 0xf000) === 0xa000;
}

// Returns [{ relPath, data }] for every regular file in the zip (directory
// marker entries skipped). Throws on unsafe paths / symlinks / corrupt data.
function extractZipFiles(buf) {
  const entries = parseZipCentralDirectory(buf);
  const files = [];
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith("/")) continue; // directory marker
    if (!isSafeZipEntryName(entry.name)) throw new Error(`unsafe path in zip entry: ${entry.name}`);
    if (isSymlinkZipEntry(entry)) throw new Error(`symlink entries are not allowed in zip: ${entry.name}`);
    const data = readZipEntryData(buf, entry);
    files.push({ relPath: entry.name.replace(/\\/g, "/"), data });
  }
  return files;
}

// Shape per contract: either app.py sits at the zip root, or the whole zip
// is wrapped in exactly one top-level folder that contains app.py.
function resolveZipShape(files) {
  if (files.some((f) => f.relPath === "app.py")) return { topFolder: null, files };
  const rootLevelFiles = files.filter((f) => !f.relPath.includes("/"));
  const topFolders = new Set(files.filter((f) => f.relPath.includes("/")).map((f) => f.relPath.slice(0, f.relPath.indexOf("/"))));
  if (rootLevelFiles.length === 0 && topFolders.size === 1) {
    const topFolder = Array.from(topFolders)[0];
    const stripped = files.map((f) => ({ relPath: f.relPath.slice(topFolder.length + 1), data: f.data }));
    if (stripped.some((f) => f.relPath === "app.py")) return { topFolder, files: stripped };
  }
  throw new Error("zip must contain app.py at the root, or exactly one top-level folder containing app.py");
}

function sanitizeSlug(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// Runtime files + manifest.yaml are installed; dotfiles/__pycache__/.venv
// (accidentally zipped-up local cruft) are skipped, mirroring library installs.
function isInstallableZipEntry(relPath) {
  return !relPath.split("/").some((part) => part.startsWith(".") || part === "__pycache__");
}

function parseContentDispositionFilename(header) {
  if (!header) return null;
  const m = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : null;
}

// Atomic install, same staging + rename pattern as deployLibraryApp, but for
// a slug with no repo/commit provenance — stamp records source: "upload".
async function deployUploadedApp(slug, files) {
  const ts = Date.now();
  const targetDir = path.join(APPS_INSTALL_DIR, slug);
  const stagingDir = path.join(APPS_INSTALL_DIR, `.staging-${slug}-${ts}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    const stampFiles = {};
    for (const f of files) {
      const dest = path.join(stagingDir, f.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
      stampFiles[f.relPath] = crypto.createHash("sha256").update(f.data).digest("hex");
    }
    const stamp = { source: "upload", files: stampFiles, installedAt: ts };
    fs.writeFileSync(path.join(stagingDir, ".busybar-library.json"), JSON.stringify(stamp, null, 2));

    if (fs.existsSync(targetDir)) {
      const trashDir = path.join(APPS_INSTALL_DIR, `.trash-${ts}`);
      fs.renameSync(targetDir, trashDir);
      fs.renameSync(stagingDir, targetDir);
      fs.rmSync(trashDir, { recursive: true, force: true });
    } else {
      fs.renameSync(stagingDir, targetDir);
    }
  } catch (e) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (_) {}
    throw e;
  } finally {
    invalidateScanCache();
  }
  return targetDir;
}

function readZipBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(Object.assign(new Error("zip payload too large (max 5MB)"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleLibraryUpload(req, res, u) {
  let buf;
  try {
    buf = await readZipBody(req);
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: e.message });
  }
  if (!buf.length) return sendJSON(res, 400, { error: "empty upload" });

  let files;
  try {
    files = extractZipFiles(buf);
  } catch (e) {
    return sendJSON(res, 400, { error: `invalid zip: ${e.message}` });
  }

  let shape;
  try {
    shape = resolveZipShape(files);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }

  const installable = shape.files.filter((f) => isInstallableZipEntry(f.relPath));
  if (!installable.some((f) => f.relPath === "app.py")) {
    return sendJSON(res, 400, { error: "zip must contain app.py at the root, or exactly one top-level folder containing app.py" });
  }

  let slug = sanitizeSlug(u.searchParams.get("slug"));
  if (!slug && shape.topFolder) slug = sanitizeSlug(shape.topFolder);
  if (!slug) {
    const filenameHint = u.searchParams.get("filename") || parseContentDispositionFilename(req.headers["content-disposition"]);
    if (filenameHint) slug = sanitizeSlug(path.basename(filenameHint, path.extname(filenameHint)));
  }
  if (!slug) slug = "uploaded-app";

  if (isLocalSlug(slug) || fs.existsSync(path.join(APPS_INSTALL_DIR, slug))) {
    return sendJSON(res, 409, { error: `slug '${slug}' already exists` });
  }

  try {
    await deployUploadedApp(slug, installable);
  } catch (e) {
    return sendJSON(res, 500, { error: `upload install failed: ${e.message}` });
  }
  ensureAppConfig(slug);
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, { slug });
}

function publicLibraryPayload() {
  const localSlugs = new Set(scanAppsLite().filter((e) => e.source === "local").map((e) => e.slug));
  const catalog = aggregatedCatalog().map((c) => {
    const isLocal = localSlugs.has(c.slug);
    const installed = !isLocal && isInstalledFromRepo(c.slug, c.repo);
    return {
      slug: c.slug, name: c.name, description: c.description, tags: c.tags,
      installed, updateAvailable: installed ? computeUpdateAvailable(c.slug) : false,
      previewUrl: c.previewUrl, repo: c.repo,
      source: isLocal ? "local" : installed ? "library" : null,
    };
  });
  const repos = config.library.repos.map(({ repo, branch }) => {
    const st = libraryRepoStates[repo];
    return { repo, branch, lastCheck: st ? st.lastCheck : null, error: st ? st.error : null };
  });
  return {
    checkIntervalHours: config.library.checkIntervalHours,
    repos,
    checking: libraryChecking,
    catalog,
    tokenSet: !!config.library.token,
  };
}

/* -------------------------------- manager state ---------------------------- */

function buildState() {
  const entries = scanAppsFull();
  const seenSlugs = new Set();
  const apps = [];
  for (const e of entries) {
    seenSlugs.add(e.slug);
    const appCfg = getAppConfigView(e.slug);
    const rt = getRuntime(e.slug);
    apps.push({
      slug: e.slug, name: e.name, description: e.description, tags: e.tags, dir: e.dir,
      options: e.options, enabled: appCfg.enabled, status: rt.status, pid: rt.pid,
      blocked: rt.blocked, lastDraw: rt.lastDraw, variation: appCfg.variation,
      variations: appCfg.variations, missing: false,
      source: e.source || null, updateAvailable: e.source === "library" ? computeUpdateAvailable(e.slug) : false,
    });
  }
  for (const slug of Object.keys(config.apps)) {
    if (seenSlugs.has(slug)) continue;
    const appCfg = getAppConfigView(slug);
    const rt = getRuntime(slug);
    apps.push({
      slug, name: slug, description: "", tags: [], dir: null, options: [],
      enabled: appCfg.enabled, status: rt.status, pid: rt.pid, blocked: rt.blocked,
      lastDraw: rt.lastDraw, variation: appCfg.variation, variations: appCfg.variations,
      missing: true, source: null, updateAvailable: false,
    });
  }
  return {
    barMode: config.barMode,
    barHost: config.barHost,
    tokenSet: !!config.token,
    cloudTokenSet: !!config.cloudToken,
    listenPort: getListenPort(),
    barReachable,
    screenOwner: currentScreenOwner(),
    apps,
    library: { lastCheck: libraryOverallLastCheck(), updatesAvailable: libraryUpdatesAvailableCount(), error: libraryFirstError() },
  };
}

/* ---------------------------------- SSE ------------------------------------ */

const sseClients = new Set();
let stateBroadcastTimer = null;
function scheduleStateBroadcast() {
  if (stateBroadcastTimer) return;
  stateBroadcastTimer = setTimeout(() => {
    stateBroadcastTimer = null;
    if (!sseClients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(buildState())}\n\n`;
    for (const r of sseClients) {
      try {
        r.write(data);
      } catch (_) {}
    }
  }, 250); // throttled to ~4/s per contract
}
function emitSSE(event, payload) {
  if (!sseClients.size) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const r of sseClients) {
    try {
      r.write(data);
    } catch (_) {}
  }
}
function handleSSE(req, res) {
  res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }, CORS));
  res.write("retry: 2000\n\n");
  res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

/* ------------------------------- manager API ------------------------------- */

async function apiEnable(slug, res) {
  const entry = findEntry(slug);
  if (!entry) return sendJSON(res, 404, { error: `unknown app: ${slug}` });
  const appCfg = ensureAppConfig(slug);
  appCfg.enabled = true;
  persist();
  await startApp(slug);
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiDisable(slug, res) {
  if (!findEntry(slug) && !config.apps[slug]) return sendJSON(res, 404, { error: `unknown app: ${slug}` });
  const appCfg = ensureAppConfig(slug);
  appCfg.enabled = false;
  persist();
  const rt = getRuntime(slug);
  const names = rt.applicationNames.size ? Array.from(rt.applicationNames) : [slug];
  await stopApp(slug);
  for (const n of names) await sendDisplayClear(n);
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiRestart(slug, res) {
  const entry = findEntry(slug);
  if (!entry) return sendJSON(res, 404, { error: `unknown app: ${slug}` });
  await restartApp(slug);
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiSelectVariation(slug, body, res) {
  if (!findEntry(slug) && !config.apps[slug]) return sendJSON(res, 404, { error: `unknown app: ${slug}` });
  const name = body && body.name;
  if (!name || typeof name !== "string") return sendJSON(res, 400, { error: "name required" });
  const appCfg = ensureAppConfig(slug);
  if (!appCfg.variations[name]) return sendJSON(res, 404, { error: `unknown variation: ${name}` });
  appCfg.variation = name;
  persist();
  const rt = getRuntime(slug);
  const wasActive = rt.status === "running" || rt.status === "starting";
  if (wasActive) await restartApp(slug);
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

function apiPutVariation(slug, name, body, res) {
  if (!name) return sendJSON(res, 400, { error: "variation name required" });
  const args = body && typeof body.args === "object" && body.args !== null ? body.args : {};
  const env = body && typeof body.env === "object" && body.env !== null ? body.env : {};
  let priority = null;
  if (body && body.priority !== undefined && body.priority !== null) {
    priority = Number(body.priority);
    if (!Number.isFinite(priority) || priority < 1 || priority > 100) {
      return sendJSON(res, 400, { error: "priority must be a number 1-100" });
    }
  }
  const appCfg = ensureAppConfig(slug);
  appCfg.variations[name] = { args, env, priority };
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiDeleteVariation(slug, name, res) {
  const appCfg = ensureAppConfig(slug);
  if (!appCfg.variations[name]) return sendJSON(res, 404, { error: `unknown variation: ${name}` });
  if (Object.keys(appCfg.variations).length === 1) return sendJSON(res, 400, { error: "cannot delete the last remaining variation" });
  const wasSelected = appCfg.variation === name;
  delete appCfg.variations[name];
  if (wasSelected) {
    appCfg.variation = appCfg.variations.default ? "default" : Object.keys(appCfg.variations)[0];
    const rt = getRuntime(slug);
    if (rt.status === "running" || rt.status === "starting") await restartApp(slug);
  }
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

function apiLog(slug, res) {
  const rt = getRuntime(slug);
  sendJSON(res, 200, { lines: rt.logs.slice(-500) });
}

function apiSettings(body, res) {
  let changed = false;
  // Transport for every bar-bound request: "local" (LAN, barHost + token) or
  // "cloud" (api.busy.app, cloudToken). Both credentials stay stored, so
  // toggling back and forth doesn't lose either one.
  if (body.barMode !== undefined) {
    if (body.barMode !== "local" && body.barMode !== "cloud") {
      return sendJSON(res, 400, { error: 'barMode must be "local" or "cloud"' });
    }
    config.barMode = body.barMode;
    changed = true;
  }
  if (body.barHost !== undefined) {
    if (typeof body.barHost !== "string" || !body.barHost) return sendJSON(res, 400, { error: "barHost must be a non-empty string" });
    config.barHost = body.barHost;
    changed = true;
  }
  // Bar token: `""` clears it, any other string sets it. Never echoed back —
  // state only carries `tokenSet` (docs/CONTRACT.md, "Proxy").
  if (body.token !== undefined) {
    if (typeof body.token !== "string") return sendJSON(res, 400, { error: "token must be a string" });
    config.token = body.token ? body.token : null;
    changed = true;
  }
  // Cloud account token — same "" clears / omit keeps rule, never echoed back.
  if (body.cloudToken !== undefined) {
    if (typeof body.cloudToken !== "string") return sendJSON(res, 400, { error: "cloudToken must be a string" });
    config.cloudToken = body.cloudToken ? body.cloudToken : null;
    changed = true;
  }
  if (body.appsDirs !== undefined) {
    if (!Array.isArray(body.appsDirs) || !body.appsDirs.every((d) => typeof d === "string")) {
      return sendJSON(res, 400, { error: "appsDirs must be an array of strings" });
    }
    config.appsDirs = body.appsDirs;
    changed = true;
  }
  if (body.libraryToken !== undefined) {
    if (typeof body.libraryToken !== "string") return sendJSON(res, 400, { error: "libraryToken must be a string" });
    config.library.token = body.libraryToken ? body.libraryToken : null;
    changed = true;
  }
  if (changed) {
    persist();
    checkBarReachable();
    scheduleStateBroadcast();
  }
  sendJSON(res, 200, buildState());
}

async function apiLibraryGet(searchParams, res) {
  if (searchParams.get("refresh") === "1") {
    try {
      await withTimeout(checkLibrary(), 10000);
    } catch (_) {
      // timed out waiting; the check itself keeps running in the background
      // and will update `library` (and push an SSE state event) when it lands.
    }
  }
  sendJSON(res, 200, publicLibraryPayload());
}

async function apiLibraryCheck(res) {
  await checkLibrary();
  sendJSON(res, 200, publicLibraryPayload());
}

async function apiLibraryInstall(body, res) {
  const slug = body && body.slug;
  if (!slug || typeof slug !== "string") return sendJSON(res, 400, { error: "slug required" });
  if (isLocalSlug(slug)) return sendJSON(res, 409, { error: `slug '${slug}' already exists as a local app (appsDirs)` });

  if (!config.library.repos.some((r) => libraryRepoStates[r.repo])) await checkLibrary();
  const matches = aggregatedCatalog().filter((c) => c.slug === slug);
  if (!matches.length) return sendJSON(res, 404, { error: `unknown app in library catalog: ${slug}` });

  const requestedRepo = body && body.repo;
  let catEntry;
  if (matches.length > 1) {
    if (!requestedRepo || typeof requestedRepo !== "string") {
      return sendJSON(res, 400, {
        error: `slug '${slug}' exists in multiple repos (${matches.map((m) => m.repo).join(", ")}); specify "repo"`,
      });
    }
    catEntry = matches.find((c) => c.repo === requestedRepo);
    if (!catEntry) return sendJSON(res, 404, { error: `slug '${slug}' not found in repo '${requestedRepo}'` });
  } else {
    catEntry = matches[0];
    if (requestedRepo && requestedRepo !== catEntry.repo) {
      return sendJSON(res, 404, { error: `slug '${slug}' not found in repo '${requestedRepo}'` });
    }
  }

  // Already installed from a different repo: refuse rather than silently overwrite.
  const existingStamp = readLibraryStamp(slug);
  if (existingStamp && existingStamp.repo !== catEntry.repo) {
    return sendJSON(res, 409, {
      error: `'${slug}' is already installed from ${existingStamp.repo}; remove it first before installing from ${catEntry.repo}`,
    });
  }

  const st = libraryRepoStates[catEntry.repo];
  if (!st || !st.commitSha) return sendJSON(res, 500, { error: "no known commit to install from; run a library check first" });
  try {
    await deployLibraryApp(slug, catEntry, st.commitSha, catEntry.repo, st.branch);
  } catch (e) {
    return sendJSON(res, 500, { error: `install failed: ${e.message}` });
  }
  // Installing never auto-starts the app — Max enables it himself.
  ensureAppConfig(slug);
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiLibraryUpdate(body, res) {
  const slug = body && body.slug;
  if (!slug || typeof slug !== "string") return sendJSON(res, 400, { error: "slug required" });
  const stamp = readLibraryStamp(slug);
  if (!stamp) return sendJSON(res, 404, { error: `app '${slug}' is not a library-installed app` });
  const repoEntry = config.library.repos.find((r) => r.repo === stamp.repo);
  if (!repoEntry) {
    return sendJSON(res, 409, { error: `'${slug}' was installed from ${stamp.repo}, which is no longer linked; link it again to update` });
  }
  if (!libraryRepoStates[stamp.repo]) await checkLibrary();
  const st = libraryRepoStates[stamp.repo];
  const catEntry = st && st.catalog.find((c) => c.slug === slug);
  if (!catEntry) return sendJSON(res, 404, { error: `'${slug}' is no longer in ${stamp.repo}'s catalog` });
  if (!st.commitSha) return sendJSON(res, 500, { error: "no known commit to update from; run a library check first" });

  const rt = getRuntime(slug);
  const wasActive = rt.status === "running" || rt.status === "starting";
  try {
    await deployLibraryApp(slug, catEntry, st.commitSha, stamp.repo, repoEntry.branch);
  } catch (e) {
    return sendJSON(res, 500, { error: `update failed: ${e.message}` });
  }
  // Config/variations are left untouched; only restart what was already running.
  if (wasActive) await restartApp(slug);
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function apiLibraryAddRepo(body, res) {
  const repo = body && body.repo;
  if (!isValidRepoFormat(repo)) return sendJSON(res, 400, { error: "repo must look like 'owner/name'" });
  const branch = (body && typeof body.branch === "string" && body.branch) || "main";
  if (config.library.repos.some((r) => r.repo === repo)) return sendJSON(res, 409, { error: `repo '${repo}' is already linked` });
  config.library.repos.push({ repo, branch });
  persist();
  scheduleStateBroadcast();
  await checkLibrary();
  sendJSON(res, 200, publicLibraryPayload());
}

async function apiLibraryRemoveRepo(body, res) {
  const repo = body && body.repo;
  if (!repo || typeof repo !== "string") return sendJSON(res, 400, { error: "repo required" });
  const idx = config.library.repos.findIndex((r) => r.repo === repo);
  if (idx === -1) return sendJSON(res, 404, { error: `repo '${repo}' is not linked` });
  // Unlink only: installed apps from this repo keep running; they just lose
  // their catalog entry + update-detection (see computeUpdateAvailable).
  config.library.repos.splice(idx, 1);
  delete libraryRepoStates[repo];
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, publicLibraryPayload());
}

async function apiLibraryUninstall(body, res) {
  const slug = body && body.slug;
  if (!slug || typeof slug !== "string") return sendJSON(res, 400, { error: "slug required" });
  const stamp = readLibraryStamp(slug);
  if (!stamp) return sendJSON(res, 404, { error: `app '${slug}' has no library stamp; cannot uninstall` });
  await stopApp(slug);
  try {
    fs.rmSync(path.join(APPS_INSTALL_DIR, slug), { recursive: true, force: true });
  } catch (e) {
    return sendJSON(res, 500, { error: `uninstall failed: ${e.message}` });
  }
  invalidateScanCache();
  delete config.apps[slug];
  persist();
  scheduleStateBroadcast();
  sendJSON(res, 200, buildState());
}

async function handleManagerApi(req, res, p, method, u) {
  try {
    if (p === "/api/_manager/state" && method === "GET") return sendJSON(res, 200, buildState());
    if (p === "/api/_manager/health" && method === "GET") return sendJSON(res, 200, { ok: true });
    if (p === "/api/_manager/settings" && method === "PUT") {
      const body = await readJsonBody(req);
      return apiSettings(body, res);
    }
    if (p === "/api/_manager/library" && method === "GET") return apiLibraryGet(u.searchParams, res);
    if (p === "/api/_manager/library/check" && method === "POST") return apiLibraryCheck(res);
    if (p === "/api/_manager/library/install" && method === "POST") {
      const body = await readJsonBody(req);
      return apiLibraryInstall(body, res);
    }
    if (p === "/api/_manager/library/update" && method === "POST") {
      const body = await readJsonBody(req);
      return apiLibraryUpdate(body, res);
    }
    if (p === "/api/_manager/library/uninstall" && method === "POST") {
      const body = await readJsonBody(req);
      return apiLibraryUninstall(body, res);
    }
    if (p === "/api/_manager/library/repos" && method === "POST") {
      const body = await readJsonBody(req);
      return apiLibraryAddRepo(body, res);
    }
    if (p === "/api/_manager/library/repos" && method === "DELETE") {
      const body = await readJsonBody(req);
      return apiLibraryRemoveRepo(body, res);
    }
    if (p === "/api/_manager/library/upload" && method === "POST") return handleLibraryUpload(req, res, u);
    let m;
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/enable$/)) && method === "POST") return apiEnable(decodeURIComponent(m[1]), res);
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/disable$/)) && method === "POST") return apiDisable(decodeURIComponent(m[1]), res);
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/restart$/)) && method === "POST") return apiRestart(decodeURIComponent(m[1]), res);
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/variation$/)) && method === "POST") {
      const body = await readJsonBody(req);
      return apiSelectVariation(decodeURIComponent(m[1]), body, res);
    }
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/variations\/([^/]+)$/)) && method === "PUT") {
      const body = await readJsonBody(req);
      return apiPutVariation(decodeURIComponent(m[1]), decodeURIComponent(m[2]), body, res);
    }
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/variations\/([^/]+)$/)) && method === "DELETE") {
      return apiDeleteVariation(decodeURIComponent(m[1]), decodeURIComponent(m[2]), res);
    }
    if ((m = p.match(/^\/api\/_manager\/apps\/([^/]+)\/log$/)) && method === "GET") return apiLog(decodeURIComponent(m[1]), res);
    return sendJSON(res, 404, { error: `no such manager route: ${method} ${p}` });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || "internal error" });
  }
}

/* -------------------------------- helpers ---------------------------------- */

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json" };

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, CORS));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJsonBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString("utf8"));
  } catch (_) {
    return {};
  }
}

function handleStatic(req, res, p) {
  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    res.writeHead(200, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, CORS));
    return res.end(
      "busybar-manager is running, but web/dist was not found.\n" +
      "Build the dashboard (cd web && npm install && npm run build), or use the API directly:\n" +
      "  GET  /health\n  GET  /api/_manager/state\n  GET  /events (SSE)\n"
    );
  }
  const rel = p === "/" ? "index.html" : decodeURIComponent(p.replace(/^\//, ""));
  let filePath = path.join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) filePath = path.join(WEB_DIST, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(WEB_DIST, "index.html"), (err2, data2) => {
        if (err2) return sendJSON(res, 404, { error: "not found" });
        res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, Object.assign({ "Content-Type": MIME[ext] || "application/octet-stream" }, CORS));
    res.end(data);
  });
}

/* -------------------------------- routing ----------------------------------- */

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch (_) {
    return sendJSON(res, 400, { error: "bad request" });
  }
  const p = u.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (p === "/events" && method === "GET") return handleSSE(req, res);
  if (p === "/health" && method === "GET") return sendJSON(res, 200, { ok: true });
  // Takes precedence over both /api/_manager/* and the generic /api/* proxy,
  // and is never treated as a draw route.
  if (p === "/api/_bar" || p.startsWith("/api/_bar/")) return handleBarPassthrough(req, res, p);
  if (p.startsWith("/api/_manager/")) return handleManagerApi(req, res, p, method, u);
  if (p.startsWith("/api/")) return handleProxy(req, res, p, method);
  return handleStatic(req, res, p);
});

server.on("upgrade", handleUpgrade);

/* --------------------------------- lifecycle --------------------------------- */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, stopping apps...`);
  const slugs = Object.keys(runtime);
  await Promise.all(slugs.map((slug) => stopApp(slug)));
  log("apps stopped, exiting.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A crash must not leave orphaned app children behind: cleanup otherwise lives
// only in the signal path, so an uncaught error would reparent every spawned
// Python app. With launchd KeepAlive=true the daemon then restarts and spawns a
// *second* copy of each enabled app, all fighting over the bar. Log loudly and
// run the same child-killing shutdown() before exiting.
process.on("uncaughtException", (err) => {
  log("uncaughtException:", err && err.stack ? err.stack : String(err));
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log("unhandledRejection:", reason && reason.stack ? reason.stack : String(reason));
  shutdown("unhandledRejection");
});

// Left over from a manager crash mid-install/update: an unfinished staging
// dir or a not-yet-cleaned-up trash dir from a previous run. Neither is a
// live app dir, so it's always safe to remove them at boot.
function cleanupStaleLibraryDirs() {
  let ents = [];
  try {
    ents = fs.readdirSync(APPS_INSTALL_DIR, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const d of ents) {
    if (d.isDirectory() && (d.name.startsWith(".staging-") || d.name.startsWith(".trash-"))) {
      try {
        fs.rmSync(path.join(APPS_INSTALL_DIR, d.name), { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

async function main() {
  fs.mkdirSync(APPS_INSTALL_DIR, { recursive: true });
  cleanupStaleLibraryDirs();

  const enabledSlugs = Object.keys(config.apps).filter((slug) => config.apps[slug].enabled);
  await Promise.all(enabledSlugs.map((slug) => startApp(slug)));

  const port = getListenPort();
  // Bind loopback-only by default: the manager controls the bar and runs apps,
  // so it must not be reachable from the LAN. Set bindHost in config.json
  // (e.g. "0.0.0.0") to expose it deliberately.
  const bindHost = typeof config.bindHost === "string" && config.bindHost ? config.bindHost : "127.0.0.1";
  server.listen(port, bindHost, () => {
    log(`busybar-manager listening on ${bindHost}:${port} (bar=${barTargetLabel()}, appsDirs=${JSON.stringify(config.appsDirs)})`);
  });

  checkBarReachable();
  setInterval(checkBarReachable, 10000).unref();

  // Library update check: once ~15s after boot, then every checkIntervalHours.
  setTimeout(() => {
    checkLibrary();
    setInterval(() => checkLibrary(), config.library.checkIntervalHours * 3600 * 1000).unref();
  }, 15000).unref();
}

main();
