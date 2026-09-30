# Termux Panel

Termux'u telefondan tarayıcı üzerinden yönetmek için **mobile-first** web paneli.
Backend: Node.js + TypeScript (Fastify, WebSocket) · Frontend: React + TypeScript (Vite) · Terminal: xterm.js + gerçek PTY.

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
| **Claude** | `claude rc` (Remote Control) servisi: Termux'ta klasör seçimi, başlat-durdur, oturum bağlantısı, canlı log |
| **İşler** | Panelden başlatılan tüm uzun komutlar ve çıktıları |

## Kurulum (sıfırdan Termux)

Proje klasörünü Termux'a kopyaladıktan sonra:

```bash
cd ~/termux-panel
bash scripts/bootstrap.sh            # temel kurulum + paneli başlatır
bash scripts/bootstrap.sh --hepsi    # + geliştirme araçları ve Claude Code (Termux'a)
bash scripts/bootstrap.sh --distro   # + isteğe bağlı: proot-distro ve Debian
bash scripts/bootstrap.sh --servis   # + Termux açılınca panel otomatik başlasın
```

Betik Termux paketlerini günceller; Node.js, git ve derleyiciyi kurar (Node zaten kuruluysa dokunmaz); node-pty için gereken ayarı yapar ve paneli başlatır. Terminalde şöyle bir çıktı görürsün:

```
  Termux Panel çalışıyor → http://127.0.0.1:8088
  Otomatik giriş bağlantısı: http://127.0.0.1:8088/?token=XXXX
```

Bağlantıyı telefonun tarayıcısında aç. Tarayıcı menüsünden **Ana ekrana ekle** dersen uygulama gibi tam ekran açılır.

Geri kalan her şey panelde **Menü → Kurulum** sayfasından yapılabilir. Orada her bileşenin durumu görünür: depolama izni, Termux:API, termux-services, node-pty, otomatik başlatma, proje klasörü, geliştirme araçları, Claude Code ve isteğe bağlı olarak proot-distro / Debian. Bileşenler tek tek ya da **Eksikleri kur** ile tek seferde, canlı çıktıyla kurulur. Toplu kurulumda bir adım başarısız olursa iş orada durur ve başarısız olarak işaretlenir. Kurulum tamamlanmadıysa ana ekranda bir uyarı çıkar.

> `node-pty` derlenemezse panel yine çalışır. Terminal, `script` komutuyla (`pkg install util-linux`) çalışan yedek moda geçer; bu modda terminal yeniden boyutlandırılamaz. Kurulum sayfasındaki "Yeniden derle" ile tekrar denenebilir.

## proot-distro desteği (isteğe bağlı)

Panel ve Claude Code doğrudan Termux'ta çalışır; proot-distro yalnızca ayrıca bir Linux dağıtımı kullanmak isteyenler içindir. Panel Termux'ta çalışırken kurulu proot-distro container'larını otomatik bulur (hem yeni v5 `containers/` hem eski v4 `installed-rootfs/` düzeni). Distro varsa şu yerlerde bir **ortam seçici** çıkar:

- **Terminal:** `+` ile yeni oturum açarken Termux ya da bir distro seçilir.
- **Paketler:** apt tabanlı distrolarda (Debian, Ubuntu…) kurulu paketler, arama, kurma ve güncelleme.
- **Python & Node:** Distronun içindeki pip ve global npm paketleri.
- **Kısayollar:** Her kısayolun çalışacağı ortam seçilebilir. Örnek: ortamı `debian`, komutu `apt list --upgradable` olan bir kısayol.
- **Dosyalar:** *Konumlar* menüsünde her distronun `/root` klasörü ve kökü var. Bir distronun içindeki klasördeyken "Burada terminal aç" ve betik çalıştırma o distronun içinde çalışır.

Komutlar `proot-distro login <ad> --bind … --work-dir <klasör> -- <komut>` ile çalıştırılır. Bir distro terminal sekmesi kapatıldığında oturumun tüm süreç ağacı `proot-distro kill` ile kapatılır. Distrolar sayfasındaki **Durdur**, o distronun bütün oturumlarını kapatır. Kurulu paket listesi dpkg veritabanından doğrudan okunur, bu yüzden hızlıdır. proot-distro bir proot içinden çalıştırılamadığı için, panel proot içinde çalışırken distro yönetimi kapalıdır.

### Ortak proje klasörü

Termux'taki `~/projeler` klasörü Claude servisinin varsayılan çalışma klasörüdür ve her distro oturumuna (terminal, kısayollar, işler) `--bind` ile `/root/projeler` olarak bağlanır. Böylece aynı projeler distrolardan da görünür. Klasör yoksa bağlama yapılmaz; *Kurulum* sayfasındaki "Proje klasörü" adımı onu oluşturur. Başka klasörler için `config.json` içindeki `binds` listesini düzenle:

```json
"binds": [{ "src": "~/projeler", "dst": "/root/projeler" }]
```

## Claude Code (Remote Control)

Claude Code doğrudan Termux'ta çalışır. [claude-code-android](https://github.com/ferrumclaudepilgrim/claude-code-android) betiğiyle kurulur: Anthropic'in resmi linux-arm64 sürümü glibc-runner ile yamalanır, `$PREFIX/bin/claude` sarmalayıcısı günde bir kez güncellemeleri kontrol eder. Kurulum sayfasındaki "Claude Code" adımı betiği indirip soruları otomatik yanıtlar (paketler ayrı adımlarda kurulduğu için ikisine de "hayır") ve sonunda `claude --version` ile doğrular. Elle kurmak istersen:

```bash
curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh -o install.sh
less install.sh
bash install.sh
```

**Menü → Claude** sayfası `claude rc` komutunu termux-services (runit) ile bir servis olarak kurar:

- Panelden bağımsız çalışır. Panel yeniden başlasa da sürer, çökerse 10 sn sonra yeniden başlar.
- Çalışırken `termux-wake-lock` alır.
- Oturum bağlantısı (`https://claude.ai/…`) logdan okunup sayfada gösterilir.
- Loglar `$PREFIX/var/log/sv/claude-rc/` altında tutulur.
- "Sahte terminal (TTY)" seçeneği komutu `script` ile (`util-linux`) bir pty içinde çalıştırır.
- Eski sürümde distro içinde kurulmuş bir servis varsa sayfa bunu gösterir; **Kaydet ve yeniden başlat** onu Termux'a taşır.

İlk kez kullanmadan önce bir kez terminalden `claude` çalıştırıp giriş yap ve klasöre güven. Sayfadaki **Terminalde aç** düğmesi bunu yapar.

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

Betik `termux-services` paketini kurar, gerekirse projeyi derler ve paneli servis olarak ekleyip başlatır. İlk kurulumdan sonra Termux'u bir kez kapatıp açman gerekir. Panel o sırada elle çalışıyorsa (`npm start`), onu kapattığında servis birkaç saniye içinde devralır. Android'in Termux'u uyutmasını önlemek için bildirimden **Acquire wakelock**'a dokun ya da panelde *Cihaz → Wake lock al* seçeneğini kullan. Telefon açılınca otomatik başlasın istiyorsan **Termux:Boot** uygulamasını kullanabilirsin.

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
```

```
server/src/
  index.ts          Fastify, auth, statik dosyalar
  terminal.ts       PTY oturumları (node-pty → script → pipe yedekleri)
  targets.ts        Ortamlar: Termux ya da proot-distro container'ı, komut sarmalama, ortak klasörler
  android.ts        Android sürümü, phantom process killer kontrolü
  jobs.ts           Uzun süren komutlar + WebSocket ile canlı çıktı
  routes/           system, files, packages, processes, services, devtools, device, distros, setup, claude, misc
web/src/
  App.tsx           Giriş ekranı, gezinme (mobilde alt bar, geniş ekranda yan menü)
  store.tsx         Toast, onay/soru diyalogları, iş takibi
  pages/            Her bölüm bir sayfa
```

Not: `rollup` bağımlılığı `@rollup/wasm-node` ile değiştirildi. Rollup'ın yerel (native) modülü bazı Android/proot ortamlarında "Bus error" ile çöküyor. WASM sürümü her yerde çalışıyor.
