#!/data/data/com.termux/files/usr/bin/bash
# Termux Panel: tek satırlık kurulum / güncelleme
#
#   curl -fsSL https://raw.githubusercontent.com/singoesdeep/termux-panel/main/scripts/install.sh | bash
#
# Hazır derlenmiş sürümü (GitHub Releases) indirir; telefonda derleme yapılmaz. Sürüm
# bulunamazsa depoyu klonlayıp derler. Paneli termux-services ile servis olarak kurar ve
# başlatır (Termux'u yeniden başlatmak gerekmez), sonunda giriş bağlantısını açar.
# Tekrar çalıştırmak paneli günceller; ayarlar (~/.termux-panel) korunur.
#
# Ortam değişkenleri: TP_DIR (kurulum klasörü, varsayılan ~/termux-panel), TP_REPO,
# TP_NO_SERVICE=1 (servisi kurma/başlatma; deneme kurulumları için)
set -euo pipefail

REPO="${TP_REPO:-singoesdeep/termux-panel}"
DIR="${TP_DIR:-$HOME/termux-panel}"
ASSET_URL="https://github.com/$REPO/releases/latest/download/termux-panel.tar.gz"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[0;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[!]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[0;31m[hata]\033[0m %s\n' "$*" >&2
  exit 1
}

main() {
  # `curl | bash` ile çalışırken stdin betiğin kendisi: hiçbir komut onu okumasın
  exec </dev/null

  if [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != *com.termux* ]]; then
    die "Bu betik Termux içinde çalıştırılmalı (proot-distro içinde değil)."
  fi

  export DEBIAN_FRONTEND=noninteractive
  local PKG_OPTS=(-y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef)

  # Yeni Termux'ta ayna seçilmemişse pkg etkileşimli soru sorabiliyor: varsayılanı seç
  if [ ! -e "$PREFIX/etc/termux/chosen_mirrors" ] && [ -e "$PREFIX/etc/termux/mirrors/default" ]; then
    ln -sf "$PREFIX/etc/termux/mirrors/default" "$PREFIX/etc/termux/chosen_mirrors" 2>/dev/null || true
  fi

  step "Termux paketleri güncelleniyor"
  pkg update -y
  pkg upgrade "${PKG_OPTS[@]}"

  step "Gerekli paketler kuruluyor"
  # util-linux: terminal yedek modu (script); python/make/clang: node-pty derlemesi
  local NEED=(curl tar git termux-services termux-tools util-linux python make clang binutils)
  # nodejs ile nodejs-lts çakışır: hangisi kuruluysa ona dokunma
  command -v node >/dev/null || NEED+=(nodejs-lts)
  pkg install "${PKG_OPTS[@]}" "${NEED[@]}"

  step "Panel indiriliyor"
  local TMP="${TMPDIR:-$PREFIX/tmp}/termux-panel-$$"
  rm -rf "$TMP" && mkdir -p "$TMP"
  if [ -d "$DIR/.git" ]; then
    # Geliştirici kurulumu: depoyu güncelle ve derle
    warn "$DIR bir git deposu: hazır sürüm yerine git pull + derleme yapılıyor"
    git -C "$DIR" pull --ff-only
    (cd "$DIR" && npm install && npm run build)
  elif curl -fsSL "$ASSET_URL" -o "$TMP/panel.tar.gz"; then
    mkdir -p "$TMP/app"
    tar -xzf "$TMP/panel.tar.gz" -C "$TMP/app"
    [ -f "$TMP/app/dist/server/index.js" ] || die "İndirilen paket bozuk görünüyor"
    if [ -d "$DIR" ]; then
      # Güncelleme: kurulu node_modules'u koru (yeniden derleme gerekmesin), uygulama dosyalarını değiştir
      [ -d "$DIR/node_modules" ] && mv "$DIR/node_modules" "$TMP/app/"
      rm -rf "$DIR.eski" && mv "$DIR" "$DIR.eski"
    fi
    mv "$TMP/app" "$DIR"
    rm -rf "$DIR.eski"
    ok "Sürüm $(node -p "require('$DIR/package.json').version")"
  else
    warn "Hazır sürüm indirilemedi; depo klonlanıp telefonda derleniyor (birkaç dakika sürer)"
    git clone --depth 1 "https://github.com/$REPO.git" "$DIR"
    (cd "$DIR" && npm install && npm run build)
  fi
  rm -rf "$TMP"

  step "Çalışma zamanı bağımlılıkları kuruluyor"
  cd "$DIR"
  # node-pty derlemesi için Termux'ta node-gyp'in beklediği değişken
  mkdir -p ~/.gyp
  [ -f ~/.gyp/include.gypi ] || echo "{'variables':{'android_ndk_path':''}}" > ~/.gyp/include.gypi
  if [ ! -d .git ]; then
    npm install --omit=dev --no-audit --no-fund
  fi
  if node -e "require('node-pty')" 2>/dev/null; then
    ok "Tam terminal desteği (node-pty) hazır"
  else
    warn "node-pty derlenemedi: terminal yedek modda çalışır. Panelde Kurulum → node-pty ile tekrar denenebilir."
  fi

  if [ "${TP_NO_SERVICE:-0}" = 1 ]; then
    warn "TP_NO_SERVICE=1: servis kurulmadı. Başlatmak için: cd $DIR && npm start"
  else
    step "Servis kuruluyor"
    bash "$DIR/scripts/install-service.sh"
  fi

  local CFG="$HOME/.termux-panel/config.json" TOKEN="" PORT=8088
  for _ in $(seq 1 20); do
    [ -f "$CFG" ] && break
    sleep 0.5
  done
  if [ -f "$CFG" ]; then
    TOKEN=$(node -p "require('$CFG').token")
    PORT=$(node -p "require('$CFG').port || 8088")
  fi
  local URL="http://127.0.0.1:$PORT/?token=$TOKEN"

  printf '\n\033[1;32mTermux Panel hazır.\033[0m\n\n  Giriş bağlantısı: %s\n\n' "$URL"
  echo "  Termux açıldığında panel kendiliğinden başlar. Kapatmak: sv down termux-panel"
  echo "  Güncellemek için bu komutu tekrar çalıştır."
  echo
  # Termux:API uygulaması yoksa termux-api komutları takılı kalır: süre sınırı
  command -v termux-clipboard-set >/dev/null && timeout 5 termux-clipboard-set "$URL" 2>/dev/null && echo "  (Bağlantı panoya kopyalandı)"
  command -v termux-open-url >/dev/null && termux-open-url "$URL" 2>/dev/null || true
}

main "$@"
exit
