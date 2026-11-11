#!/bin/bash
# Installs Trellis on Ubuntu, Kubuntu or Debian (x86-64) from its apt repository, so `sudo apt upgrade` updates it:
#   curl -fsSL https://raw.githubusercontent.com/therealtoresto/trellis/main/scripts/install-linux.sh | bash
# The repository is published with every release; its files are signed with the key it adds here.
set -euo pipefail

REPO=https://github.com/therealtoresto/trellis/releases/latest/download
KEY=/usr/share/keyrings/trellis.gpg
LIST=/etc/apt/sources.list.d/trellis.list

[ "$(dpkg --print-architecture)" = amd64 ] || { echo "Trellis is built for x86-64 (amd64) only."; exit 1; }
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)

echo "Adding the Trellis apt repository…"
curl -fsSL "$REPO/trellis.gpg" | $SUDO tee "$KEY" > /dev/null
echo "deb [signed-by=$KEY] $REPO ./" | $SUDO tee "$LIST" > /dev/null
$SUDO apt-get update
$SUDO apt-get install -y trellis
echo "Trellis is installed. It updates with sudo apt upgrade, or from the app."
