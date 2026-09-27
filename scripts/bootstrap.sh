#!/data/data/com.termux/files/usr/bin/bash
# Sıfırdan kurulmuş bir Termux'ta paneli hazırlar ve başlatır.
#
#   bash scripts/bootstrap.sh            # temel kurulum + paneli başlat
#   bash scripts/bootstrap.sh --hepsi    # + proot-distro, Debian, geliştirme araçları, Claude Code
#   bash scripts/bootstrap.sh --servis   # + paneli termux-services ile otomatik başlat
#
# Linux ortamı ve diğer bileşenler sonradan panelde "Kurulum" sayfasından da kurulabilir.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ALL=0
SERVICE=0
for a in "$@"; do
  case "$a" in
    --hepsi | --all) ALL=1 ;;
    --servis | --service) SERVICE=1 ;;
    *) echo "Bilinmeyen seçenek: $a" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive
PKG_OPTS=(-y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef)

if [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != *com.termux* ]]; then
  echo "Bu betik Termux içinde çalıştırılmalı (proot-distro içinde değil)." >&2
  exit 1
fi

step "Termux paketleri güncelleniyor"
pkg update -y
pkg upgrade "${PKG_OPTS[@]}"

step "Gerekli araçlar kuruluyor (Node.js, git, derleyici)"
NEED=(git python make clang binutils)
# nodejs ile nodejs-lts çakışır: hangisi kuruluysa ona dokunma
command -v node >/dev/null || NEED+=(nodejs-lts)
pkg install "${PKG_OPTS[@]}" "${NEED[@]}"

# node-pty derlemesi için Termux'ta node-gyp'in beklediği değişken
mkdir -p ~/.gyp
[ -f ~/.gyp/include.gypi ] || echo "{'variables':{'android_ndk_path':''}}" > ~/.gyp/include.gypi

step "Panel bağımlılıkları kuruluyor"
cd "$PANEL_DIR"
if [ -f dist/server/index.js ] && [ -f dist/web/index.html ]; then
  # Derlenmiş sürüm hazır: sadece çalışma zamanı bağımlılıkları yeter
  npm install --omit=dev
else
  npm install
  npm run build
fi

if [ "$ALL" = 1 ]; then
  step "Linux ortamı kuruluyor (proot-distro + Debian)"
  pkg install "${PKG_OPTS[@]}" proot-distro termux-api
  proot-distro list --quiet 2>/dev/null | grep -qx debian || proot-distro install debian
  step "Debian içinde geliştirme araçları ve Claude Code"
  proot-distro login debian --env DEBIAN_FRONTEND=noninteractive -- bash -lc \
    'apt-get update && apt-get install -y git curl ca-certificates build-essential python3 python3-pip python3-venv nodejs npm && npm install -g @anthropic-ai/claude-code'
fi

if [ "$SERVICE" = 1 ]; then
  step "Otomatik başlatma kuruluyor"
  bash "$PANEL_DIR/scripts/install-service.sh"
  exit 0
fi

step "Panel başlatılıyor"
echo "Tarayıcıda aşağıdaki 'Otomatik giriş bağlantısı'nı aç. Kapatmak için Ctrl+C."
exec npm start
