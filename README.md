# Termux Panel

Termux'u telefondan tarayıcı üzerinden yönetmek için **mobile-first** web paneli.
Backend: Node.js + TypeScript (Fastify, WebSocket) · Frontend: React + TypeScript (Vite) · Terminal: xterm.js + gerçek PTY.

Claude Code ve Antigravity CLI doğrudan Termux'a kurulur; her proje klasöründe uzaktan kontrol oturumu (`claude rc`, `agy --remote-control`) arka plan servisi olarak çalışır, telefondan ya da başka bir cihazdan bağlanırsın. proot-distro desteği isteğe bağlıdır.

Varsayılan olarak yalnızca `127.0.0.1` adresini dinler ve token ile giriş ister.

## Özellikler

| Bölüm | Neler yapılabiliyor |
|---|---|
| **Panel** | CPU / bellek (canlı mini grafik), pil, depolama doluluğu, swap, sistem bilgisi, IP adresleri, hızlı işlemler |
| **Terminal** | Birden çok oturum (sekme), Termux'taki gibi ek tuş satırı (ESC, TAB, CTRL, ALT, oklar, ^C…), yazı boyutu, yapıştır. Oturumlar sunucuda yaşar: sekme arka plana gidip bağlantı kopsa bile geri gelince kaldığın yerden devam eder |
| **Dosyalar** | Gezinme, metin düzenleyici, resim/video/ses önizleme, yükleme (sürükle-bırak dahil), indirme, kopyala/taşı/yeniden adlandır/sil, çoklu seçim, chmod, "burada terminal aç", `.sh/.py/.js` çalıştırma |
| **Paketler** | Kurulu paketler (elle kurulanlar filtresi), arama & kurma, güncellenebilir paketler, `pkg update/upgrade`, autoremove — çıktı canlı akar |
| **Süreçler** | Anlık CPU / bellek, arama, sıralama, SIGTERM / SIGKILL / STOP / CONT |
| **Servisler** | `termux-services` (runit): başlat / durdur / yeniden başlat, otomatik başlatma, loglar |
| **Python & Node** | pip ve global npm paketleri: listele, kur, kaldır, güncellemeleri kontrol et |
| **Kısayollar** | Sık kullanılan komutları kaydet, tek dokunuşla arka planda ya da terminalde çalıştır. Her kısayol Termux'ta ya da bir distroda çalışabilir |
| **Distrolar** | proot-distro: kurulu distrolar, imaj arayıp kurma, yedekle / geri yükle, sıfırla, yeniden adlandır, kaldır, çalışan oturumları görme ve kapatma |
| **Cihaz** | Termux:API: pil, Wi-Fi, fener, titreşim, toast, bildirim, pano, TTS, parlaklık, konum, wake lock |
| **Projeler** | Her proje klasöründe Claude Code (`claude rc`) ve/veya Antigravity (`agy --remote-control`) uzaktan kontrol servisi; başlat-durdur, oturum bağlantısı, canlı log |
| **İşler** | Panelden başlatılan tüm uzun komutlar ve çıktıları |

## Kurulum

[Termux](https://f-droid.org/packages/com.termux/)'u **F-Droid**'den ya da GitHub'dan kur (Play Store sürümü eski ve güncellenmiyor). Sonra Termux'ta tek komut:

```bash
curl -fsSL https://raw.githubusercontent.com/singoesdeep/termux-panel/main/scripts/install.sh | bash
```

Betiğin yaptıkları:
- Termux paketlerini günceller, Node.js'i ve gerekli araçları kurar.
- Panelin hazır derlenmiş son sürümünü [Releases](https://github.com/singoesdeep/termux-panel/releases)'tan indirir; telefonda derleme yapılmaz.
- Paneli `termux-services` ile servis olarak kurup başlatır. Termux'u yeniden başlatman gerekmez; Termux her açıldığında panel kendiliğinden başlar.
- Giriş bağlantısını yazdırır, tarayıcıda açar (Termux:API varsa panoya da kopyalar).

Kurulum klasörü `~/termux-panel`. Aynı komutu tekrar çalıştırmak paneli günceller; ayarlar (`~/.termux-panel`) korunur.

Bağlantı tarayıcıda açılmazsa: `http://127.0.0.1:8088` adresine git ve terminalde yazan token'ı gir. Token'ı sonradan görmek için: `grep token ~/.termux-panel/config.json`. Tarayıcı menüsünden **Ana ekrana ekle** dersen panel uygulama gibi tam ekran açılır.

### Sonraki adımlar

Panelde **Menü → Kurulum** sayfası her bileşenin durumunu gösterir ve tek dokunuşla kurar. Yaygın olanlar **Eksikleri kur** ile tek seferde kurulur; bir adım başarısız olursa iş orada durur ve başarısız olarak işaretlenir.

1. **AI araçları:** Claude Code'u, Antigravity CLI'ı ya da ikisini birden kendi düğmesiyle kur. Kurulumdan sonra her birine bir kez terminalde giriş yapman gerekir: **Projeler** sayfasındaki *Terminalde aç* düğmesi `claude` / `agy`'yi açar. Giriş bağlantısı telefonun tarayıcısında açılır; onayladıktan sonra terminale dön.
2. **Arka plan süreç sınırı (Android 12+):** Android uzun süre çalışan ajan oturumlarını habersizce kapatabilir. Kapatmanın yolu aşağıda ([phantom process killer](#android-12-phantom-process-killer)). **Android 14 ve sonrası:** *Geliştirici seçenekleri → "Alt süreç kısıtlamalarını devre dışı bırak"* anahtarı yeterli, adb gerekmez. Geliştirici seçeneklerini açmak için *Ayarlar → Telefon hakkında → Yapım numarası*'na 7 kez dokun.
3. **Pil:** *Ayarlar → Uygulamalar → Termux → Pil → Kısıtlanmamış* seç. Yoksa Android Termux'u arka planda uyutabilir.
4. **Termux:API (isteğe bağlı):** Pil, bildirim, pano, fener gibi *Cihaz* özellikleri için `termux-api` paketiyle birlikte **Termux:API uygulaması** da gerekir. Termux'u nereden kurduysan oradan kur (F-Droid ya da GitHub; ikisi aynı kaynaktan olmalı, yoksa imzalar uyuşmaz). Uygulama olmadan `termux-api` komutları yanıt vermeden bekler.
5. **Proje ekle:** **Projeler → Proje ekle** ile klasörünü seç ya da orada yeni klasör oluştur, ajanları seç. Başlatınca kartta oturum bağlantısı çıkar; dokunup tarayıcıda aç.

> `node-pty` derlenemezse panel yine çalışır. Terminal, `script` komutuyla (`util-linux`) çalışan yedek moda geçer; bu modda terminal yeniden boyutlandırılamaz. Kurulum sayfasındaki "Yeniden derle" ile tekrar denenebilir.

### Geliştirici kurulumu

Depoyu klonlayıp telefonda derlemek istersen:

```bash
git clone https://github.com/singoesdeep/termux-panel ~/termux-panel && cd ~/termux-panel
bash scripts/bootstrap.sh            # bağımlılıklar + derleme + paneli başlatır
bash scripts/bootstrap.sh --hepsi    # + geliştirme araçları ve Claude Code
bash scripts/bootstrap.sh --antigravity  # + Antigravity CLI (agy)
bash scripts/bootstrap.sh --distro   # + isteğe bağlı: proot-distro ve Debian
bash scripts/bootstrap.sh --servis   # + Termux açılınca panel otomatik başlasın
```

`~/termux-panel` bir git deposuysa tek satırlık kurulum betiği de hazır sürüm yerine `git pull` + derleme yapar.

## proot-distro desteği (isteğe bağlı)

Panel ve Claude Code doğrudan Termux'ta çalışır; proot-distro yalnızca ayrıca bir Linux dağıtımı kullanmak isteyenler içindir. Panel Termux'ta çalışırken kurulu proot-distro container'larını otomatik bulur (hem yeni v5 `containers/` hem eski v4 `installed-rootfs/` düzeni). Distro varsa şu yerlerde bir **ortam seçici** çıkar:

- **Terminal:** `+` ile yeni oturum açarken Termux ya da bir distro seçilir.
- **Paketler:** apt tabanlı distrolarda (Debian, Ubuntu…) kurulu paketler, arama, kurma ve güncelleme.
- **Python & Node:** Distronun içindeki pip ve global npm paketleri.
- **Kısayollar:** Her kısayolun çalışacağı ortam seçilebilir. Örnek: ortamı `debian`, komutu `apt list --upgradable` olan bir kısayol.
- **Dosyalar:** *Konumlar* menüsünde her distronun `/root` klasörü ve kökü var. Bir distronun içindeki klasördeyken "Burada terminal aç" ve betik çalıştırma o distronun içinde çalışır.

Komutlar `proot-distro login <ad> --bind … --work-dir <klasör> -- <komut>` ile çalıştırılır. Bir distro terminal sekmesi kapatıldığında oturumun tüm süreç ağacı `proot-distro kill` ile kapatılır. Distrolar sayfasındaki **Durdur**, o distronun bütün oturumlarını kapatır. Kurulu paket listesi dpkg veritabanından doğrudan okunur, bu yüzden hızlıdır. proot-distro bir proot içinden çalıştırılamadığı için, panel proot içinde çalışırken distro yönetimi kapalıdır.

### Distrolarla ortak klasör

Termux'taki `~/projeler` klasörü varsa her distro oturumuna (terminal, kısayollar, işler) `--bind` ile `/root/projeler` olarak bağlanır. Klasör yoksa bağlama yapılmaz. Başka klasörler için `config.json` içindeki `binds` listesini düzenle:

```json
"binds": [{ "src": "~/projeler", "dst": "/root/projeler" }]
```

## Claude Code

Claude Code doğrudan Termux'ta çalışır. [claude-code-android](https://github.com/ferrumclaudepilgrim/claude-code-android) betiğiyle kurulur: Anthropic'in resmi linux-arm64 sürümü glibc-runner ile yamalanır, `$PREFIX/bin/claude` sarmalayıcısı günde bir kez güncellemeleri kontrol eder. Kurulum sayfasındaki "Claude Code" adımı betiği indirip soruları otomatik yanıtlar (paketler ayrı adımlarda kurulduğu için ikisine de "hayır") ve sonunda `claude --version` ile doğrular. Elle kurmak istersen:

```bash
curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh -o install.sh
less install.sh
bash install.sh
```

## Antigravity CLI

Google'ın terminal ajanı `agy`, [wallentx/antigravity-cli-termux](https://github.com/wallentx/antigravity-cli-termux) derlemesiyle doğrudan Termux'a kurulur (`$PREFIX/bin/agy`, glibc ile çalışır). Kurulum sayfasındaki "Antigravity CLI" adımı önkoşulları (glibc, resolv-conf, gerekirse qemu) kurar, betiği etkileşimsiz çalıştırır ve `agy --version` ile doğrular. Kendini `agy update` ile günceller.

Antigravity'nin resmi arka plan servisi (`agy remote-control start`) systemd ister, Termux'ta yoktur. Panel bunun yerine `agy --remote-control`'ü proje klasöründe runit altında çalıştırır. `agy` ekrana `https://antigravity.google.com/r/<oturum>` bağlantısını basar; panel bunu proje kartında gösterir. antigravity.google.com ana sayfası tek başına bir şey göstermez, oturuma bu bağlantıyla girilir. Mobil uygulama yok (Play Store'daki resmi uygulama şimdilik yalnızca Googlebook OS'ta); telefonda tarayıcıdan kullanılır ve ana ekrana eklenebilir.

Giriş bilgisi D-Bus anahtarlığı olmadığı için `~/.gemini/antigravity-cli/antigravity-oauth-token` dosyasında tutulur; panel giriş yapılıp yapılmadığını buradan anlar.

## Projeler

**Menü → Projeler** sayfasında projeler listelenir. Her proje Termux'ta bir klasördür; içinde Claude Code, Antigravity ya da ikisi birden çalışabilir. Her (proje, ajan) çifti ayrı bir servistir: `claude-rc-<proje>`, `agy-rc-<proje>`. Ajan yalnızca o klasörde çalışır, diğer projelerini görmez.

- **Proje ekle:** Dosya yöneticisi gibi klasörler arasında gezinip var olan bir klasörü seç ya da bulunduğun yerde **Yeni klasör** oluştur. Sonra adı ve ajanları seç.
- *Dosyalar* sayfasında bir klasörün menüsündeki **Proje yap** da aynı işi görür.
- Sonradan projeye diğer ajanı ekleyebilir ya da çıkarabilirsin.
- Home klasörünün kendisi (ya da onu içeren bir üst klasör) proje olamaz.
- Klasör güven onayı ("bu klasöre güveniyor musun?") her iki ajan için otomatik verilir, yalnızca o klasör için: Claude'da `~/.claude.json`, Antigravity'de `~/.gemini/antigravity-cli/settings.json` → `trustedWorkspaces`.
- Servisler panelden bağımsız çalışır: panel yeniden başlasa da sürer, çökerse 10 sn sonra yeniden başlar, çalışırken `termux-wake-lock` alır. "Termux açılınca başlat" her ajan için ayrı açılıp kapatılır.
- Oturum bağlantısı logdan okunup kartta düğme olarak gösterilir: Claude için `https://claude.ai/…`, Antigravity için `https://antigravity.google.com/r/…`. Dokununca tarayıcıda açılır; aynı Google/Claude hesabıyla giriş yapmış olman yeterli. Loglar `$PREFIX/var/log/sv/<servis>/` altında.
- Sahte terminal 200×50 boyutla açılır: `agy`'nin arayüzü 0×0 terminalde hiçbir şey çizmiyor, geniş satır da bağlantının bölünmeden loga düşmesini sağlıyor.
- "Sahte terminal (TTY)" seçeneği komutu `script` ile (`util-linux`) bir pty içinde çalıştırır. Komut ajan ayarlarından değiştirilebilir.
- Projeyi kaldırmak servisleri siler, klasöre dokunmaz. Eski sürümden kalan tek `claude-rc` servisi varsa sayfa onu kaldırmayı önerir.

İlk kez kullanmadan önce her ajan için bir kez terminalden `claude` / `agy` çalıştırıp giriş yap. Sayfadaki **Terminalde aç** düğmeleri bunu yapar.

Servisler, sarmalayıcının `BUN_OPTIONS` değişkenine yazdığı göreli `--preload` yolunu temizleyerek başlar. Bu değişken bir claude oturumundan runit'e sızarsa, başka klasörde açılan `claude` "preload not found" hatasıyla hemen çıkıyor.

### Android 12+ phantom process killer

Android 12 ve sonrası, Termux'un arka plandaki alt süreçlerini habersizce öldürebilir ("Process completed (signal 9)"). Uzun süre çalışan `claude rc` için bu sınırı bir kez adb ile kapat. Telefonun kendisinden yapmak için: Kablosuz hata ayıklama + `pkg install android-tools`. Kurulum sayfası durumu gösterir ve adımları listeler:

```bash
# Android 12L / 13+
adb shell "settings put global settings_enable_monitor_phantom_procs false"
# Android 12
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"
```

## Arka planda sürekli çalıştırma

```bash
bash scripts/install-service.sh
```

Tek satırlık kurulum bunu zaten yapar. Betik `termux-services` paketini kurar, servis yöneticisini (runsvdir) çalışmıyorsa başlatır (Termux'u yeniden başlatmak gerekmez), gerekirse projeyi derler ve paneli servis olarak ekleyip başlatır; panel zaten servisse yeniden başlatır. Panel o sırada elle çalışıyorsa (`npm start`), onu kapattığında servis birkaç saniye içinde devralır. Android'in Termux'u uyutmasını önlemek için bildirimden **Acquire wakelock**'a dokun ya da panelde *Cihaz → Wake lock al* seçeneğini kullan. Telefon açılınca otomatik başlasın istiyorsan **Termux:Boot** uygulamasını kullanabilirsin.

## Ayarlar

İlk çalıştırmada `~/.termux-panel/config.json` oluşturulur:

```json
{ "host": "127.0.0.1", "port": 8088, "token": "…", "auth": true, "snippets": [ … ], "binds": [ … ], "claudeRc": { … } }
```

Ortam değişkenleri dosyadaki değerleri geçersiz kılar:

| Değişken | Açıklama |
|---|---|
| `TP_PORT` | Port (varsayılan 8088) |
| `TP_HOST` | Dinlenecek adres. `0.0.0.0` → aynı Wi-Fi'daki cihazlardan erişim (**dikkat: panel tam kabuk erişimi verir**) |
| `TP_TOKEN` | Token'ı geçici olarak değiştir |
| `TP_NO_AUTH=1` | Girişi kapat (önerilmez; telefondaki diğer uygulamalar da localhost'a erişebilir) |
| `TP_CONFIG_DIR` | Ayar klasörü |

Token'ı yenilemek için `config.json` içindeki `token` satırını sil ve paneli yeniden başlat.

## Güvenlik notları

- Panel, çalıştığı kullanıcının tüm yetkilerine sahiptir (dosyalar, komutlar). Token'ı paylaşma.
- Oturum çerezi `HttpOnly` + `SameSite=Strict`. Bu sayede başka sitelerden panele istek atılamaz.
- DNS rebinding'e karşı yalnızca `localhost` ya da IP adresi ile gelen isteklere yanıt verilir.
- Paket adları ve pip/npm girdileri doğrulanır, komutlar kabuk üzerinden değil doğrudan argümanla çalıştırılır. Kabuk komutu yalnızca Kısayollar ve "komut çalıştır" gibi bilerek kabuk kullanan yerlerde çalışır.

## Geliştirme

```bash
npm run dev        # backend (tsx watch, :8088) + Vite (:5173, /api ve /ws proxy)
npm run typecheck
npm run build
npm run pack       # derle + release/termux-panel.tar.gz (hazır sürüm paketi)
```

Yeni sürüm yayınlamak: `package.json`'daki sürümü artır, commit'le ve `v<sürüm>` etiketini gönder (`git tag v0.2.0 && git push --tags`). GitHub Actions paneli derleyip paketi Releases'a yükler; kurulum betiği her zaman en son sürümü indirir.

```
server/src/
  index.ts          Fastify, auth, statik dosyalar
  terminal.ts       PTY oturumları (node-pty → script → pipe yedekleri)
  targets.ts        Ortamlar: Termux ya da proot-distro container'ı, komut sarmalama, ortak klasörler
  android.ts        Android sürümü, phantom process killer kontrolü
  jobs.ts           Uzun süren komutlar + WebSocket ile canlı çıktı
  routes/           system, files, packages, processes, services, devtools, device, distros, setup, projects, misc
web/src/
  App.tsx           Giriş ekranı, gezinme (mobilde alt bar, geniş ekranda yan menü)
  store.tsx         Toast, onay/soru diyalogları, iş takibi
  pages/            Her bölüm bir sayfa
```

Not: `rollup` bağımlılığı `@rollup/wasm-node` ile değiştirildi. Rollup'ın yerel (native) modülü bazı Android/proot ortamlarında "Bus error" ile çöküyor. WASM sürümü her yerde çalışıyor.
