#!/usr/bin/env bash
# Runs busybar-manager's e2e test suites against test/mock-bar.js (and, for
# the library tests, test/mock-github.js).
set -euo pipefail
cd "$(dirname "$0")/.."
node test/e2e.test.js
node test/library.e2e.test.js
node test/library-v3.e2e.test.js
node test/cleanup.e2e.test.js
node test/bar-passthrough.test.js
