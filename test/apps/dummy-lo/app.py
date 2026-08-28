#!/usr/bin/env python3
"""Dummy low-priority test app for busybar-manager e2e tests.

    python app.py --host 127.0.0.1:8090 [--text HELLO]
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

APP = "dummy-lo"
PRIORITY = 30
INTERVAL = 0.5


def parse_args():
    p = argparse.ArgumentParser(description="Dummy test app (low priority)")
    p.add_argument("--host", default="10.0.4.20")
    p.add_argument("--text", default="LO", help="text to draw (default: LO)")
    return p.parse_args()


def _base(host):
    host = host.replace("http://", "").replace("https://", "").rstrip("/")
    return "http://" + host


def draw(host, text):
    body = {
        "application_name": APP,
        "priority": PRIORITY,
        "elements": [
            {"id": "t", "type": "text", "text": text, "x": 0, "y": 0, "font": "small", "color": "#FFFFFFFF"},
        ],
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        _base(host) + "/api/display/draw", data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.getcode()
    except urllib.error.HTTPError as e:
        return e.code


def main():
    args = parse_args()
    print(f"{APP} -> {_base(args.host)}  (Ctrl-C to stop)")
    try:
        while True:
            status = draw(args.host, args.text)
            if status == 409:
                print("display busy (409), retrying next cycle")
            else:
                print(f"drew '{args.text}' (status {status})")
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        print("\nstopped.")
    except urllib.error.URLError as e:
        sys.exit(f"error: cannot reach {_base(args.host)} — {e.reason}")


if __name__ == "__main__":
    main()
