"use strict";
/*
 * busybar-manager cleanup e2e tests (docs/CONTRACT.md, "Cleanup").
 *
 * Covers the removal primitive (DELETE /api/_manager/apps/:slug) and the
 * detect-then-confirm cleanup endpoints (GET/POST /api/_manager/cleanup):
 * config-only orphans, stampless folders, appsDirs apps whose folder must
 * survive, path containment, duplicate detection, wholesale variation
 * migration, the "both copies dirty" refusal, the stale-UI guard, and the
 * display clear a removal sends for an app that was actually running.
 *
 * Like the library tests this writes into the *real* <project>/apps/
 * directory (CONTRACT-LIBRARY.md: fixed location, no config option), so it
 * always cleans up after itself, including on failure.
 */
const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");
const APPS_DIR = path.join(ROOT, "apps");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, { timeout = 10000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try {
    body = await r.json();
  } catch (_) {}
  return { status: r.status, body };
}
function postJson(url, obj) {
  return fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
}

let step = 0;
function log(msg) {
  console.log(`  [${++step}] ${msg}`);
}

const procs = [];
function spawnLogged(name, cmd, args, env) {
  const child = spawn(cmd, args, { env: Object.assign({}, process.env, env), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(child);
  return child;
}
function killAll() {
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) {
      try {
        p.kill("SIGKILL");
      } catch (_) {}
    }
  }
}
process.on("exit", killAll);

// Minimal always-drawing app, so a removal has something to stop and clear.
function drawingAppSource(appName) {
  return `#!/usr/bin/env python3
"""Cleanup test app (${appName})."""
import argparse
import json
import time
import urllib.error
import urllib.request

APP = "${appName}"


def main():
    p = argparse.ArgumentParser(description="Cleanup test app")
    p.add_argument("--host", default="10.0.4.20")
    args = p.parse_args()
    host = "http://" + args.host.replace("http://", "").rstrip("/")
    body = {
        "application_name": APP,
        "priority": 40,
        "elements": [{"id": "t", "type": "text", "text": APP, "x": 0, "y": 0, "font": "small", "color": "#FFFFFFFF"}],
    }
    while True:
        req = urllib.request.Request(host + "/api/display/draw", data=json.dumps(body).encode("utf-8"),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                print("drew", r.getcode())
        except urllib.error.HTTPError as e:
            print("drew", e.code)
        except Exception as e:
            print("draw failed", e)
        time.sleep(0.3)


if __name__ == "__main__":
    main()
`;
}

function writeFixtureApp(fixtureDir, repo, slug, files) {
  const dir = path.join(fixtureDir, repo, "apps", slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

const REPO = "acme/cleanup-apps";
// Everything this suite may create under the real <project>/apps/.
const TOUCHED_SLUGS = ["cleanup-weather", "cleanup_weather", "stampless-app", "cleanup-runner", "dupe-dirty", "dupe_dirty"];
function cleanupInstalledDirs() {
  for (const slug of TOUCHED_SLUGS) {
    try {
      fs.rmSync(path.join(APPS_DIR, slug), { recursive: true, force: true });
    } catch (_) {}
  }
  try {
    fs.rmSync(path.join(ROOT, "apps-sentinel.txt"), { force: true });
  } catch (_) {}
}

// Copy an installed app to a second slug, stamp included — exactly what a
// repo-side folder rename produces (identical files under two slugs). The
// manager's scan is cached for a second, so wait until it actually sees it.
async function cloneInstalled(M, fromSlug, toSlug) {
  fs.cpSync(path.join(APPS_DIR, fromSlug), path.join(APPS_DIR, toSlug), { recursive: true });
  await waitFor(
    async () => {
      const st = (await fetchJson(`${M}/api/_manager/state`)).body;
      return st.apps.some((a) => a.slug === toSlug);
    },
    { label: `${toSlug} picked up by the scan` }
  );
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

async function run() {
  const mockBarPort = await freePort();
  const githubPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-cleanup-test-"));
  const fixtureDir = path.join(tmpDir, "github-fixture");
  const localAppsDir = path.join(tmpDir, "local-apps");

  // A local appsDirs app: removing it must drop the config entry but never
  // touch the user's folder.
  fs.mkdirSync(path.join(localAppsDir, "mine"), { recursive: true });
  fs.writeFileSync(path.join(localAppsDir, "mine", "app.py"), drawingAppSource("mine"));

  writeFixtureApp(fixtureDir, REPO, "cleanup-weather", {
    "app.py": drawingAppSource("cleanup-weather"),
    "manifest.yaml": "name: Cleanup Weather\ndescription: Duplicate-detection fixture.\ntags:\n  - test\n",
  });
  writeFixtureApp(fixtureDir, REPO, "dupe-dirty", {
    "app.py": drawingAppSource("dupe-dirty"),
    "manifest.yaml": "name: Dupe Dirty\ndescription: Both-copies-have-settings fixture.\n",
  });
  writeFixtureApp(fixtureDir, REPO, "cleanup-runner", {
    "app.py": drawingAppSource("cleanup-runner"),
    "manifest.yaml": "name: Cleanup Runner\ndescription: Removal-of-a-running-app fixture.\n",
  });

  // Seed a config-only orphan (folder never existed) that carries real settings.
  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        listenPort: managerPort,
        barHost: `127.0.0.1:${mockBarPort}`,
        appsDirs: [localAppsDir],
        apps: {
          "ghost-app": {
            enabled: false,
            variation: "default",
            variations: { default: { args: { "--city": "Rijnsburg" }, env: {}, priority: null } },
          },
        },
        library: { checkIntervalHours: 6, repos: [{ repo: REPO, branch: "main" }] },
      },
      null,
      2
    )
  );

  log("starting mock-bar, mock-github and the manager");
  spawnLogged("mock-bar", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockBarPort) });
  spawnLogged("mock-github", process.execPath, [path.join(__dirname, "mock-github.js")], {
    PORT: String(githubPort),
    GITHUB_FIXTURE_DIR: fixtureDir,
  });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockBarPort}/api/version`)).status === 200, { label: "mock-bar ready" });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${githubPort}/_state`)).status === 200, { label: "mock-github ready" });

  spawnLogged("manager", process.execPath, [path.join(ROOT, "server.js")], {
    BUSYBAR_MANAGER_CONFIG: configPath,
    BUSYBAR_LIBRARY_API_BASE: `http://127.0.0.1:${githubPort}`,
    BUSYBAR_LIBRARY_RAW_BASE: `http://127.0.0.1:${githubPort}`,
  });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager ready" });

  const M = `http://127.0.0.1:${managerPort}`;

  /* ---------------------------------------------------------------- 1. orphan */

  log("config-only orphan is reported, 404s on library/uninstall, and DELETEs cleanly");
  let rep = (await fetchJson(`${M}/api/_manager/cleanup`)).body;
  const ghost = rep.orphans.find((o) => o.slug === "ghost-app");
  assert.ok(ghost, "ghost-app should be listed as an orphan");
  assert.equal(ghost.hasSettings, true, "ghost-app carries real args, so hasSettings must be true");
  assert.ok(rep.removable.includes("ghost-app"));

  let state = (await fetchJson(`${M}/api/_manager/state`)).body;
  assert.equal(state.apps.find((a) => a.slug === "ghost-app").missing, true);

  // The reason the new endpoint exists: the old path cannot touch this.
  let r = await postJson(`${M}/api/_manager/library/uninstall`, { slug: "ghost-app" });
  assert.equal(r.status, 404, "library/uninstall must still refuse a stampless slug");

  r = await fetchJson(`${M}/api/_manager/apps/ghost-app`, { method: "DELETE" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.apps.some((a) => a.slug === "ghost-app"), "ghost-app should be gone from state");
  assert.ok(!("ghost-app" in readConfig(configPath).apps), "ghost-app should be gone from config.json on disk");

  /* ------------------------------------------------------------- 2. stampless */

  log("stampless folder: no library stamp, still removable");
  fs.mkdirSync(path.join(APPS_DIR, "stampless-app"), { recursive: true });
  fs.writeFileSync(path.join(APPS_DIR, "stampless-app", "app.py"), drawingAppSource("stampless-app"));
  await waitFor(
    async () => {
      const st = (await fetchJson(`${M}/api/_manager/state`)).body;
      const a = st.apps.find((x) => x.slug === "stampless-app");
      return a && a.source === null;
    },
    { label: "stampless-app picked up by the scan" }
  );

  r = await postJson(`${M}/api/_manager/library/uninstall`, { slug: "stampless-app" });
  assert.equal(r.status, 404, "library/uninstall must refuse a stampless folder");
  r = await fetchJson(`${M}/api/_manager/apps/stampless-app`, { method: "DELETE" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fs.existsSync(path.join(APPS_DIR, "stampless-app")), false, "stampless-app folder should be deleted");

  /* ------------------------------------------------------- 3. local app folder */

  log("appsDirs app: config entry dropped, the user's folder survives");
  r = await postJson(`${M}/api/_manager/apps/mine/variation`, { name: "default" });
  assert.equal(r.status, 200, "should be able to touch the local app's config");
  assert.ok("mine" in readConfig(configPath).apps, "local app should now have a config entry");

  r = await fetchJson(`${M}/api/_manager/apps/mine`, { method: "DELETE" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    fs.existsSync(path.join(localAppsDir, "mine", "app.py")),
    true,
    "the user's appsDirs folder must NEVER be deleted"
  );
  assert.ok(!("mine" in readConfig(configPath).apps), "local app's config entry should be gone");

  /* ------------------------------------------------------------ 4. containment */

  log("containment: traversal, separators and dot-names are rejected");
  fs.writeFileSync(path.join(ROOT, "apps-sentinel.txt"), "do not delete me");
  for (const bad of ["..%2F..%2Fapps-sentinel.txt", "..%2Fapps-sentinel.txt", ".staging-x", ".venv", "a%2Fb"]) {
    r = await fetchJson(`${M}/api/_manager/apps/${bad}`, { method: "DELETE" });
    assert.equal(r.status, 400, `DELETE /apps/${bad} should be 400, got ${r.status}`);
  }
  for (const bad of ["../../apps-sentinel.txt", "../apps", ".venv"]) {
    r = await postJson(`${M}/api/_manager/library/uninstall`, { slug: bad });
    assert.equal(r.status, 400, `library/uninstall '${bad}' should be 400, got ${r.status}`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "apps-sentinel.txt")), true, "sentinel beside apps/ must survive");
  assert.equal(fs.existsSync(APPS_DIR), true, "apps/ itself must survive");

  /* -------------------------------------------------- 5/6. duplicate + migrate */

  log("installing cleanup-weather and cloning it to a renamed slug");
  r = await postJson(`${M}/api/_manager/library/install`, { slug: "cleanup-weather" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await cloneInstalled(M, "cleanup-weather", "cleanup_weather");

  // Give the OLD slug real settings and leave the new one pristine — the exact
  // shape of the live weather_forecast/weather-forecast pair.
  const oldArgs = { "--city": "Rijnsburg", "--lat": "52.189743", "--days": "7" };
  r = await fetchJson(`${M}/api/_manager/apps/cleanup_weather/variations/default`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args: oldArgs, env: {}, priority: null }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  log("duplicate group detected: certain, keeps the catalog slug, plans a migration");
  rep = (await fetchJson(`${M}/api/_manager/cleanup`)).body;
  const group = rep.duplicates.find((g) => g.keep === "cleanup-weather" || g.remove.includes("cleanup-weather"));
  assert.ok(group, `expected a duplicate group, got ${JSON.stringify(rep.duplicates)}`);
  assert.equal(group.confidence, "certain");
  assert.equal(group.keep, "cleanup-weather", "the slug still in the catalog must be kept");
  assert.deepEqual(group.remove, ["cleanup_weather"]);
  assert.ok(group.signals.includes("identical-files") && group.signals.includes("normalized-slug"));
  assert.deepEqual(group.migrate, { from: "cleanup_weather", to: "cleanup-weather", variations: ["default"] });
  assert.ok(rep.removable.includes("cleanup_weather") && !rep.removable.includes("cleanup-weather"));

  log("running cleanup migrates the settings wholesale and removes the duplicate");
  r = await postJson(`${M}/api/_manager/cleanup`, { slugs: ["cleanup_weather"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.removed.map((x) => x.slug), ["cleanup_weather"]);
  assert.deepEqual(r.body.migrated, [{ from: "cleanup_weather", to: "cleanup-weather", variations: ["default"] }]);
  assert.deepEqual(r.body.errors, []);

  let cfg = readConfig(configPath);
  assert.deepEqual(cfg.apps["cleanup-weather"].variations.default.args, oldArgs, "settings must land on the keeper");
  assert.ok(!("cleanup_weather" in cfg.apps), "the duplicate's config entry must be gone");
  assert.equal(fs.existsSync(path.join(APPS_DIR, "cleanup_weather")), false, "the duplicate's folder must be gone");
  assert.equal(fs.existsSync(path.join(APPS_DIR, "cleanup-weather", "app.py")), true, "the keeper must be untouched");
  assert.ok(
    fs.readdirSync(tmpDir).some((f) => f.startsWith("config.json.pre-cleanup-")),
    "a pre-cleanup config backup should have been written"
  );

  /* --------------------------------------------------- 7. both copies dirty */

  log("duplicate where BOTH copies have settings -> review only, never auto-removed");
  r = await postJson(`${M}/api/_manager/library/install`, { slug: "dupe-dirty" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await cloneInstalled(M, "dupe-dirty", "dupe_dirty");
  for (const slug of ["dupe-dirty", "dupe_dirty"]) {
    r = await fetchJson(`${M}/api/_manager/apps/${slug}/variations/default`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { "--text": slug }, env: {}, priority: null }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  rep = (await fetchJson(`${M}/api/_manager/cleanup`)).body;
  const dirty = rep.duplicates.find((g) => g.apps.some((a) => a.slug === "dupe_dirty"));
  assert.ok(dirty, "the dirty pair should still be grouped");
  assert.equal(dirty.confidence, "review");
  assert.equal(dirty.migrate, null);
  assert.ok(dirty.reason, "a review group must explain itself");
  assert.ok(!rep.removable.includes("dupe_dirty") && !rep.removable.includes("dupe-dirty"));

  log("posting a review-only slug is refused, nothing is deleted");
  r = await postJson(`${M}/api/_manager/cleanup`, { slugs: ["dupe_dirty"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.removed, []);
  assert.deepEqual(r.body.skipped, [{ slug: "dupe_dirty", reason: "not stale" }]);
  assert.equal(fs.existsSync(path.join(APPS_DIR, "dupe_dirty", "app.py")), true, "nothing should have been deleted");

  /* ----------------------------------------------------- 8. stale-UI guard */

  log("stale UI: a healthy app posted to /cleanup is skipped, never removed");
  r = await postJson(`${M}/api/_manager/cleanup`, { slugs: ["cleanup-weather"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.removed, []);
  assert.deepEqual(r.body.skipped, [{ slug: "cleanup-weather", reason: "not stale" }]);
  assert.equal(fs.existsSync(path.join(APPS_DIR, "cleanup-weather", "app.py")), true);

  r = await postJson(`${M}/api/_manager/cleanup`, { slugs: "not-an-array" });
  assert.equal(r.status, 400, "a non-array slugs body must be rejected");

  /* --------------------------------------------------- 9. both copies enabled */

  log("duplicate where BOTH copies are enabled -> review only");
  for (const slug of ["dupe-dirty", "dupe_dirty"]) {
    // Reset to pristine so only the enabled-vs-enabled rule can downgrade it.
    r = await fetchJson(`${M}/api/_manager/apps/${slug}/variations/default`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {}, env: {}, priority: null }),
    });
    assert.equal(r.status, 200);
    r = await postJson(`${M}/api/_manager/apps/${slug}/enable`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  rep = (await fetchJson(`${M}/api/_manager/cleanup`)).body;
  const bothOn = rep.duplicates.find((g) => g.apps.some((a) => a.slug === "dupe_dirty"));
  assert.ok(bothOn);
  assert.equal(bothOn.confidence, "review", "two enabled copies is a deliberate dual-run, not junk");
  assert.match(bothOn.reason, /enabled/);
  assert.ok(!rep.removable.includes("dupe_dirty"));
  for (const slug of ["dupe-dirty", "dupe_dirty"]) await postJson(`${M}/api/_manager/apps/${slug}/disable`, {});

  /* ------------------------------------------- 10. removal of a running app */

  log("removing a RUNNING app stops it and clears its frame on the bar");
  r = await postJson(`${M}/api/_manager/library/install`, { slug: "cleanup-runner" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await postJson(`${M}/api/_manager/apps/cleanup-runner/enable`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(
    async () => {
      const barLog = (await fetchJson(`http://127.0.0.1:${mockBarPort}/_log`)).body.log;
      return barLog.some((e) => e.method === "POST" && e.appName === "cleanup-runner");
    },
    { label: "cleanup-runner drawing on the bar" }
  );
  const pidBefore = (await fetchJson(`${M}/api/_manager/state`)).body.apps.find((a) => a.slug === "cleanup-runner").pid;
  assert.ok(pidBefore, "cleanup-runner should have a pid before removal");

  r = await fetchJson(`${M}/api/_manager/apps/cleanup-runner`, { method: "DELETE" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const barLog = (await fetchJson(`http://127.0.0.1:${mockBarPort}/_log`)).body.log;
  assert.ok(
    barLog.some((e) => e.method === "DELETE" && e.appName === "cleanup-runner"),
    "removal should send a display clear for a running app"
  );
  assert.ok(!r.body.apps.some((a) => a.slug === "cleanup-runner"), "cleanup-runner should be gone from state");
  assert.equal(fs.existsSync(path.join(APPS_DIR, "cleanup-runner")), false);
  // It must stay gone — scheduleRestart must not resurrect it.
  await sleep(1500);
  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  assert.ok(!state.apps.some((a) => a.slug === "cleanup-runner"), "a removed app must not restart itself");

  /* --------------------------------------------------------- final report */

  // Scoped to this suite's own fixtures: the report also covers whatever the
  // developer happens to have installed in the real apps/ dir.
  log("everything this suite removed stays gone; the untouched pair stays actionable");
  rep = (await fetchJson(`${M}/api/_manager/cleanup`)).body;
  for (const slug of ["ghost-app", "mine", "stampless-app", "cleanup_weather", "cleanup-runner"]) {
    assert.ok(!rep.removable.includes(slug), `${slug} should no longer be removable: ${JSON.stringify(rep.removable)}`);
    assert.ok(!rep.orphans.some((o) => o.slug === slug), `${slug} should not be an orphan`);
  }
  // dupe-dirty/dupe_dirty were deliberately left in place, and step 12 reset
  // both to pristine + disabled — so the group is now cleanly actionable again.
  const settled = rep.duplicates.find((g) => g.apps.some((a) => a.slug === "dupe_dirty"));
  assert.ok(settled, "the dupe pair should still be reported");
  assert.equal(settled.confidence, "certain", "pristine + disabled makes the group actionable once more");
  assert.equal(settled.migrate, null, "nothing to migrate when neither copy has settings");
}

run()
  .then(async () => {
    console.log("\nOK - all busybar-manager cleanup e2e tests passed\n");
    killAll();
    cleanupInstalledDirs();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nFAIL:", err.stack || err.message, "\n");
    killAll();
    cleanupInstalledDirs();
    process.exit(1);
  });
