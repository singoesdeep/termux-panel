import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { HOME, PREFIX, isTermux } from '../env.js';
import { HttpError, run } from '../exec.js';
import { startShellJob } from '../jobs.js';
import { PD_BIN, listDistros, pdStatus } from '../targets.js';
import { ptyBackend } from '../terminal.js';

/**
 * Kurulum sihirbazı: sıfırdan bir Termux'u AI destekli geliştirmeye hazır hale getiren
 * bileşenlerin durumu ve tek dokunuşla kurulumu. Tüm işlemler Termux kabuğunda
 * birer komut satırı olarak çalışır; "Eksikleri kur" bunları tek bir işte birleştirir.
 */

const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_DISTRO = 'debian';
/** Claude Code'un Termux'ta rahat çalışması için gereken araçlar (Bash aracı git, jq, python… bekler) */
const DEV_PKGS = ['git', 'curl', 'jq', 'python', 'openssh', 'make', 'clang', 'util-linux'];

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const PKG_INSTALL = 'DEBIAN_FRONTEND=noninteractive pkg install -y -o Dpkg::Options::=--force-confold';

type Status = 'ok' | 'missing' | 'warn' | 'blocked';

interface Item {
  id: string;
  group: 'termux' | 'ai' | 'linux';
  title: string;
  desc: string;
  status: Status;
  detail?: string;
  /** Termux kabuğunda çalışacak komut; yoksa işlem yok */
  command?: string;
  actionLabel?: string;
  /** "Eksikleri kur" toplu kurulumuna dahil mi */
  inBulk?: boolean;
  /** Elle yapılacak adımlar (çok satırlı, komutlar içerebilir) */
  help?: string;
}

async function termuxInstalled(): Promise<Set<string>> {
  try {
    const status = await fsp.readFile(path.join(isTermux ? PREFIX : '/', 'var/lib/dpkg/status'), 'utf8');
    const out = new Set<string>();
    for (const block of status.split('\n\n')) {
      const name = /^Package: (.+)$/m.exec(block)?.[1];
      if (name && /^Status: .* installed$/m.test(block)) out.add(name);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Claude Code, claude-code-android betiğiyle doğrudan Termux'a kurulur: resmi linux-arm64
 * ikili dosyası glibc-runner ile yamalanır, $PREFIX/bin/claude bir sarmalayıcıdır.
 * Betik iki soru sorar (Termux yeni mi? önerilen paketler?); ikisine de "hayır" verilir:
 * paketler zaten güncellendi ve geliştirme araçları ayrı bir adımda kuruluyor.
 * Betik bazı durumlarda (eski npm kurulumu, bu cihazda çalışmayan sürüm) 0 ile çıkar;
 * bu yüzden sonuç ayrıca doğrulanır.
 */
const CLAUDE_INSTALL_URL = 'https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh';
const claudeInstallCmd = () => {
  const f = '"${TMPDIR:-$PREFIX/tmp}/claude-code-android-install.sh"';
  const log = '"${TMPDIR:-$PREFIX/tmp}/claude-code-android-install.log"';
  return [
    `curl -fsSL ${shq(CLAUDE_INSTALL_URL)} -o ${f}`,
    // İç içe claude oturumu uyarısı (etkileşimli soru) çıkmasın
    'unset CLAUDECODE CLAUDE_CODE_EXECPATH',
    `printf 'n\\nn\\n' | bash ${f} 2>&1 | tee ${log}`,
    `rc=\${PIPESTATUS[1]}`,
    `[ "$rc" = 0 ] || { echo; echo "Kurulum betiği hata verdi (çıkış kodu $rc)"; exit "$rc"; }`,
    `if grep -q 'cannot run on this device' ${log}; then echo; echo "Bu Claude Code sürümü bu Android sürümünde çalışmıyor. Sabitlenmiş sürüm için Termux'ta:"; echo '  curl -fsSL https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install-pinned.sh -o install-pinned.sh && bash install-pinned.sh'; exit 1; fi`,
    `if grep -q 'older pinned v2.x install' ${log}; then echo; echo "Eski (npm) Claude Code kurulumu bulundu. Yukarıdaki migrate.sh komutlarını Termux'ta çalıştır."; exit 1; fi`,
    `"$PREFIX/bin/claude" --version || { echo 'claude çalıştırılamadı'; exit 1; }`,
  ].join('\n');
};

/** Termux'taki Claude Code kurulumu: sarmalayıcı + indirilmiş sürümler */
export function claudeState(): { installed: boolean; npm: boolean; version: string | null; loggedIn: boolean } {
  const bin = path.join(PREFIX, 'bin/claude');
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(path.join(HOME, '.local/share/claude/versions')).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  } catch {
    /* yok */
  }
  const npm = fs.existsSync(path.join(PREFIX, 'lib/node_modules/@anthropic-ai/claude-code'));
  const isFile = (() => {
    try {
      return fs.lstatSync(bin).isFile();
    } catch {
      return false;
    }
  })();
  const sorted = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    installed: isFile && versions.length > 0,
    npm,
    version: sorted.at(-1) ?? null,
    loggedIn: fs.existsSync(path.join(HOME, '.claude/.credentials.json')),
  };
}

/**
 * Antigravity CLI (agy): Google'ın linux-arm64 sürümünün Termux derlemesi. Betik $PREFIX/bin'e
 * agy (yükleyici) ve agy.va39 (glibc ile çalışan ikili) koyar; sonunda agy'yi başlatmak ister,
 * AGY_INSTALL_SKIP_LAUNCH ile bu atlanır. Önkoşullar (glibc, resolv-conf, LSE yoksa qemu)
 * betik hata vermeden önce kurulur.
 */
const AGY_INSTALL_URL = 'https://raw.githubusercontent.com/wallentx/antigravity-cli-termux/dev/install.sh';
const agyInstallCmd = () => {
  const f = '"${TMPDIR:-$PREFIX/tmp}/antigravity-termux-install.sh"';
  return [
    `[ -x "$PREFIX/glibc/lib/ld-linux-aarch64.so.1" ] || { ${PKG_INSTALL} glibc-repo && pkg update -y && ${PKG_INSTALL} glibc; } || exit 1`,
    `[ -r "$PREFIX/etc/resolv.conf" ] && [ -s "$PREFIX/etc/tls/cert.pem" ] || ${PKG_INSTALL} resolv-conf ca-certificates || exit 1`,
    `grep -q atomics /proc/cpuinfo || command -v qemu-aarch64 >/dev/null || ${PKG_INSTALL} qemu-user-aarch64 || exit 1`,
    `curl -fsSL ${shq(AGY_INSTALL_URL)} -o ${f} || exit 1`,
    // İlerleme çubuğu \r ile aynı satırı yeniler; iş çıktısında yüzlerce satır olmasın
    `AGY_INSTALL_SKIP_LAUNCH=1 bash ${f} </dev/null 2>&1 | tr '\\r' '\\n' | grep --line-buffered -v '%.*M /'`,
    `rc=\${PIPESTATUS[0]}`,
    `[ "$rc" = 0 ] || { echo; echo "Kurulum betiği hata verdi (çıkış kodu $rc)"; exit "$rc"; }`,
    // Betik indirilen arşivi (~55 MB) bırakıyor
    'rm -f "$PREFIX/tmp/antigravity-termux-standalone.tar.gz"',
    `"$PREFIX/bin/agy" --version || { echo 'agy çalıştırılamadı'; exit 1; }`,
  ].join('\n');
};

let agyVersion: { mtime: number; version: string | null } | null = null;

/** Termux'taki Antigravity CLI kurulumu */
export async function agyState(): Promise<{ installed: boolean; version: string | null }> {
  const bin = path.join(PREFIX, 'bin/agy');
  const st = await fsp.stat(path.join(PREFIX, 'bin/agy.va39')).catch(() => null);
  if (!st || !fs.existsSync(bin)) return { installed: false, version: null };
  if (agyVersion?.mtime !== st.mtimeMs) {
    const r = await run(bin, ['--version'], { timeout: 10000, env: { HOME } });
    agyVersion = { mtime: st.mtimeMs, version: r.code === 0 ? r.stdout.trim().split('\n')[0] || null : null };
  }
  return { installed: true, version: agyVersion.version };
}

async function buildItems(): Promise<Item[]> {
  const [pkgs, distros, upgradable, phantom] = await Promise.all([
    termuxInstalled(),
    listDistros(),
    isTermux ? run('apt', ['list', '--upgradable'], { timeout: 20000 }) : Promise.resolve({ stdout: '' }),
    phantomStatus(),
  ]);
  const upgradeCount = upgradable.stdout.split('\n').filter((l) => l.includes('[upgradable from')).length;
  const pd = Boolean(PD_BIN);
  const distro = distros.find((d) => d.name === DEFAULT_DISTRO) ?? distros[0];
  const missingDev = DEV_PKGS.filter((p) => !pkgs.has(p));
  const cc = claudeState();
  const agy = await agyState();
  const arm64 = os.arch() === 'arm64';
  const serviceDir = path.join(PREFIX, 'var/service/termux-panel');

  const items: Item[] = [
    {
      id: 'upgrade',
      group: 'termux',
      title: 'Termux paketleri güncel',
      desc: 'Yeni kurulan Termux\'ta ilk iş: depoları ve paketleri güncelle.',
      status: upgradeCount ? 'warn' : 'ok',
      detail: upgradeCount ? `${upgradeCount} paket güncellenebilir` : undefined,
      command: `DEBIAN_FRONTEND=noninteractive pkg upgrade -y -o Dpkg::Options::=--force-confold`,
      actionLabel: 'Güncelle',
      inBulk: upgradeCount > 0,
    },
    {
      id: 'storage',
      group: 'termux',
      title: 'Depolama izni',
      desc: 'Telefonun dahili depolamasına (~/storage) erişim. Android bir izin penceresi açar, onayla.',
      status: fs.existsSync(path.join(HOME, 'storage')) ? 'ok' : 'missing',
      command: 'termux-setup-storage',
      actionLabel: 'İzin iste',
    },
    {
      id: 'termux-api',
      group: 'termux',
      title: 'Termux:API',
      desc: 'Pil, bildirim, pano, fener… Ayrıca F-Droid/GitHub\'dan Termux:API uygulaması gerekir.',
      status: pkgs.has('termux-api') ? 'ok' : 'missing',
      command: `${PKG_INSTALL} termux-api`,
      actionLabel: 'Kur',
      inBulk: true,
    },
    {
      id: 'termux-services',
      group: 'termux',
      title: 'termux-services',
      desc: 'Arka plan servisleri (sshd, panelin otomatik başlaması…). Kurulumdan sonra Termux\'u yeniden başlat.',
      status: pkgs.has('termux-services') ? 'ok' : 'missing',
      command: `${PKG_INSTALL} termux-services`,
      actionLabel: 'Kur',
      inBulk: true,
    },
    {
      id: 'node-pty',
      group: 'termux',
      title: 'Tam terminal desteği (node-pty)',
      desc: 'Terminalin yeniden boyutlanması ve tam uyumluluk için. Yeniden derledikten sonra paneli yeniden başlat.',
      status: ptyBackend === 'node-pty' ? 'ok' : 'warn',
      detail: ptyBackend === 'node-pty' ? undefined : `Şu an yedek mod: ${ptyBackend}`,
      command: `mkdir -p ~/.gyp && { [ -f ~/.gyp/include.gypi ] || echo "{'variables':{'android_ndk_path':''}}" > ~/.gyp/include.gypi; } && ${PKG_INSTALL} python make clang binutils && cd ${shq(PANEL_DIR)} && npm rebuild node-pty`,
      actionLabel: 'Yeniden derle',
    },
    {
      id: 'autostart',
      group: 'termux',
      title: 'Panel otomatik başlasın',
      desc: 'Paneli termux-services ile servis yapar; Termux açıldığında kendiliğinden çalışır. Kurulunca, elle başlattığın paneli kapat: servis devralır.',
      status: !pkgs.has('termux-services') ? 'blocked' : fs.existsSync(serviceDir) ? 'ok' : 'missing',
      detail: !pkgs.has('termux-services') ? 'Önce termux-services kurulmalı' : undefined,
      command: `bash ${shq(path.join(PANEL_DIR, 'scripts/install-service.sh'))}`,
      actionLabel: 'Kur',
    },
    {
      id: 'phantom',
      group: 'termux',
      title: 'Arka plan süreç sınırı (phantom process killer)',
      desc: 'Android 12+ Termux\'un alt süreçlerini (proot, claude, dev server) habersizce öldürebilir: "Process completed (signal 9)". Bir kez adb ile kapatılmalı.',
      status: phantom.status,
      detail: phantom.detail,
      help: phantom.help || undefined,
    },
    {
      id: 'devtools',
      group: 'ai',
      title: 'Geliştirme araçları',
      desc: `Claude'un Bash aracının beklediği temel araçlar: ${DEV_PKGS.join(', ')}`,
      status: missingDev.length ? 'missing' : 'ok',
      detail: missingDev.length ? `Eksik: ${missingDev.join(', ')}` : undefined,
      command: `${PKG_INSTALL} ${DEV_PKGS.join(' ')}`,
      actionLabel: 'Kur',
      inBulk: true,
    },
    {
      id: 'claude',
      group: 'ai',
      title: 'Claude Code',
      desc: 'claude-code-android betiğiyle doğrudan Termux\'a kurulur (resmi linux-arm64 sürümü + glibc-runner, ~250 MB). Kendini günde bir kez günceller. İlk çalıştırmada terminalde giriş yapman gerekir.',
      status: !arm64 ? 'blocked' : cc.installed ? (cc.loggedIn ? 'ok' : 'warn') : cc.npm ? 'warn' : 'missing',
      detail: !arm64
        ? `Yalnızca aarch64 (arm64) cihazlarda çalışır; bu cihaz: ${os.arch()}`
        : cc.installed
          ? `Sürüm ${cc.version}${cc.loggedIn ? '' : ' · henüz giriş yapılmamış: terminalde claude çalıştır'}`
          : cc.npm
            ? 'Eski npm kurulumu bulundu: betik taşıma (migrate.sh) komutlarını gösterir'
            : undefined,
      // Kuruluysa (giriş eksik olsa da) yeniden kurma
      command: cc.installed ? undefined : claudeInstallCmd(),
      actionLabel: 'Kur',
    },
    {
      id: 'agy',
      group: 'ai',
      title: 'Antigravity CLI (agy)',
      desc: 'Google\'ın terminal ajanı. Termux derlemesi (wallentx/antigravity-cli-termux) doğrudan Termux\'a kurulur (~55 MB indirme, glibc ile çalışır). İlk çalıştırmada terminalde Google hesabınla giriş yapman gerekir.',
      status: !arm64 ? 'blocked' : agy.installed ? 'ok' : 'missing',
      detail: !arm64 ? `Yalnızca aarch64 (arm64) cihazlarda çalışır; bu cihaz: ${os.arch()}` : agy.installed ? `Sürüm ${agy.version ?? '?'}` : undefined,
      command: agy.installed ? undefined : agyInstallCmd(),
      actionLabel: 'Kur',
    },
    {
      id: 'proot-distro',
      group: 'linux',
      title: 'proot-distro',
      desc: 'İsteğe bağlı: Termux içinde tam bir Linux (Debian, Ubuntu…) çalıştırmak için. Panel ve Claude Code buna ihtiyaç duymaz.',
      status: pd ? 'ok' : 'missing',
      command: `${PKG_INSTALL} proot-distro`,
      actionLabel: 'Kur',
    },
    {
      id: 'distro',
      group: 'linux',
      title: 'Linux dağıtımı',
      desc: `İsteğe bağlı: varsayılan olarak ${DEFAULT_DISTRO} kurulur (~50 MB indirme). Diğerleri için Distrolar sayfası.`,
      status: distro ? 'ok' : pd ? 'missing' : 'blocked',
      detail: distro ? `${distro.name} · ${distro.os ?? ''}` : !pd ? 'Önce proot-distro kurulmalı' : undefined,
      command: `${shq(PD_BIN ?? 'proot-distro')} install ${DEFAULT_DISTRO}`,
      actionLabel: `${DEFAULT_DISTRO} kur`,
    },
  ];
  return items;
}

export default async function setupRoutes(app: FastifyInstance) {
  app.get('/api/setup', async () => {
    const items = await buildItems();
    return {
      isTermux,
      pdAvailable: pdStatus().available,
      // İstemci command alanını görmez; sadece işlem var mı bilir
      items: items.map(({ command, ...i }) => ({ ...i, hasAction: Boolean(command) })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/setup/:id', async (req) => {
    if (!isTermux) throw new HttpError(400, 'Kurulum yalnızca panel Termux\'ta çalışırken yapılabilir');
    const items = await buildItems();
    if (req.params.id === 'all') {
      // Sırası önemli: paketler → araçlar. AI araçları (Claude, Antigravity) isteğe göre tek tek kurulur. Durum "blocked" olanlar
      // da dahil edilir; önceki adımlar onları çözer. Her adım alt kabukta çalışır; biri
      // başarısız olursa iş o adımın çıkış koduyla biter (sonraki adımlara geçilmez).
      const todo = items.filter((i) => i.inBulk && i.status !== 'ok' && i.command);
      if (!todo.length) throw new HttpError(400, 'Kurulacak eksik bileşen yok');
      const script = todo
        .map((i) => `echo; echo ${shq(`==> ${i.title}`)}\n( ${i.command}\n) || { rc=$?; echo; echo ${shq(`==> BAŞARISIZ: ${i.title}`)}" (çıkış kodu $rc)"; exit $rc; }`)
        .join('\n');
      return startShellJob(`Kurulum: ${todo.map((i) => i.title).join(', ')}`, `${script}\necho; echo '==> Tamamlandı'`);
    }
    const item = items.find((i) => i.id === req.params.id);
    if (!item?.command) throw new HttpError(404, 'Bilinmeyen kurulum adımı');
    return startShellJob(item.title, item.command);
  });
}
