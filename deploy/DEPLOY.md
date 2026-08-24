# Hosting on an Ubuntu server, synced from the Windows GW box

Two halves: get the dashboard running as a service on Ubuntu, then get the
Toolbox inventory export off Windows and onto it.

**Prefer a container?** `docker compose up -d --build` from the project root
handles all of Part 1 — see the Docker section in the top-level README. Part 2
below (getting the Toolbox export from Windows onto this box) applies exactly
the same either way; only the *target* the sync points at changes, from
`/srv/gw1-sync/inventories` to whatever host path you bind-mount into the
container.

---

## Part 1 — the Ubuntu server

### 1. Node 22.13 or newer

This is the one thing that actually blocks. `node:sqlite` is behind
`--experimental-sqlite` on Node 22.5-22.12 and unflagged only from **22.13.0**
(and 23.4.0). Ubuntu's `apt` Node is usually older than that, so install from
NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version          # expect v22.13.0 or newer
```

`nvm` works too, but a systemd unit then has to point at a versioned binary
path, which breaks quietly on upgrade. NodeSource keeps `/usr/bin/node` correct.

### 2. Get the code onto the box

There are no dependencies and no build step, so a plain copy is enough:

```bash
# from your workstation
rsync -a --exclude data/prices.db --exclude .freebuff --exclude .git \
  ./ youruser@server:/tmp/gw1-prices/

# on the server
sudo mkdir -p /opt/gw1-prices
sudo cp -r /tmp/gw1-prices/. /opt/gw1-prices/
```

Do **not** run `npm install` — there is no lockfile and nothing to fetch.

### 3. A service account

```bash
sudo useradd --system --home /opt/gw1-prices --shell /usr/sbin/nologin gw1
sudo mkdir -p /opt/gw1-prices/data /srv/gw1-sync/inventories
sudo chown -R gw1:gw1 /opt/gw1-prices /srv/gw1-sync
```

### 4. Check before you install

```bash
sudo -u gw1 bash /opt/gw1-prices/deploy/preflight.sh /srv/gw1-sync/inventories
```

It verifies the Node version, that `node:sqlite` loads unflagged, that all five
price sources are reachable, and that the watch folder is readable — including
whether its filesystem supports change events.

### 5. Seed the price history

Worth doing once, before the service starts. It pulls ~90 days of NPC trader
history so materials have a real baseline immediately instead of accumulating
one over three months:

```bash
sudo -u gw1 node /opt/gw1-prices/bin/gw1-prices.mjs --backfill --port 8788
```

**Do not add `--no-poll` here.** `--backfill` only runs inside the same
startup branch as the regular poll, so `--no-poll --backfill` together is a
silent no-op that contacts nothing and backfills nothing. `--backfill` alone
does one full poll of every source, then the 90-day trader-history seed, then
starts serving normally. `--port 8788` just keeps this one-off run off 8787 in
case the real service is already up; it is otherwise unused.

It is rate-limited and resumable. If it reports failures, run it again — it
skips whatever already completed. Ctrl-C once the backfill summary prints.

### 6. Install the service

```bash
sudo cp /opt/gw1-prices/deploy/gw1-prices.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gw1-prices
journalctl -u gw1-prices -f
```

The HTTP port opens before the first poll finishes, so the dashboard answers
immediately even though that first poll takes 25-30 seconds.

### 7. Reaching it

**There is no authentication.** The POST endpoints change stored state, so the
`--host 0.0.0.0` in the shipped unit only makes sense on a network you trust.

- **Trusted home LAN** — leave it, browse to `http://server-ip:8787`.
- **LAN, with a password** — the compose `lan` profile starts a Caddy that
  owns host port 8787 and demands basic auth before proxying to the dashboard
  (`deploy.sh --lan` deploys it). Change the password by running
  `docker run --rm caddy:2-alpine caddy hash-password --plaintext 'newpass'`
  and putting the new hash in `Caddyfile`. This is the safe way to expose it
  beyond loopback when the LAN is not fully trusted.
- **Anything less trusted** — drop `--host 0.0.0.0` so it binds loopback only,
  and tunnel in:
  `ssh -N -L 8787:127.0.0.1:8787 gw1-server`, then use `http://127.0.0.1:8787`.
- **On a hostname, with auth** — put Caddy in front:

  ```caddyfile
  gw1.lan {
      basic_auth { alan <bcrypt-hash> }
      reverse_proxy 127.0.0.1:8787
  }
  ```

---

## Part 2 — syncing the inventory from Windows

### Where the file lives on Windows

GWToolbox writes under **Documents**, namespaced by computer name and config:

```
%USERPROFILE%\Documents\GWToolboxpp\<COMPUTER-NAME>\configs\default\inventories\
```

`default` is the config name — with a named Toolbox config it is
`configs\<that-name>` instead. Browse there and confirm you can see a
`tmp<account-guid>.json` before setting up any sync. If the folder is empty, log
in and zone into an outpost once; Toolbox writes on outpost map load.

### Option A — Syncthing (recommended)

Best fit here: survives reboots and IP changes, needs no share permissions, and
keeps working if the two machines end up on different networks.

1. Install Syncthing on both. On Ubuntu, run it as the service account so files
   land with the right owner:

   ```bash
   sudo apt-get install -y syncthing
   sudo loginctl enable-linger gw1
   sudo -u gw1 XDG_RUNTIME_DIR=/run/user/$(id -u gw1) systemctl --user enable --now syncthing
   ```

2. On Windows, add the `inventories` folder above as a share, and set **Folder
   Type: Send Only**. That matters — it stops anything on the Linux side ever
   propagating back into your Toolbox settings.
3. On Ubuntu, accept the share, point it at `/srv/gw1-sync/inventories`, and set
   **Receive Only**.
4. Add `*.tmp` and `~*` to the folder's ignore patterns to cut the noise.

Expect a lag of seconds to a minute: Syncthing propagates a file once the
writing process releases it, not while Toolbox holds it open.

### Option B — mount the Windows share over CIFS

Fewer moving parts, but the Windows box has to be on whenever you want fresh
data.

1. On Windows, share the `inventories` folder read-only.
2. On Ubuntu, keep the credentials out of the mount table:

   ```bash
   sudo install -m 600 /dev/null /etc/gw1-smb.cred
   sudo tee /etc/gw1-smb.cred >/dev/null <<'EOF'
   username=YourWindowsUser
   password=YourWindowsPassword
   EOF
   ```

3. Add to `/etc/fstab` as a single line, then `sudo mount -a`:

   ```
   //WINDOWS-PC/inventories /srv/gw1-sync/inventories cifs credentials=/etc/gw1-smb.cred,ro,uid=gw1,gid=gw1,iocharset=utf8,nofail,x-systemd.automount,_netdev 0 0
   ```

   `nofail` and `x-systemd.automount` matter: without them the Ubuntu box hangs
   at boot whenever the Windows machine is off.

**Note:** inotify events do not cross CIFS, so `fs.watch` sees nothing here. The
dashboard's 10-second stat poll is what picks up changes, and the watch status
line says so explicitly. That is expected, not a fault.

### Option C — push from Windows on a schedule

Nothing to install beyond OpenSSH, which ships with Windows. A Task Scheduler
job at logon:

```powershell
$src = "$env:USERPROFILE\Documents\GWToolboxpp\$env:COMPUTERNAME\configs\default\inventories"
while ($true) {
    scp -q "$src\tmp*.json" gw1@server:/srv/gw1-sync/inventories/
    Start-Sleep -Seconds 60
}
```

Crude, but dependency-free and easy to reason about.

### Point the dashboard at it

Either edit `--watch` in the unit file, or set it in the UI under **Your
inventory → watch a folder**. The path is stored in the database, so it comes
back on its own after a restart.

The status line under the field tells you which mechanism is live:

> ● Watching for changes, and re-checking every 10s.

versus, on a CIFS mount:

> ● Re-checking every 10s (this filesystem sends no change events).

---

## Backups

Everything that matters is one file: `/opt/gw1-prices/data/prices.db`. It holds
the accumulated price history, which **cannot be re-fetched** — the upstream
sources only expose a live window. Snapshot it safely while the service runs:

```bash
sudo -u gw1 sqlite3 /opt/gw1-prices/data/prices.db \
  ".backup '/var/backups/gw1-$(date +%F).db'"
```

(`apt-get install -y sqlite3` if needed; the dashboard itself does not require
the CLI.)

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node older than 22.13. |
| Service restarts in a loop | Port already taken; `journalctl -u gw1-prices -n 20` says so plainly. |
| Inventory never updates | Read the watch status line. If it says "no change events" the poll is running, so the file is not arriving — check sync, not the dashboard. |
| All sources red | Outbound HTTPS blocked. Re-run `preflight.sh`. |
| Dashboard empty after a move | `data/prices.db` was not copied, or is owned by the wrong user. |
