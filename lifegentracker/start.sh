#!/usr/bin/env bash
# Starts LifegenTracker. If ./node_modules is missing it is restored from vendor-node_modules.tgz
# (or run `npm install` yourself).
cd "$(dirname "$0")"
# Sign-in is ON by default (safe for real church records).
# For a quick open-access preview run:  LIFEGEN_AUTH=off ./start.sh
export LIFEGEN_AUTH="${LIFEGEN_AUTH:-on}"
if [ ! -d node_modules ] && [ -f vendor-node_modules.tgz ]; then tar xzf vendor-node_modules.tgz; fi
exec node server.js
