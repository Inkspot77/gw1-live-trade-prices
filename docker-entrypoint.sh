#!/bin/sh
# Builds the ectowatch command line from environment variables, so the normal
# container knobs (docker run -e / compose `environment:`) configure it without
# anyone needing to override the whole command.
#
# Written in POSIX sh with `set -- newtoken "$@"` rather than string
# concatenation, specifically so a WATCH_DIR containing spaces still survives
# intact — building this as a plain string and re-splitting it would break on
# exactly the kind of path a synced folder tends to have.
set -e

if [ -n "$WATCH_DIR" ]; then
  set -- --watch "$WATCH_DIR" "$@"
fi
case "$BACKFILL" in
  1 | true | TRUE | yes) set -- --backfill "$@" ;;
esac
case "$NO_POLL" in
  1 | true | TRUE | yes) set -- --no-poll "$@" ;;
esac
set -- --port "${PORT:-8787}" --host "${HOST:-0.0.0.0}" "$@"

exec node bin/ectowatch.mjs "$@"
