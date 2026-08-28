"use strict";
/*
 * busybar-manager argparse option discovery tests (docs/CONTRACT.md, "Option
 * discovery").
 *
 * Spins up test/mock-bar.js and server.js against a temp apps dir holding one
 * app whose parser covers every shape the dashboard renders: bounded numbers
 * (a range metavar, a fractional one, a negative one, and choices=range()),
 * a short choice set, a plain metavar, a bare flag and multi-name options,
 * plus the descriptive metavars argparse allows but never validates
 * (OWNER/NAME, NAME=URL, FIVE,WEEK, [QUERY], nargs tuples: issue #20).
 * Asserts the discovered option list, and that values picked for a slider
 * and for a two-value option actually reach the app.
 */
const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");

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
function postJson(url, obj, method = "POST") {
  return fetchJson(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
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

// Echoes the parsed values so the test can see what the manager passed.
const DUMMY_APP = `#!/usr/bin/env python3
"""Option discovery test dummy."""
import argparse
import time

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1:8321")
parser.add_argument("--volume", "-V", type=int, metavar="0-100", default=70, help="chime volume percentage (default: 70)")
parser.add_argument("--gain", type=float, metavar="0.0-1.0", default=0.5, help="gain factor")
parser.add_argument("--offset", type=int, metavar="-10-10", default=0, help="pixels to shift by")
parser.add_argument("--steps", type=int, metavar="1..10", default=3, help="steps per cycle")
parser.add_argument("-b", "--brightness", type=int, choices=range(0, 101), default=50, help="panel brightness")
parser.add_argument("--lang", "--language", choices=["de", "en", "nl"], default="en", help="ui language")
parser.add_argument("-q", action="store_true", help="quiet")
parser.add_argument("--theme", choices=["dark", "light"], default="dark", help="colour theme")
parser.add_argument("--city", default="Amsterdam", help="city name")
parser.add_argument("--dim", action="store_true", help="use dimmed colours")
parser.add_argument("--repo", metavar="OWNER/NAME", default="busy/bar", help="repository to watch (default: busy/bar)")
parser.add_argument("--feed", metavar="NAME=URL", help="feed to poll")
parser.add_argument("--mock-usage", metavar="FIVE,WEEK", help="usage numbers to fake")
parser.add_argument("--list-stations", nargs="?", metavar="QUERY", help="stations matching QUERY")
parser.add_argument("--mode", nargs="?", choices=["fast", "slow"], help="optional mode")
parser.add_argument("--size", nargs=2, type=int, metavar=("W", "H"), default=[64, 32], help="frame size")
parser.add_argument("--tags", nargs="+", help="tags to show")
args = parser.parse_args()
print("args volume=" + str(args.volume) + " gain=" + str(args.gain) + " theme=" + args.theme, flush=True)
print("args repo=" + args.repo + " size=" + str(args.size[0]) + "x" + str(args.size[1]), flush=True)
while True:
    time.sleep(0.2)
`;

function stateOf(M) {
  return fetchJson(`${M}/api/_manager/state`).then((r) => r.body);
}
function appOf(state, slug) {
  return state.apps.find((a) => a.slug === slug);
}
function optOf(app, flag) {
  return app.options.find((o) => o.flag === flag);
}
async function logLines(M, slug) {
  const r = await fetchJson(`${M}/api/_manager/apps/${slug}/log`);
  return (r.body && r.body.lines) || [];
}

async function main() {
  const mockPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-options-test-"));
  const configPath = path.join(tmpDir, "config.json");
  const appsDir = path.join(tmpDir, "apps");

  fs.mkdirSync(path.join(appsDir, "opt-app"), { recursive: true });
  fs.writeFileSync(path.join(appsDir, "opt-app", "app.py"), DUMMY_APP);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ listenPort: managerPort, barHost: `127.0.0.1:${mockPort}`, appsDirs: [appsDir], apps: {} }, null, 2)
  );

  log("starting mock-bar");
  spawnLogged("mock-bar", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockPort) });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockPort}/api/version`)).status === 200, { label: "mock-bar ready" });

  spawnLogged("manager", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager ready" });

  const M = `http://127.0.0.1:${managerPort}`;

  log("a range metavar is discovered as a bounded int");
  const app = appOf(await stateOf(M), "opt-app");
  assert.ok(app, "opt-app not found in state");
  assert.deepEqual(optOf(app, "--volume"), {
    flag: "--volume",
    type: "int",
    default: "70",
    choices: null,
    min: 0,
    max: 100,
    step: 1,
    meta: "0-100",
    help: "chime volume percentage (default: 70)",
  });

  log("fractional, negative and dotted bounds are read too");
  assert.deepEqual(optOf(app, "--gain"), {
    flag: "--gain",
    type: "float",
    default: null,
    choices: null,
    min: 0,
    max: 1,
    step: null,
    meta: "0.0-1.0",
    help: "gain factor",
  });
  assert.equal(optOf(app, "--offset").type, "int");
  assert.equal(optOf(app, "--offset").min, -10);
  assert.equal(optOf(app, "--offset").max, 10);
  assert.equal(optOf(app, "--steps").min, 1);
  assert.equal(optOf(app, "--steps").max, 10);

  log("a long run of consecutive int choices collapses into the same bounds");
  assert.deepEqual(optOf(app, "--brightness"), {
    flag: "--brightness",
    type: "int",
    default: null,
    choices: null,
    min: 0,
    max: 100,
    step: 1,
    meta: `{${Array.from({ length: 101 }, (_, i) => i).join(",")}}`, // argparse spells choices=range(0, 101) out in full
    help: "panel brightness",
  });

  log("an option with several names is reported once, under its longest name");
  assert.deepEqual(optOf(app, "--language").choices, ["de", "en", "nl"]);
  assert.equal(optOf(app, "--lang"), undefined, "the shorter alias must not show up, even when argparse lists it first");
  assert.equal(optOf(app, "-b"), undefined, "the short name of --brightness must not show up on its own");
  assert.equal(optOf(app, "-q").type, "bool", "a short-only flag is reported under its short name");

  log("short choice sets, plain metavars and bare flags are unchanged");
  assert.deepEqual(optOf(app, "--theme").choices, ["dark", "light"]);
  assert.equal(optOf(app, "--theme").type, "choice");
  assert.equal(optOf(app, "--theme").min, null);
  assert.equal(optOf(app, "--city").type, "str");
  assert.equal(optOf(app, "--dim").type, "bool");

  log("a descriptive metavar is kept verbatim instead of hiding the option (issue #20)");
  for (const [flag, meta] of [
    ["--repo", "OWNER/NAME"],
    ["--feed", "NAME=URL"],
    ["--mock-usage", "FIVE,WEEK"],
    ["--list-stations", "[QUERY]"],
    ["--size", "W H"],
    ["--tags", "TAGS [TAGS ...]"],
  ]) {
    const o = optOf(app, flag);
    assert.ok(o, `${flag} should be discovered (metavar ${meta})`);
    assert.equal(o.type, "str", `${flag} should take a value`);
    assert.equal(o.meta, meta);
    assert.equal(o.choices, null);
  }
  assert.equal(optOf(app, "--repo").default, "busy/bar");

  log("an optional-value metavar keeps its choices");
  assert.deepEqual(optOf(app, "--mode").choices, ["fast", "slow"]);
  assert.equal(optOf(app, "--mode").type, "choice");

  log("--host stays hidden: the supervisor owns it");
  assert.equal(optOf(app, "--host"), undefined);

  log("a value picked for a bounded option reaches the app");
  assert.equal(
    (
      await postJson(
        `${M}/api/_manager/apps/opt-app/variations/loud`,
        { args: { "--volume": "90", "--gain": "0.25", "--repo": "robynhub/busybar-apps", "--size": "128 64" }, env: {}, priority: 10 },
        "PUT"
      )
    ).status,
    200
  );
  assert.equal((await postJson(`${M}/api/_manager/apps/opt-app/variation`, { name: "loud" })).status, 200);
  assert.equal((await fetchJson(`${M}/api/_manager/apps/opt-app/enable`, { method: "POST" })).status, 200);
  await waitFor(async () => (await logLines(M, "opt-app")).some((l) => l.includes("args volume=")), { label: "opt-app printed its args" });
  const lines = await logLines(M, "opt-app");
  assert.ok(
    lines.some((l) => l.includes("args volume=90 gain=0.25")),
    `slider values should reach the app, got: ${lines.join(" | ")}`
  );
  // "--size 128 64": a metavar naming two values is passed as two argv entries,
  // the only form argparse accepts for nargs=2.
  assert.ok(
    lines.some((l) => l.includes("args repo=robynhub/busybar-apps size=128x64")),
    `a slash metavar and a two-value option should reach the app, got: ${lines.join(" | ")}`
  );

  assert.equal((await fetchJson(`${M}/api/_manager/apps/opt-app/disable`, { method: "POST" })).status, 200);
  killAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n  option discovery tests passed\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\nFAILED:", e && e.stack ? e.stack : e);
    killAll();
    process.exit(1);
  }
);
