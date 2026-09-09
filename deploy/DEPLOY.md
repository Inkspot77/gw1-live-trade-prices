# Setting Up GW1 Live Trade Prices

This guide has no assumed background — it explains every term the first time
it comes up. There are two ways to run the dashboard; pick whichever fits:

- **[Option 1: Install on a server](#option-1-install-on-an-ubuntu-server)** —
  it runs all the time, and anyone on your home network can check prices from
  their phone, laptop, or the same PC. This is the better choice if more than
  one person wants to use it, or you want it running even when your gaming PC
  is off.
- **[Option 2: Run it on your own Windows PC](#option-2-run-it-on-your-windows-pc)**
  — the simplest possible setup. It only runs while you have it open on that
  one computer, and only that computer can see it, but there's no server to
  manage and no syncing to set up — it reads your Guild Wars inventory
  straight off the same machine.

Both give you the exact same dashboard; this is only about *where* it lives.

---

## Option 1: Install on an Ubuntu server

You'll need a computer running Ubuntu that stays on, and the ability to open
a **terminal** on it — either sitting at it directly, or connecting to it
remotely over **SSH** (a way to type commands on another computer from your
own, like a remote-control window for text). If you don't already have SSH
access set up, that's a one-time setup on its own — ask whoever manages the
server, or search "generate SSH key and copy to server" for your specific
setup.

Everything below is typed into that terminal, on the server.

### Step 1 — Install Docker

The dashboard runs inside **Docker** — think of it as a sealed box that
contains the app and everything it needs, so you don't have to install or
configure anything else by hand. One command installs it:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

Then let your user run Docker commands without typing `sudo` every time:

```bash
sudo usermod -aG docker $USER
```

**Log out and back in** (close and reopen your terminal / SSH session) for
that to take effect. Confirm it worked:

```bash
docker compose version
```

If that prints a version number instead of an error, you're set.

### Step 2 — Get the project files onto the server

If you have `git` and access to the GitHub repository:

```bash
git clone https://github.com/Inkspot77/gw1-live-trade-prices.git gw1-prices
cd gw1-prices
```

(The repository is private, so `git` will ask you to log in — use a
[personal access token](https://github.com/settings/tokens) as the password
if it asks for one.)

If you don't use `git`, download the code as a ZIP from the green **Code**
button on the GitHub page instead, transfer it to the server (e.g. with
`scp` from your own computer, or a tool like WinSCP/FileZilla), and unzip it
into a folder there.

### Step 3 — Build and start it

From inside that folder:

```bash
docker compose --profile lan up -d --build
```

The first run downloads and builds everything, which takes a few minutes.
`-d` means it keeps running in the background after the command finishes.
`--profile lan` turns on the part that makes the dashboard reachable from
other devices on your network, with a lock (HTTPS) and a password — covered
next.

Check it's running:

```bash
docker compose ps
```

You want to see two entries, both `Up` (or `healthy`) — one named
`gw1-prices`, one named `caddy`.

### Step 4 — Set a real password

Out of the box, the password is a placeholder that doesn't work — this is
deliberate, so nobody accidentally ships a real password in the project
files. Set your own:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'ChooseYourOwnPassword'
```

Replace `ChooseYourOwnPassword` with an actual password you'll remember —
keep the quotes. This prints one long line starting with `$2a$...` — that's
your password, scrambled in a one-way way (a **hash**) so it's safe to store
in a file. Copy that whole line.

Open the file named `Caddyfile` in the project folder with a text editor
(`nano Caddyfile` works fine in the terminal), find the line that looks like:

```
alan <bcrypt-hash-generate-your-own>
```

Change `alan` to whatever username you want to log in with, and replace
`<bcrypt-hash-generate-your-own>` with the line you copied. Save and close.

Now tell the dashboard to pick up the change:

```bash
docker compose --profile lan up -d --force-recreate caddy
```

(Use `--force-recreate` here, specifically — a plain `up -d --build` doesn't
reliably notice that only the password file changed and can leave the old
password running. `--force-recreate` guarantees it actually reloads.)

### Step 5 (optional, but recommended) — Load historical prices

This fills in ~90 days of past trader prices immediately, instead of the
dashboard slowly building up history on its own over the next three months:

```bash
docker compose --profile tools run --rm backfill
```

This takes a few minutes and prints a summary line when it's done — safe to
walk away from.

### Step 6 — Trust the security certificate

Because this is a home server, not a public website, the "lock" (HTTPS) it
uses is signed by a certificate your devices don't automatically trust yet —
your browser will warn you the first time. Two ways to handle it:

- **Easiest — just click through the warning.** Most browsers let you click
  "Advanced" → "Proceed anyway" the first time you visit. It'll remember your
  choice for that browser/site after that.
- **Cleaner — install the certificate so the warning never shows.** Get the
  certificate off the server:

  ```bash
  docker exec gw1-prices-caddy-1 cat /data/caddy/pki/authorities/local/root.crt
  ```

  Save that output as a `.crt` file and add it to your device's trusted
  certificates:
  - **Windows:** double-click the file → Install Certificate → Local Machine
    → "Place all certificates in the following store" → Trusted Root
    Certification Authorities.
  - **macOS:** open the file in Keychain Access, then double-click the new
    entry and set Trust to "Always Trust".
  - **Linux:** copy it to `/usr/local/share/ca-certificates/`, then run
    `sudo update-ca-certificates`.
  - **Android/iPhone:** install it as a profile/certificate in Settings.

### Step 7 — Make the address work

The Caddyfile uses the name `utility` by default. Something on your network
needs to know that `utility` means "this server" — pick one:

- **You run a network-wide DNS service (AdGuard Home, Pi-hole, your router's
  admin page):** add a DNS rewrite/entry mapping `utility` to the server's
  address (e.g. `192.168.1.46`). Every device on your network picks this up
  automatically — nothing else to do per-device.
- **No network-wide DNS:** edit the **hosts file** on each device you want to
  use, adding a line like `192.168.1.46 utility`:
  - **Windows:** `C:\Windows\System32\drivers\etc\hosts` (edit with Notepad
    "Run as administrator").
  - **macOS/Linux:** `/etc/hosts` (`sudo nano /etc/hosts`).

Then browse to `https://utility:8787` and log in with the username/password
from Step 4. That's it — you're in.

If you use **Tailscale** (a private network between your devices, reachable
from anywhere, not just home), the Caddyfile also has a Tailscale hostname
placeholder near the top — edit it to match your own tailnet's name for the
server, then repeat Step 6's certificate step and browse to that name instead.

### Updating later

```bash
cd gw1-prices
git pull                                       # or download+unzip a fresh copy
docker compose --profile lan up -d --build
```

This leaves your password alone — it only touches the app itself, not
`Caddyfile`.

### Optional — tracking your inventory when using the server

If you want the server to show what your items are worth, it needs to see
your GWToolbox inventory export — but that file is written on your Windows
gaming PC, not the server. You need to get it from one to the other
automatically. (If this sounds like more setup than you want, [running the
dashboard directly on Windows](#option-2-run-it-on-your-windows-pc) instead
skips this entirely, since there's nothing to transfer.)

The easiest way is **Syncthing** — a free program that keeps a folder
identical on two computers, automatically, in the background:

1. Install Syncthing on both the Windows PC and the Ubuntu server (on
   Ubuntu: `sudo apt-get install -y syncthing`).
2. On Windows, add your GWToolbox `inventories` folder as a shared folder in
   Syncthing, and set its type to **"Send Only"** — this guarantees nothing
   ever gets written back into your Guild Wars files from the server side.
   The folder is here:
   ```
   %USERPROFILE%\Documents\GWToolboxpp\<YOUR-COMPUTER-NAME>\configs\default\inventories
   ```
3. On the server, accept the shared folder Syncthing offers you, pick a
   destination folder (e.g. `/srv/gw1-sync/inventories`), and set its type to
   **"Receive Only"**.
4. Point the dashboard at that folder — either edit the `WATCH_DIR` line in
   `docker-compose.yml` (uncomment the two lines near it and set the path to
   the folder above), or set it directly in the dashboard under **Your
   inventory → watch a folder**, then run
   `docker compose --profile lan up -d --build` again if you edited the file.

Changes on Windows usually show up on the server within a minute. Two other
ways exist for people who don't want to install Syncthing (mounting the
Windows folder directly over the network, or a scheduled copy job) — both
work but need more manual setup; ask if you'd like those steps instead.

---

## Option 2: Run it on your Windows PC

This runs the dashboard directly on the same computer you play Guild Wars
on — no server, no networking to configure, and no syncing, since the
dashboard can read your inventory export straight from disk.

### Step 1 — Download and run the installer

Grab the latest `GW1TradePrices-Setup.exe` — while this project doesn't
publish tagged releases yet, you can get it from the **windows-installer**
job of any green run on the
[Actions page](https://github.com/Inkspot77/gw1-live-trade-prices/actions)
(open a recent "CI" run, scroll to **Artifacts**). Run the downloaded file.

It installs into your own user folder — no administrator prompt — and
bundles its own copy of Node.js, so there is nothing else to install first
and no version to check.

Windows will very likely say **"Windows protected your PC"** the first time
you run it, since the installer isn't code-signed — click **More info → Run
anyway**. See Troubleshooting below.

### Optional — start automatically with Windows

The installer offers a checkbox: **Start GW1 Live Trade Prices when
Windows starts**. Worth turning on — the longer this runs unattended, the
more price history it builds up, and sell alerts only fire while it's
actually running. You can flip this on or off later too, from Windows'
own **Settings → Apps → Startup**.

### Step 2 — Start it

The installer finishes by launching the dashboard for you and opens
`http://127.0.0.1:8787` in your browser. From then on, use the **GW1 Live
Trade Prices** shortcut it put on your desktop (and in the Start menu) to
start it again — no PowerShell, no `npm start`.

### Step 3 — Point it at your inventory

In the dashboard, under **Your inventory → watch a folder**, paste in your
GWToolbox export folder:

```
%USERPROFILE%\Documents\GWToolboxpp\<YOUR-COMPUTER-NAME>\configs\default\inventories
```

(Replace `<YOUR-COMPUTER-NAME>` with your actual PC name — you can see the
real path by opening File Explorer, going to
`Documents\GWToolboxpp`, and looking at the folder names there. `default` is
the name of your GWToolbox config; it'll be different if you've named yours
something else.) The dashboard remembers this setting and picks it up
automatically every time it starts.

### Starting it again later

Use the **GW1 Live Trade Prices** desktop or Start menu shortcut again — or,
if you turned on the startup checkbox above, it's already running by the
time you log in.

### Uninstalling

Uninstalling does **not** delete your accumulated price history.
`data\prices.db` stays behind at
`%LOCALAPPDATA%\GW1TradePrices\data\prices.db` — delete that folder
yourself if you want it gone for good, or keep it and reinstall later to
pick up right where you left off.

---

## Backups

The one thing that can't be re-downloaded if lost is your accumulated price
history — everything else rebuilds itself automatically.

- **Server (Docker):**

  ```bash
  docker run --rm -v gw1-prices_gw1-data:/data -v "$PWD:/backup" alpine \
    tar czf "/backup/gw1-backup-$(date +%F).tar.gz" -C /data .
  ```

  Run this from the project folder; it creates a dated `.tar.gz` file there.

- **Windows:** close the dashboard window first (so nothing is mid-write),
  then copy the whole `data` folder inside the project folder somewhere safe.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `docker compose ps` shows `caddy` as `Restarting` | The password hash in `Caddyfile` is missing or malformed — redo Step 4. Check with `docker compose logs caddy --tail 20`; a line mentioning "base64" confirms it. |
| Changed the password but the old one (or the placeholder) still doesn't work | You need `docker compose --profile lan up -d --force-recreate caddy` specifically — a plain rebuild can leave the old password running. |
| Browser says the site can't be found / name not resolved | The hostname (`utility` or your Tailscale name) isn't set up on that device yet — see Step 7. |
| Certificate warning in the browser | Expected the first time — see Step 6. Click through, or install the certificate to make it stop. |
| `node --version` is older than 22.13 | Reinstall Node.js from nodejs.org, choosing the "Current" download rather than "LTS" if LTS is behind. (Only applies if you're running from source — the Windows installer bundles its own Node, so this doesn't come up there.) |
| Dashboard is empty / shows no prices right after install | Normal for the first ~30 seconds while it does its first check of all price sources. Run the optional backfill step (Option 1, Step 5) for instant history. |
| Inventory never updates (Windows) | Confirm the folder path in Step 3 is exactly right, and that you've logged into Guild Wars and visited an outpost at least once since installing GWToolbox — it only writes the file on zoning into a town/outpost. |
| `(node:xxxx) ExperimentalWarning: SQLite is an experimental feature and might change at any time` on startup | Expected — the dashboard uses Node's built-in SQLite support, which Node itself still labels experimental. Harmless; everything works normally. |
| Windows says "Windows protected your PC" when running the installer | Expected — the installer isn't code-signed. Click **More info → Run anyway**. |
