#!/data/data/com.termux/files/usr/bin/bash
# Sıfırdan kurulmuş bir Termux'ta paneli hazırlar ve başlatır.
#
#   bash scripts/bootstrap.sh            # temel kurulum + paneli başlat
#   bash scripts/bootstrap.sh --hepsi    # + geliştirme araçları ve Claude Code (Termux'a, claude-code-android ile)
#   bash scripts/bootstrap.sh --antigravity  # + Antigravity CLI (agy, Termux derlemesi)
#   bash scripts/bootstrap.sh --distro   # + isteğe bağlı: proot-distro ve Debian
#   bash scripts/bootstrap.sh --servis   # + paneli termux-services ile otomatik başlat
#
# Diğer bileşenler sonradan panelde "Kurulum" sayfasından da kurulabilir.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ALL=0
DISTRO=0
AGY=0
SERVICE=0
for a in "$@"; do
  case "$a" in
    --hepsi | --all) ALL=1 ;;
    --distro) DISTRO=1 ;;
    --antigravity | --agy) AGY=1 ;;
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
  step "Geliştirme araçları ve Termux:API"
  pkg install "${PKG_OPTS[@]}" git curl jq python openssh make clang util-linux termux-api
  if [ -x "$PREFIX/bin/claude" ] && [ -d ~/.local/share/claude/versions ]; then
    step "Claude Code zaten kurulu: $(claude --version 2>/dev/null || echo '?')"
  else
    step "Claude Code kuruluyor (claude-code-android)"
    INSTALLER="${TMPDIR:-$PREFIX/tmp}/claude-code-android-install.sh"
    curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh -o "$INSTALLER"
    # Betik iki soru sorar; burada etkileşimli bırakıyoruz, istersen önce: less "$INSTALLER"
    bash "$INSTALLER"
  fi
fi

if [ "$AGY" = 1 ]; then
  if [ -x "$PREFIX/bin/agy" ]; then
    step "Antigravity CLI zaten kurulu: $(agy --version 2>/dev/null || echo '?')"
  else
    step "Antigravity CLI kuruluyor (wallentx/antigravity-cli-termux)"
    [ -x "$PREFIX/glibc/lib/ld-linux-aarch64.so.1" ] || { pkg install "${PKG_OPTS[@]}" glibc-repo && pkg update -y && pkg install "${PKG_OPTS[@]}" glibc; }
    pkg install "${PKG_OPTS[@]}" resolv-conf ca-certificates
    grep -q atomics /proc/cpuinfo || command -v qemu-aarch64 >/dev/null || pkg install "${PKG_OPTS[@]}" qemu-user-aarch64
    INSTALLER="${TMPDIR:-$PREFIX/tmp}/antigravity-termux-install.sh"
    curl -fsSL https://raw.githubusercontent.com/wallentx/antigravity-cli-termux/dev/install.sh -o "$INSTALLER"
    AGY_INSTALL_SKIP_LAUNCH=1 bash "$INSTALLER"
    rm -f "$PREFIX/tmp/antigravity-termux-standalone.tar.gz"
  fi
fi

if [ "$DISTRO" = 1 ]; then
  step "İsteğe bağlı Linux ortamı (proot-distro + Debian)"
  pkg install "${PKG_OPTS[@]}" proot-distro
  proot-distro list --quiet 2>/dev/null | grep -qx debian || proot-distro install debian
fi

if [ "$SERVICE" = 1 ]; then
  step "Otomatik başlatma kuruluyor"
  bash "$PANEL_DIR/scripts/install-service.sh"
  exit 0
fi

step "Panel başlatılıyor"
echo "Tarayıcıda aşağıdaki 'Otomatik giriş bağlantısı'nı aç. Kapatmak için Ctrl+C."
exec npm start
