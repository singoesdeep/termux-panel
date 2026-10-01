#!/data/data/com.termux/files/usr/bin/bash
# Termux Panel'i termux-services ile arka plan servisi olarak kurar ve başlatır.
# Termux açıldığında panel kendiliğinden başlar. Panel zaten servisse yeniden başlatır
# (güncellemeden sonra yeni sürüm devreye girsin).
# Kullanım: bash scripts/install-service.sh
set -e
PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SVDIR="${SVDIR:-$PREFIX/var/service}"
NAME=termux-panel

if ! command -v sv >/dev/null; then
  echo "termux-services kuruluyor..."
  pkg install -y termux-services </dev/null
fi

# termux-services, servis yöneticisini (runsvdir) Termux oturumu açılırken başlatır. Paket
# yeni kurulduysa Termux'u yeniden başlatmak yerine burada başlat.
if ! pgrep -x runsvdir >/dev/null; then
  echo "Servis yöneticisi başlatılıyor..."
  service-daemon start >/dev/null
  sleep 1
fi

[ -f "$PANEL_DIR/dist/server/index.js" ] || (cd "$PANEL_DIR" && npm run build)

DIR="$SVDIR/$NAME"
mkdir -p "$DIR/log"
cat > "$DIR/run" <<RUN
#!$PREFIX/bin/sh
cd "$PANEL_DIR"
export TP_SERVICE=1
exec node dist/server/index.js 2>&1
RUN
cat > "$DIR/log/run" <<LOG
#!$PREFIX/bin/sh
mkdir -p "$PREFIX/var/log/sv/$NAME"
exec svlogd -tt "$PREFIX/var/log/sv/$NAME"
LOG
chmod +x "$DIR/run" "$DIR/log/run"
# Termux açılınca başlasın
rm -f "$DIR/down"

# runsvdir yeni servisi birkaç saniye içinde fark eder
for _ in $(seq 1 40); do
  [ -e "$DIR/supervise/ok" ] && break
  sleep 0.25
done
[ -e "$DIR/supervise/ok" ] || { echo "Servis yöneticisi servisi görmedi. Termux'u kapatıp açtıktan sonra tekrar dene." >&2; exit 1; }

# Elle (npm start) çalışan bir panel portu tutuyorsa servis başlayamaz
if pgrep -f "node dist/server/index.js" >/dev/null && ! sv status "$NAME" | grep -q '^run:'; then
  echo "Not: Elle başlatılmış bir panel çalışıyor görünüyor. Onu kapat (Ctrl+C); servis birkaç saniye içinde devralır."
fi

if sv status "$NAME" | grep -q '^run:'; then
  sv restart "$NAME" >/dev/null
else
  sv up "$NAME"
fi
sleep 2
echo "Servis: $(sv status "$NAME")"
