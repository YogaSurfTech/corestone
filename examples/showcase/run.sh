#!/bin/bash
# Makes the README's screenshot (docs/screenshot.png) from scratch.
#
#   examples/showcase/run.sh [output.png]
#
# It builds Corestone, starts a server of its own on a new, empty repository,
# seeds the example (a research folder with measurement specifications, see
# shot.mjs), builds a query in the query builder and takes the picture with
# Playwright's browser. Nothing of your own data is touched.
#
# Needs: Go, Node and the web client's packages (npm ci in web/, with
# Playwright's Chromium), and a PostgreSQL database for the projection that
# may be overwritten:
#
#   SHOWCASE_DB    its address (default: the database corestone_showcase on
#                  127.0.0.1, user and password postgres); create it once with
#                  createdb corestone_showcase
#   SHOWCASE_PORT  the port of the server (default 18098)
#
# The repository and the server's log stay in a new directory below the
# system's temporary directory; its name is printed at the end.
set -u
root="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
here="$root/examples/showcase"
out="$(readlink -f "${1:-$root/docs/screenshot.png}")"
db="${SHOWCASE_DB:-postgres://postgres:postgres@127.0.0.1:5432/corestone_showcase?sslmode=disable}"
port="${SHOWCASE_PORT:-18098}"
run="$(mktemp -d -t corestone-showcase.XXXXXX)"

cd "$root" || exit 1
make build >"$run/build.log" 2>&1 || { tail -20 "$run/build.log"; exit 1; }
./bin/corestone -repo "$run/repo.git" -addr "127.0.0.1:$port" -web web/dist -drawio web/tests/drawio-stub \
  -db "$db" -auth none -accounts "$run/accounts.json" >"$run/server.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break; sleep 0.2; done
(cd web && CORESTONE_URL="http://127.0.0.1:$port" OUT="$out" node "$here/shot.mjs"); status=$?
kill "$pid" 2>/dev/null
[ $status -eq 0 ] && echo "written: $out"
echo "repository and logs: $run"
exit $status
