#!/usr/bin/env node
/** Entry point. `npm start`, or `node bin/gw1-prices.mjs --port 9000 --backfill`. */

import { parseArgs } from 'node:util';
import { startServer } from '../src/server.mjs';

// port/host/backfill/no-poll deliberately have NO `default:` here — a set
// default means parseArgs always returns it, which would permanently hide
// the PORT/HOST/BACKFILL/NO_POLL env-var fallbacks below. The real defaults
// are applied once, after the env var has had its turn.
const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    backfill: { type: 'boolean' },
    watch: { type: 'string' },
    'no-poll': { type: 'boolean' },
    'auth-user': { type: 'string' },
    'auth-pass': { type: 'string' },
    'backup-dir': { type: 'string' },
    'backup-interval': { type: 'string' },
    'catalog-url': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`gw1-prices — local Guild Wars 1 price dashboard

Every option below can be set as a flag or as the matching environment
variable (a flag wins if both are given). --env-file-if-exists=.env
(already wired into \`npm start\`/\`npm run backfill\`) loads a .env file into
the environment first, using Node's own built-in support — no dependency.

  --port <n>       port to listen on                    [env PORT]      (default 8787)
  --host <addr>    address to bind                       [env HOST]      (default 127.0.0.1)
  --backfill       pull 90 days of NPC trader history     [env BACKFILL]  on startup
  --watch <dir>    folder of GWToolbox inventory exports; [env WATCH_DIR] re-imports on change
  --no-poll        serve stored data only,                [env NO_POLL]   contact no upstream source
  --auth-user <u>  require HTTP Basic Auth                [env AUTH_USER]
  --auth-pass <p>  password for --auth-user               [env AUTH_PASS]
                   (both required together — set neither to leave auth off)
  --backup-dir <d> write periodic database backups here   [env BACKUP_DIR]  (off by default)
  --backup-interval <n> minutes between backups            [env BACKUP_INTERVAL_MINUTES] (default 60)
                   (only takes effect once --backup-dir is set)
  --catalog-url <u> weekly refresh source for the extended [env COMMUNITY_CATALOG_URL]
                   weapon/armor model-id catalog             (off by default)
`);
  process.exit(0);
}

/** "true"/"1"/"yes" from an env var reads as boolean-true; anything else is false. */
const envFlag = (name) => /^(1|true|yes)$/i.test(process.env[name] ?? '');

try {
  const { server, store, poller, backup } = await startServer({
    // CLI flag wins if given; otherwise the matching env var; otherwise the
    // built-in default. This is the same precedence --auth-user/--auth-pass
    // already used, now applied consistently to every option, so a plain
    // `node bin/gw1-prices.mjs` and a Docker container behave identically
    // when configured via environment rather than flags.
    port: Number(values.port ?? process.env.PORT ?? 8787),
    host: values.host ?? process.env.HOST ?? '127.0.0.1',
    poll: !(values['no-poll'] || envFlag('NO_POLL')),
    backfill: values.backfill || envFlag('BACKFILL'),
    watch: values.watch ?? process.env.WATCH_DIR ?? null,
    // A CLI flag's value is visible to anyone who can run `ps aux` on this
    // machine; an env var is not exposed that way. The env var is therefore
    // the recommended way to pass the password — from a systemd unit's
    // Environment= line, a compose file's environment: block, or a shell
    // export that never becomes part of this process's argv.
    authUser: values['auth-user'] ?? process.env.AUTH_USER ?? null,
    authPass: values['auth-pass'] ?? process.env.AUTH_PASS ?? null,
    backupDir: values['backup-dir'] ?? process.env.BACKUP_DIR ?? null,
    backupIntervalMinutes: Number(
      values['backup-interval'] ?? process.env.BACKUP_INTERVAL_MINUTES ?? 60,
    ),
    catalogUrl: values['catalog-url'] ?? process.env.COMMUNITY_CATALOG_URL ?? null,
  });

  // Recorded so the next boot can tell a clean stop from a crash or a power
  // loss — the startup catch-up in server.mjs backfills trader history
  // automatically when this is missing or stale.
  const shutdown = () => {
    store.setContext('lastCleanShutdown', Date.now());
    store.checkpoint();
    poller.stop();
    backup?.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`gw1-prices: ${error.message}`);
  process.exit(1);
}
