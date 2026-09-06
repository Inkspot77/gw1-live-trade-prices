#!/usr/bin/env node
/** Entry point. `npm start`, or `node bin/gw1-prices.mjs --port 9000 --backfill`. */

import { parseArgs } from 'node:util';
import { startServer } from '../src/server.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    backfill: { type: 'boolean', default: false },
    watch: { type: 'string' },
    'no-poll': { type: 'boolean', default: false },
    'auth-user': { type: 'string' },
    'auth-pass': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`gw1-prices — local Guild Wars 1 price dashboard

  --port <n>       port to listen on           (default 8787)
  --host <addr>    address to bind             (default 127.0.0.1)
  --backfill       pull 90 days of NPC trader history on startup
  --watch <dir>    folder holding GWToolbox inventory exports; re-imports on change
  --no-poll        serve stored data only, contact no upstream source
  --auth-user <u>  require HTTP Basic Auth; falls back to AUTH_USER env var
  --auth-pass <p>  password for --auth-user; falls back to AUTH_PASS env var
                   (both required together — set neither to leave auth off)
`);
  process.exit(0);
}

try {
  await startServer({
    port: Number(values.port),
    host: values.host,
    poll: !values['no-poll'],
    backfill: values.backfill,
    watch: values.watch ?? null,
    // A CLI flag's value is visible to anyone who can run `ps aux` on this
    // machine; an env var is not exposed that way. The env var is therefore
    // the recommended way to pass the password — from a systemd unit's
    // Environment= line, a compose file's environment: block, or a shell
    // export that never becomes part of this process's argv.
    authUser: values['auth-user'] ?? process.env.AUTH_USER ?? null,
    authPass: values['auth-pass'] ?? process.env.AUTH_PASS ?? null,
  });
} catch (error) {
  console.error(`gw1-prices: ${error.message}`);
  process.exit(1);
}
