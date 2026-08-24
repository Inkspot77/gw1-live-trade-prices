#!/usr/bin/env bash
# Check an Ubuntu box can actually run this before you install the service.
# Usage: bash deploy/preflight.sh [watch-folder]
set -uo pipefail

fail=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

echo "Node"
if ! command -v node >/dev/null 2>&1; then
  bad "node is not installed"
else
  version=$(node --version | sed 's/^v//')
  major=${version%%.*}; rest=${version#*.}; minor=${rest%%.*}
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then
    ok "node $version"
  else
    bad "node $version is too old — node:sqlite needs 22.13+ (or 23.4+)"
  fi
  # The real test: the module must load without a flag.
  if node -e "require('node:sqlite')" >/dev/null 2>&1; then
    ok "node:sqlite loads without --experimental-sqlite"
  else
    bad "node:sqlite is unavailable or still flagged on this build"
  fi
fi

echo "Outbound access to the price sources"
for host in kamadan.gwtoolbox.com ascalon.gwtoolbox.com wiki.guildwars.com \
            docs.google.com guildwarslegacy.com; do
  if curl -fsS -m 12 -o /dev/null "https://$host" 2>/dev/null; then
    ok "$host reachable"
  else
    warn "$host unreachable — that source will show a red dot"
  fi
done

echo "Watch folder"
watch=${1:-}
if [ -z "$watch" ]; then
  warn "no folder given; pass one as the first argument to check it"
else
  if [ -d "$watch" ]; then
    ok "$watch exists"
    if [ -r "$watch" ]; then ok "readable"; else bad "not readable by $(whoami)"; fi
    count=$(find "$watch" -maxdepth 1 -name 'tmp*.json' 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
      ok "$count Toolbox export(s) present"
    else
      warn "no tmp<guid>.json yet — sync may not have run, or GW has not been in an outpost"
    fi
    fstype=$(stat -f -c %T "$watch" 2>/dev/null || echo unknown)
    case "$fstype" in
      cifs|smb2|nfs|nfs4)
        warn "filesystem is $fstype — inotify events do not cross it; the 10s stat poll will do the work" ;;
      *) ok "filesystem $fstype supports change events" ;;
    esac
  else
    bad "$watch does not exist"
  fi
fi

echo
[ "$fail" -eq 0 ] && echo "Ready to install the service." || echo "Fix the FAIL lines above first."
exit "$fail"
