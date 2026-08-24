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
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`gw1-prices — local Guild Wars 1 price dashboard

  --port <n>     port to listen on           (default 8787)
  --host <addr>  address to bind             (default 127.0.0.1)
  --backfill     pull 90 days of NPC trader history on startup
  --watch <dir>  folder holding GWToolbox inventory exports; re-imports on change
  --no-poll      serve stored data only, contact no upstream source
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
  });
} catch (error) {
  console.error(`gw1-prices: ${error.message}`);
  process.exit(1);
}
