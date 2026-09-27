#!/data/data/com.termux/files/usr/bin/bash
# Termux Panel'i termux-services ile arka plan servisi olarak kurar.
# Kullanım: bash scripts/install-service.sh
set -e
PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SVDIR="${SVDIR:-$PREFIX/var/service}"

if ! command -v sv >/dev/null; then
  echo "termux-services kurulu değil. Kuruluyor..."
  pkg install -y termux-services
  echo "Kurulum bitti. Termux'u tamamen kapatıp yeniden aç, sonra bu betiği tekrar çalıştır."
  exit 0
fi

[ -f "$PANEL_DIR/dist/server/index.js" ] || (cd "$PANEL_DIR" && npm run build)

mkdir -p "$SVDIR/termux-panel/log"
cat > "$SVDIR/termux-panel/run" <<RUN
#!/data/data/com.termux/files/usr/bin/sh
cd "$PANEL_DIR"
export TP_SERVICE=1
exec node dist/server/index.js 2>&1
RUN
cat > "$SVDIR/termux-panel/log/run" <<'LOG'
#!/data/data/com.termux/files/usr/bin/sh
mkdir -p "$PREFIX/var/log/sv/termux-panel"
exec svlogd -tt "$PREFIX/var/log/sv/termux-panel"
LOG
chmod +x "$SVDIR/termux-panel/run" "$SVDIR/termux-panel/log/run"

sv-enable termux-panel 2>/dev/null || true
sleep 2
sv up termux-panel
echo "Servis kuruldu. Durum: $(sv status termux-panel)"
echo "Not: Paneli elle (npm start) çalıştırıyorsan onu kapat; servis birkaç saniye içinde devralır."
echo "Token: $(grep -o '"token": *"[^"]*"' ~/.termux-panel/config.json | cut -d'"' -f4)"
