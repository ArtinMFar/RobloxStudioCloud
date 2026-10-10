#!/usr/bin/env bash
# Installs Google Chrome, which Studio's "Sign in" button opens (vm/open_url.sh).
# Run in the background once the stream is up, so it does not hold up the start.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
for _ in $(seq 60); do [ -f /content/dl/chrome.deb ] && break; sleep 2; done
apt-get install -y -qq /content/dl/chrome.deb && touch /content/dl/chrome.ok
echo "BROWSER_DONE"
