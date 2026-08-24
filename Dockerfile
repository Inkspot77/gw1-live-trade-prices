# GW1 Live Trade Prices
#
# No dependencies to install — the whole app is Node built-ins (node:sqlite,
# node:http, global fetch) — so this is a single stage: copy the source in and
# run it. There is nothing to compile, so alpine's musl libc is not a concern.
FROM node:22-alpine

# node:sqlite is unflagged only from Node 22.13.0 (or 23.4.0) onward. Fail the
# build here, loudly, rather than have every request 500 with a cryptic
# ERR_UNKNOWN_BUILTIN_MODULE the first time someone bumps the base image tag.
RUN node -e "require('node:sqlite')" || { \
      echo "FATAL: this Node build does not expose node:sqlite unflagged." >&2; \
      echo "       Need >=22.13.0 or >=23.4.0 — got $(node --version)." >&2; \
      exit 1; \
    }

# The official image already ships a non-root "node" user at a fixed uid:gid
# of 1000:1000 (stable across image updates by upstream convention), so a host
# bind mount for --watch only needs chowning to 1000:1000 to line up — no need
# to create our own user and risk colliding with it (it already owns gid 1000).
WORKDIR /app
COPY --chown=node:node . .
RUN chmod +x docker-entrypoint.sh \
 && mkdir -p data \
 && chown node:node data

VOLUME /app/data
USER node

ENV HOST=0.0.0.0 \
    PORT=8787
EXPOSE 8787

# The HTTP port opens before the first poll finishes, so this answers within a
# few seconds of the container starting rather than after the ~25-30s that a
# full first poll of every source takes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/api/context" > /dev/null || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
