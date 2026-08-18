#!/usr/bin/env python3
"""Serve this Mac's CPU, memory and network counters over HTTP.

Apps that report on the machine itself (`mac-monitor`) read `ps`, `vm_stat`,
`sysctl` and `netstat -ib`. Run inside the container those commands are either
missing or describe Docker Desktop's Linux VM instead of macOS, and since the
app treats an unreadable command as "nothing to report" it draws three empty
bars at 0%. No Docker flag fixes that: `--pid=host` or `--network=host` still
land in the VM, not on the Mac. So the reading moves to where the Mac actually
is, and the container asks over HTTP.

    python3 scripts/host-metrics.py                  # 127.0.0.1:8322
    python3 scripts/host-metrics.py --port 9000
    python3 scripts/host-metrics.py --host 0.0.0.0   # LAN as well, no auth

Loopback is enough for Docker Desktop, which proxies `host.docker.internal`
from the host side and so reaches a service bound to 127.0.0.1. A Linux daemon
routes to the host address instead and needs `--host 0.0.0.0`.

    GET /metrics  ->  {"cpu_pct": 12.3, "mem_pct": 61.0, "net_bytes": 91234567}

`net_bytes` is the cumulative counter rather than a rate: the caller diffs two
samples, which keeps this agent stateless and makes a restart free.

Anything unreadable comes back as HTTP 500 with a JSON `error`, never as a
zero. A zero is indistinguishable from an idle Mac, and that is precisely the
failure this agent exists to end.
"""
import argparse
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8322


def _run(*args):
    """Run a command and return stdout, raising on anything unexpected."""
    r = subprocess.run(list(args), capture_output=True, text=True, timeout=5)
    if r.returncode != 0:
        raise RuntimeError(f"{args[0]} exited {r.returncode}: {r.stderr.strip()[:200]}")
    return r.stdout


def cpu_pct():
    """CPU use across all cores as a percentage, capped at 100."""
    total = sum(float(l) for l in _run("ps", "-A", "-o", "%cpu").splitlines()
                if l.strip() not in ("", "%CPU"))
    ncpu = int(_run("sysctl", "-n", "hw.ncpu").strip())
    return min(100.0, total / max(ncpu, 1))


def mem_pct():
    """Active + wired + compressed pages as a percentage of installed RAM."""
    vm = _run("vm_stat")

    # Header reads "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    # and it is 16K on Apple silicon against 4K on Intel, so it has to be read
    # rather than assumed.
    page_size = 4096
    for line in vm.splitlines():
        if "page size of" in line:
            parts = line.split()
            page_size = int(parts[parts.index("of") + 1])
            break

    def pages(key):
        for line in vm.splitlines():
            if line.startswith(key):
                return int(line.split(":")[1].strip().rstrip("."))
        raise RuntimeError(f"vm_stat has no {key!r} line")

    used = (pages("Pages active")
            + pages("Pages wired down")
            + pages("Pages occupied by compressor")) * page_size
    total = int(_run("sysctl", "-n", "hw.memsize").strip())
    return min(100.0, used / total * 100.0)


def net_bytes():
    """Cumulative ibytes+obytes over every interface except loopback."""
    seen = set()
    total = 0
    for line in _run("netstat", "-ib").splitlines():
        parts = line.split()
        if len(parts) < 10 or parts[0] == "Name":
            continue
        iface = parts[0]
        # netstat prints one row per address family, so an interface shows up
        # several times with the same counters. Keep the first row only.
        if iface == "lo0" or iface in seen:
            continue
        # Columns: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
        try:
            total += int(parts[6]) + int(parts[9])
        except (ValueError, IndexError):
            continue
        seen.add(iface)
    return total


def collect():
    return {
        "cpu_pct": round(cpu_pct(), 1),
        "mem_pct": round(mem_pct(), 1),
        "net_bytes": net_bytes(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "busybar-host-metrics/1"

    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/metrics"):
            self._reply(404, {"error": "not found"})
            return
        try:
            self._reply(200, collect())
        except Exception as e:
            print(f"error: {e}", file=sys.stderr, flush=True)
            self._reply(500, {"error": str(e)})

    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # A client sampling every 2s writes ~43k access lines a day, which
        # buries the errors that are worth reading.
        pass


def main():
    ap = argparse.ArgumentParser(description="Serve this Mac's CPU, memory and network counters over HTTP.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default: {DEFAULT_PORT})")
    args = ap.parse_args()

    if sys.platform != "darwin":
        sys.exit("error: this agent reads macOS-only tools, so it has to run on the Mac itself")

    # Read once before serving: a broken interpreter or a missing tool then
    # shows up in the log at startup instead of as a 500 two days later.
    try:
        print(f"first reading: {json.dumps(collect())}", flush=True)
    except Exception as e:
        print(f"warning: cannot read this Mac yet: {e}", file=sys.stderr, flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"host metrics -> http://{args.host}:{args.port}/metrics  (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
