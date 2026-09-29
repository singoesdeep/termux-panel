import { isTermux } from './env.js';
import { run } from './exec.js';

/**
 * Android 12+ "phantom process killer": bir uygulamanın arka plandaki alt süreçleri
 * toplamda 32'yi geçince (ya da çok CPU kullanınca) sistem onları SIGKILL ile öldürür.
 * proot + node + claude bu sınıra kolayca takılır; sonuç "[Process completed (signal 9)]".
 * Ayar yalnızca adb (shell kullanıcısı) ile değiştirilebilir.
 */

export interface PhantomStatus {
  /** 'ok': sınır yok ya da kapatılmış · 'warn': açık ya da doğrulanamadı */
  status: 'ok' | 'warn';
  sdk: number | null;
  release: string | null;
  detail: string;
  help: string;
}

const getprop = async (key: string) => (await run('getprop', [key], { timeout: 5000 })).stdout.trim() || null;

async function tryRead(cmd: string, args: string[]) {
  const r = await run(cmd, args, { timeout: 5000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

const HELP_COMMON = `Telefonun kendisinden (bilgisayarsız) yapmak için:
  1. Geliştirici seçenekleri → Kablosuz hata ayıklama'yı aç
  2. Termux'ta: pkg install android-tools
  3. "Eşleme koduyla cihaz eşle" → adb pair 127.0.0.1:<eşleme portu> <kod>
  4. adb connect 127.0.0.1:<bağlantı portu>
  5. Aşağıdaki komutu çalıştır

Ayrıca: Ayarlar → Uygulamalar → Termux → Pil → "Kısıtlanmamış" seç
ve uzun süre çalışacaksa wake lock al (Claude servisi bunu kendisi alır).`;

const CMD_13 = `adb shell "settings put global settings_enable_monitor_phantom_procs false"`;
const CMD_12 = `adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"`;

let cache: { at: number; value: PhantomStatus } | null = null;

export async function phantomStatus(): Promise<PhantomStatus> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = await detect();
  cache = { at: Date.now(), value };
  return value;
}

async function detect(): Promise<PhantomStatus> {
  if (!isTermux) return { status: 'ok', sdk: null, release: null, detail: 'Android dışında', help: '' };
  const [sdkStr, release] = await Promise.all([getprop('ro.build.version.sdk'), getprop('ro.build.version.release')]);
  const sdk = Number(sdkStr) || null;
  if (!sdk || sdk < 31) return { status: 'ok', sdk, release, detail: sdk ? `Android ${release}: bu sınır yok` : 'Android sürümü okunamadı', help: '' };

  const cmd = sdk >= 32 ? CMD_13 : CMD_12;
  const help = `${sdk >= 34 ? 'Android 14+: Geliştirici seçenekleri → "Alt süreç kısıtlamalarını devre dışı bırak" anahtarı da aynı işi yapar.\n\n' : ''}${HELP_COMMON}\n\n${cmd}`;

  // Uygulama kullanıcısı bu ayarları çoğu cihazda okuyamaz; okuyabilirsek doğrularız.
  const monitor = sdk >= 32 ? await tryRead('/system/bin/settings', ['get', 'global', 'settings_enable_monitor_phantom_procs']) : null;
  if (monitor === 'false') return { status: 'ok', sdk, release, detail: `Android ${release}: sınır kapatılmış`, help };
  const max = await tryRead('/system/bin/device_config', ['get', 'activity_manager', 'max_phantom_processes']);
  if (max && Number(max) >= 1000) return { status: 'ok', sdk, release, detail: `Android ${release}: sınır ${max}`, help };

  return {
    status: 'warn',
    sdk,
    release,
    detail:
      monitor === 'true' || (max && Number(max) < 1000)
        ? `Android ${release}: sınır açık`
        : `Android ${release}: durum okunamadı. Ayarı zaten yaptıysan bu uyarıyı yok sayabilirsin.`,
    help,
  };
}
