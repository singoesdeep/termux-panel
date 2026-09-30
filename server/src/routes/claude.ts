import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { config, updateConfig, type ClaudeProject } from '../config.js';
import { HOME, PREFIX, resolvePath, which } from '../env.js';
import { HttpError } from '../exec.js';
import { alive, descendants, sleep } from '../targets.js';
import { claudeState } from './setup.js';
import { SVDIR, SV_LOGDIR, sv, svAvailable, svStatus } from './services.js';

/**
 * Claude projeleri: Termux'taki her proje klasörüne bağlı ayrı bir `claude rc` (Remote Control)
 * servisi (termux-services/runit, adı claude-rc-<id>). Claude yalnızca o klasörde çalışır,
 * diğer projeleri görmez. Servisler panelden bağımsızdır: panel yeniden başlasa da sürer,
 * çökerse runit yeniden başlatır, çıktı svlogd ile $PREFIX/var/log/sv/<servis> altında tutulur.
 */

const SH = path.join(PREFIX, 'bin/sh');
const BASH = path.join(PREFIX, 'bin/bash');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
/** Eski sürümün tek servisi */
const LEGACY = 'claude-rc';
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]|\r/g;
const URL_RE = /https:\/\/claude\.ai\/[^\s'"<>`)\]]+/g;

const svcName = (p: ClaudeProject) => `claude-rc-${p.id}`;
const svcDir = (name: string) => path.join(SVDIR, name);

function slug(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[çćč]/g, 'c')
      .replace(/ğ/g, 'g')
      .replace(/[ıì]/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ş/g, 's')
      .replace(/ü/g, 'u')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'proje';
  let id = base;
  for (let i = 2; config.projects.some((p) => p.id === id) || fs.existsSync(svcDir(`claude-rc-${id}`)); i++) id = `${base}-${i}`;
  return id;
}

function checkCommand(v: unknown) {
  const command = String(v ?? 'claude rc').trim();
  if (!command || /[\0\n]/.test(command)) throw new HttpError(400, 'Komut tek satır olmalı');
  return command;
}

function checkPath(v: unknown) {
  const raw = String(v ?? '').trim();
  if (!raw || /[\0\n]/.test(raw) || !(raw.startsWith('/') || raw === '~' || raw.startsWith('~/'))) throw new HttpError(400, 'Klasör / ya da ~ ile başlayan bir yol olmalı');
  const p = resolvePath(raw).replace(/\/+$/, '') || '/';
  // Claude'a home'un ya da bir üst klasörün tamamını açmayalım: proje, kendi klasörü olmalı
  if (p === HOME || HOME.startsWith(`${p}/`) || p === '/') throw new HttpError(400, 'Home ya da onu içeren bir klasör proje olamaz; projeye ait bir alt klasör seç');
  return p;
}

function getProject(id: string) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Proje bulunamadı');
  return p;
}

// ---- ~/.claude.json: klasör güven onayı ----

async function readClaudeJson(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fsp.readFile(CLAUDE_JSON, 'utf8'));
  } catch (e) {
    // Dosya yoksa boş başlanır; bozuksa dokunulmaz
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
}

async function trustedPaths(): Promise<Set<string>> {
  const j = await readClaudeJson();
  const projects = (j?.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>;
  return new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k));
}

/** Yalnızca bu klasör için "bu klasöre güveniyor musun?" onayını işaretler */
async function trust(dir: string) {
  const j = await readClaudeJson();
  if (!j) return false;
  const projects = ((j.projects ??= {}) as Record<string, Record<string, unknown>>);
  if (projects[dir]?.hasTrustDialogAccepted) return true;
  projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
  const tmp = `${CLAUDE_JSON}.tp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CLAUDE_JSON);
  return true;
}

// ---- runit servisi ----

/** runit'in çalıştıracağı betik: proje klasörüne gir, (isteğe bağlı) sahte TTY ile komutu çalıştır. */
function runScript(p: ClaudeProject) {
  // stdin /dev/null: script çocuk bitene kadar bekler ve onun çıkış koduyla çıkar
  // (boru ya da hiç kapanmayan stdin ile script çocuk bitse de takılı kalıyor)
  const run = p.tty ? `exec script -qfec ${shq(p.command)} /dev/null </dev/null` : `exec ${p.command} </dev/null`;
  // Giriş kabuğu (~/.profile'daki değişkenler için) PATH'i değiştirebilir; sonra yeniden ayarlanır.
  // ~/.local/bin: claude kendi "native" kurulum yolunu PATH'te arar
  const cmd = `export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"; ${run}`;
  return `#!${SH}
# Termux Panel tarafından oluşturuldu. Panelden düzenle: Menü → Claude
exec 2>&1
# Android Termux'u uyutmasın
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
export HOME=${shq(HOME)}
export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"
# Bir claude oturumundan sızmış değişkenler (runsvdir bunları başlatıldığı kabuktan devralabilir).
# BUN_OPTIONS: claude sarmalayıcısı --preload yolunu göreli yazar; başka klasörde claude hemen çıkar
unset CLAUDECODE CLAUDE_CODE_EXECPATH CLAUDE_CODE_ENTRYPOINT BUN_OPTIONS
echo "==> ${p.path.replace(/[`$"\\]/g, '')} · ${p.command.replace(/[`$"\\]/g, '')}"
cd ${shq(p.path)} || { echo "Klasör bulunamadı"; exit 1; }
exec ${shq(BASH)} -lc ${shq(cmd)}
`;
}

// Hata ile çıkınca (ör. giriş yapılmamış) saniyede bir yeniden başlamasın
const FINISH = `#!${SH}
[ "$1" -gt 0 ] 2>/dev/null && sleep 10
exit 0
`;

const logRun = (name: string) => `#!${SH}
mkdir -p "${SV_LOGDIR}/${name}"
exec svlogd -tt "${SV_LOGDIR}/${name}"
`;

async function writeService(p: ClaudeProject) {
  const name = svcName(p);
  const dir = svcDir(name);
  const fresh = !fs.existsSync(dir);
  await fsp.mkdir(path.join(dir, 'log'), { recursive: true });
  // Yeni servis kendiliğinden başlamasın; başlatma kararını çağıran verir
  if (fresh) await fsp.writeFile(path.join(dir, 'down'), '');
  const files: [string, string][] = [
    ['run', runScript(p)],
    ['finish', FINISH],
    ['log/run', logRun(name)],
  ];
  for (const [f, content] of files) {
    await fsp.writeFile(path.join(dir, f), content, { mode: 0o755 });
    await fsp.chmod(path.join(dir, f), 0o755);
  }
}

/** runsvdir yeni klasörü en geç ~5 sn'de fark eder; supervise hazır olana kadar bekle */
async function waitSupervise(name: string) {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(svcDir(name), 'supervise/ok'))) return true;
    await sleep(250);
  }
  return false;
}

async function start(p: ClaudeProject) {
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Klasör bulunamadı: ${p.path}`);
  await trust(p.path).catch(() => false);
  const name = svcName(p);
  if (!(await waitSupervise(name))) throw new HttpError(500, 'Servis oluşturuldu ama runit görmedi. Termux\'u yeniden başlatmayı dene.');
  const r = await sv(['up', name]);
  if (r.code !== 0) throw new HttpError(500, r.stderr || r.stdout || 'Servis başlatılamadı');
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    if (alive(pid)) process.kill(pid, sig);
  } catch {
    /* zaten bitmiş */
  }
};

/**
 * Servisi durdurur. runit TERM'i yalnızca ana sürece gönderir; claude'un alt
 * süreçleri geride kalabileceği için süreç ağacı önceden alınır ve kalanlar kapatılır.
 */
async function stop(name: string) {
  if (!fs.existsSync(path.join(svcDir(name), 'supervise'))) return;
  const st = await svStatus(name);
  const tree = st.pid ? [st.pid, ...(await descendants(st.pid))] : [];
  await sv(['down', name]);
  if (!tree.length) return;
  for (let i = 0; i < 30 && tree.some(alive); i++) await sleep(100);
  for (const p of tree.reverse()) signal(p, 'SIGTERM');
  for (let i = 0; i < 15 && tree.some(alive); i++) await sleep(100);
  for (const p of tree) signal(p, 'SIGKILL');
}

async function removeService(name: string) {
  const dir = svcDir(name);
  if (!fs.existsSync(dir)) return;
  await stop(name).catch(() => {});
  // Klasör silinince runsvdir servisin runsv'sini de kapatır
  await fsp.rm(dir, { recursive: true, force: true });
}

async function readLog(name: string, lines = 300) {
  const txt = await fsp.readFile(path.join(SV_LOGDIR, name, 'current'), 'utf8').catch(() => '');
  const clean = txt.slice(-256 * 1024).replace(ANSI_RE, '');
  // En yeni bağlantı başta
  const urls = [...new Set((clean.match(URL_RE) ?? []).reverse())].slice(0, 3);
  const out = clean.split('\n').filter((l) => l.replace(/^\S+\s/, '').trim());
  return { log: out.slice(-lines).join('\n'), urls };
}

async function projectInfo(p: ClaudeProject, available: boolean, trusted: Set<string>) {
  const name = svcName(p);
  const installed = fs.existsSync(path.join(svcDir(name), 'run'));
  const status = available && installed ? await svStatus(name) : null;
  const { urls } = installed ? await readLog(name, 0) : { urls: [] };
  return { ...p, service: name, exists: fs.existsSync(p.path), trusted: trusted.has(p.path), status, url: status?.state === 'run' ? (urls[0] ?? null) : null };
}

/** Eski tek servis (claude-rc) ayarını bir projeye çevirir (distro yolu değilse) */
function migrateLegacyConfig() {
  const old = config.claudeRc;
  if (!old) return;
  const patch: Parameters<typeof updateConfig>[0] = { claudeRc: undefined };
  if (!old.distro && old.cwd && !config.projects.some((p) => p.path === old.cwd)) {
    try {
      const p = checkPath(old.cwd);
      patch.projects = [...config.projects, { id: slug(path.basename(p)), name: path.basename(p), path: p, command: old.command || 'claude rc', tty: old.tty !== false }];
    } catch {
      /* geçersiz eski yol: atla */
    }
  }
  updateConfig(patch);
}

export default async function claudeRoutes(app: FastifyInstance) {
  migrateLegacyConfig();

  app.get('/api/claude', async () => {
    const [available, phantom, trusted] = await Promise.all([svAvailable(), phantomStatus(), trustedPaths()]);
    return {
      svAvailable: available,
      claude: claudeState(),
      projects: await Promise.all(config.projects.map((p) => projectInfo(p, available, trusted))),
      // Eski sürümden kalan tek servis (distroda ya da genel klasörde çalışıyor olabilir)
      legacy: fs.existsSync(path.join(svcDir(LEGACY), 'run')),
      home: HOME,
      tty: Boolean(which('script')),
      wakeLock: Boolean(which('termux-wake-lock')),
      phantom,
    };
  });

  /** Yeni proje: klasörü oluştur (create) ya da var olanı bağla; servisi kur, istenirse başlat */
  app.post('/api/claude/projects', async (req) => {
    if (!(await svAvailable())) throw new HttpError(501, 'termux-services kurulu değil ya da Termux yeniden başlatılmadı');
    const b = (req.body ?? {}) as { name?: string; path?: string; create?: boolean; command?: string; tty?: boolean; start?: boolean };
    const dir = checkPath(b.path);
    if (config.projects.some((p) => p.path === dir)) throw new HttpError(409, 'Bu klasör zaten bir proje');
    const st = await fsp.stat(dir).catch(() => null);
    if (b.create) {
      if (st) throw new HttpError(409, `Bu klasör zaten var: ${dir}. "Var olan klasör" ile ekle.`);
      await fsp.mkdir(dir, { recursive: true });
    } else if (!st?.isDirectory()) throw new HttpError(404, `Klasör bulunamadı: ${dir}`);
    const tty = b.tty !== false;
    if (tty && !which('script')) throw new HttpError(501, 'TTY için util-linux paketi (script komutu) gerekli: pkg install util-linux');
    const name = String(b.name ?? '').trim().slice(0, 60) || path.basename(dir);
    const p: ClaudeProject = { id: slug(name), name, path: dir, command: checkCommand(b.command), tty };
    await writeService(p);
    updateConfig({ projects: [...config.projects, p] });
    await trust(dir).catch(() => false);
    if (b.start !== false && claudeState().installed) {
      // Başlatılan proje Termux açılınca da başlasın (Servisler/Claude sayfasından kapatılabilir)
      await fsp.rm(path.join(svcDir(svcName(p)), 'down'), { force: true });
      await start(p);
    }
    return { ok: true, id: p.id };
  });

  /** Ayarları güncelle; çalışıyorsa yeni ayarlarla yeniden başlar */
  app.put<{ Params: { id: string } }>('/api/claude/projects/:id', async (req) => {
    const old = getProject(req.params.id);
    const b = (req.body ?? {}) as { name?: string; command?: string; tty?: boolean };
    const p: ClaudeProject = {
      ...old,
      name: String(b.name ?? old.name).trim().slice(0, 60) || old.name,
      command: checkCommand(b.command ?? old.command),
      tty: b.tty ?? old.tty,
    };
    if (p.tty && !which('script')) throw new HttpError(501, 'TTY için util-linux paketi (script komutu) gerekli: pkg install util-linux');
    const name = svcName(p);
    const running = (await svAvailable()) && fs.existsSync(path.join(svcDir(name), 'supervise')) && (await svStatus(name)).state === 'run';
    if (running) await stop(name);
    await writeService(p);
    updateConfig({ projects: config.projects.map((x) => (x.id === p.id ? p : x)) });
    if (running) await start(p);
    return { ok: true };
  });

  app.post<{ Params: { id: string; action: string } }>('/api/claude/projects/:id/:action', async (req) => {
    const p = getProject(req.params.id);
    const name = svcName(p);
    const a = req.params.action;
    if (a !== 'clear-log' && !fs.existsSync(path.join(svcDir(name), 'run'))) await writeService(p);
    if (a === 'up') await start(p);
    else if (a === 'down') await stop(name);
    else if (a === 'restart') {
      await stop(name);
      await start(p);
    } else if (a === 'trust') {
      if (!(await trust(p.path))) throw new HttpError(500, '~/.claude.json okunamadı');
    } else if (a === 'clear-log') {
      await fsp.writeFile(path.join(SV_LOGDIR, name, 'current'), '').catch(() => {});
    } else throw new HttpError(400, 'Geçersiz işlem');
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/claude/projects/:id/log', async (req) => readLog(svcName(getProject(req.params.id))));

  /** Projeyi listeden ve servisini kaldırır; klasöre dokunmaz */
  app.delete<{ Params: { id: string } }>('/api/claude/projects/:id', async (req) => {
    const p = getProject(req.params.id);
    await removeService(svcName(p));
    updateConfig({ projects: config.projects.filter((x) => x.id !== p.id) });
    return { ok: true };
  });

  app.delete('/api/claude/legacy', async () => {
    await removeService(LEGACY);
    return { ok: true };
  });
}
