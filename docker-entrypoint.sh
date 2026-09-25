#!/bin/sh
# Deploy gate (blueprint §11.3): schema migrations run in THIS process,
# before the server accepts traffic. A failing migration exits non-zero and
# the container never starts serving. SQLite (dev) mode has no pre-step.
set -e

if [ -n "${DATABASE_URL:-}" ]; then
  node migrate.mjs
fi

exec "$@"
