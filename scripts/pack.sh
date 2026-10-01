#!/usr/bin/env bash
# Hazır sürüm paketi: derlenmiş panel (dist) + çalışma zamanı için gerekenler.
# Telefonda yalnızca `npm install --omit=dev` çalışır, derleme yapılmaz.
#   npm run build && bash scripts/pack.sh   → release/termux-panel.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/server/index.js ] && [ -f dist/web/index.html ] || { echo "Önce: npm run build" >&2; exit 1; }
rm -rf release && mkdir -p release/stage
cp -r dist bin scripts package.json package-lock.json README.md release/stage/
tar -czf release/termux-panel.tar.gz -C release/stage .
rm -rf release/stage
echo "release/termux-panel.tar.gz ($(du -h release/termux-panel.tar.gz | cut -f1))"
