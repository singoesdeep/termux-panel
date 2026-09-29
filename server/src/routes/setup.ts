import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { config } from '../config.js';
import { HOME, PREFIX, isTermux, resolvePath } from '../env.js';
import { HttpError, run } from '../exec.js';
import { startShellJob } from '../jobs.js';
import { PD_BIN, bindArgs, listDistros, pdStatus, type Distro } from '../targets.js';
import { ptyBackend } from '../terminal.js';

/**
 * Kurulum sihirbazı: sıfırdan bir Termux'u AI destekli geliştirmeye hazır hale getiren
 * bileşenlerin durumu ve tek dokunuşla kurulumu. Tüm işlemler Termux kabuğunda
 * birer komut satırı olarak çalışır; "Eksikleri kur" bunları tek bir işte birleştirir.
 */

const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_DISTRO = 'debian';
const DEV_PKGS = ['git', 'curl', 'ca-certificates', 'build-essential', 'python3', 'python3-pip', 'python3-venv', 'nodejs', 'npm'];

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const PKG_INSTALL = 'DEBIAN_FRONTEND=noninteractive pkg install -y -o Dpkg::Options::=--force-confold';

type Status = 'ok' | 'missing' | 'warn' | 'blocked';

interface Item {
  id: string;
  group: 'termux' | 'linux';
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

function rootfsInstalled(d: Distro): Set<string> {
  try {
    const status = fs.readFileSync(path.join(d.rootfs, 'var/lib/dpkg/status'), 'utf8');
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

/** Distro içinde komut: proot-distro login <ad> -- bash -lc '...' */
const inDistro = (name: string, script: string) =>
  [PD_BIN ?? 'proot-distro', 'login', name, ...bindArgs(), '--env', 'DEBIAN_FRONTEND=noninteractive', '--', 'bash', '-lc', script].map(shq).join(' ');

async function buildItems(): Promise<Item[]> {
  const [pkgs, distros, upgradable, phantom] = await Promise.all([
    termuxInstalled(),
    listDistros(),
    isTermux ? run('apt', ['list', '--upgradable'], { timeout: 20000 }) : Promise.resolve({ stdout: '' }),
    phantomStatus(),
  ]);
  const upgradeCount = upgradable.stdout.split('\n').filter((l) => l.includes('[upgradable from')).length;
  const pd = Boolean(PD_BIN);
  const distro = distros.find((d) => d.name === DEFAULT_DISTRO) ?? distros.find((d) => d.pm === 'apt');
  const distroName = distro?.name ?? DEFAULT_DISTRO;
  const dpkg = distro ? rootfsInstalled(distro) : new Set<string>();
  const missingDev = DEV_PKGS.filter((p) => !dpkg.has(p));
  const hasNpm = dpkg.has('npm') || (distro ? fs.existsSync(path.join(distro.rootfs, 'usr/local/bin/npm')) : false);
  const claude = distro
    ? ['usr/local/bin/claude', 'usr/bin/claude', 'root/.local/bin/claude'].some((p) => fs.existsSync(path.join(distro.rootfs, p)))
    : false;
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
      id: 'proot-distro',
      group: 'linux',
      title: 'proot-distro',
      desc: 'Termux içinde tam bir Linux (Debian, Ubuntu…) çalıştırır. Claude Code gibi araçlar burada sorunsuz çalışır.',
      status: pd ? 'ok' : 'missing',
      command: `${PKG_INSTALL} proot-distro`,
      actionLabel: 'Kur',
      inBulk: true,
    },
    {
      id: 'distro',
      group: 'linux',
      title: 'Linux dağıtımı',
      desc: `Varsayılan olarak ${DEFAULT_DISTRO} kurulur (~50 MB indirme).`,
      status: distro ? 'ok' : pd ? 'missing' : 'blocked',
      detail: distro ? `${distro.name} · ${distro.os ?? ''}` : !pd ? 'Önce proot-distro kurulmalı' : undefined,
      command: `${shq(PD_BIN ?? 'proot-distro')} install ${DEFAULT_DISTRO}`,
      actionLabel: `${DEFAULT_DISTRO} kur`,
      inBulk: true,
    },
    ...config.binds.slice(0, 1).map((b): Item => {
      const src = resolvePath(b.src);
      return {
        id: 'projects',
        group: 'linux',
        title: 'Ortak proje klasörü',
        desc: `Termux'taki ${b.src} klasörü her distroda ${b.dst} olarak görünür. Claude'un çalıştığı projelere Termux'tan ve Dosyalar'dan da erişirsin. (config.json → binds)`,
        status: fs.existsSync(src) ? 'ok' : 'missing',
        detail: fs.existsSync(src) ? `${src} → ${b.dst}` : undefined,
        command: `mkdir -p ${shq(src)}`,
        actionLabel: 'Oluştur',
        inBulk: true,
      };
    }),
    {
      id: 'devtools',
      group: 'linux',
      title: 'Geliştirme araçları',
      desc: `${distroName} içinde: ${DEV_PKGS.join(', ')}`,
      status: !distro ? 'blocked' : missingDev.length ? 'missing' : 'ok',
      detail: !distro ? 'Önce bir distro kurulmalı' : missingDev.length ? `Eksik: ${missingDev.join(', ')}` : undefined,
      command: inDistro(distroName, `apt-get update && apt-get install -y ${DEV_PKGS.join(' ')}`),
      actionLabel: 'Kur',
      inBulk: true,
    },
    {
      id: 'claude',
      group: 'linux',
      title: 'Claude Code',
      desc: `${distroName} içine global npm paketi olarak kurulur. İlk çalıştırmada terminalde giriş yapman gerekir.`,
      status: !distro ? 'blocked' : claude ? 'ok' : hasNpm ? 'missing' : 'blocked',
      detail: !distro ? 'Önce bir distro kurulmalı' : !claude && !hasNpm ? 'Önce geliştirme araçları (npm) kurulmalı' : undefined,
      command: inDistro(distroName, 'npm install -g @anthropic-ai/claude-code'),
      actionLabel: 'Kur',
      inBulk: true,
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
      // Sırası önemli: proot-distro → distro → araçlar → Claude Code. Durum "blocked" olanlar
      // (ör. distro henüz yok) da dahil edilir; önceki adımlar onları çözer.
      const todo = items.filter((i) => i.inBulk && i.status !== 'ok' && i.command);
      if (!todo.length) throw new HttpError(400, 'Kurulacak eksik bileşen yok');
      const script = todo.map((i) => `echo; echo "==> ${i.title}"; ${i.command}`).join(' && ');
      return startShellJob(`Kurulum: ${todo.map((i) => i.title).join(', ')}`, `set -e; ${script}; echo; echo "==> Tamamlandı"`);
    }
    const item = items.find((i) => i.id === req.params.id);
    if (!item?.command) throw new HttpError(404, 'Bilinmeyen kurulum adımı');
    return startShellJob(item.title, item.command);
  });
}
