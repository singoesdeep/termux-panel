import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { config, updateConfig, type AgentConf, type AgentId, type Project } from '../config.js';
import { HOME, PREFIX, resolvePath, which } from '../env.js';
import { HttpError } from '../exec.js';
import { alive, descendants, sleep } from '../targets.js';
import { agyState, claudeState } from './setup.js';
import { SVDIR, SV_LOGDIR, sv, svAvailable, svStatus } from './services.js';

/**
 * Projeler: Termux'taki her proje klasöründe AI ajanlarının uzaktan kontrol oturumları.
 * Her (proje, ajan) çifti ayrı bir termux-services (runit) servisidir: claude-rc-<id>
 * (`claude rc`), agy-rc-<id> (`agy --remote-control`). Ajan yalnızca o klasörde çalışır,
 * diğer projeleri görmez. Servisler panelden bağımsızdır: panel yeniden başlasa da sürer,
 * çökerse runit yeniden başlatır, çıktı svlogd ile $PREFIX/var/log/sv/<servis> altında tutulur.
 */

const SH = path.join(PREFIX, 'bin/sh');
const BASH = path.join(PREFIX, 'bin/bash');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const AGY_DIR = path.join(HOME, '.gemini/antigravity-cli');
const AGY_SETTINGS = path.join(AGY_DIR, 'settings.json');
/** Eski sürümün tek servisi */
const LEGACY = 'claude-rc';
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[()][A-Z0-9]|\x1b[=>78]|\r/g;

interface AgentDef {
  title: string;
  /** Servis adı öneki */
  prefix: string;
  defaultCommand: string;
  /** Oturum bağlantısı (logdan okunur) */
  urlRe: RegExp;
  state: () => Promise<{ installed: boolean; version: string | null; loggedIn: boolean | null }>;
  /** Klasöre güven onayını otomatik verebiliyor muyuz */
  trust?: (dir: string) => Promise<boolean>;
  trusted?: () => Promise<Set<string>>;
}

const AGENTS: Record<AgentId, AgentDef> = {
  claude: {
    title: 'Claude Code',
    prefix: 'claude-rc',
    defaultCommand: 'claude rc',
    urlRe: /https:\/\/claude\.ai\/[^\s'"<>`)\]]+/g,
    state: async () => {
      const s = claudeState();
      return { installed: s.installed, version: s.version, loggedIn: s.loggedIn };
    },
    trust: trustClaude,
    trusted: trustedClaude,
  },
  agy: {
    title: 'Antigravity',
    prefix: 'agy-rc',
    defaultCommand: 'agy --remote-control',
    // "Open https://antigravity.google.com/r/<oturum> on another device to take over."
    urlRe: /https:\/\/antigravity\.google\.com\/r\/[^\s'"<>`)\]]+/g,
    // D-Bus anahtarlığı olmadığında giriş bilgisi dosyaya yazılıyor
    state: async () => ({ ...(await agyState()), loggedIn: fs.existsSync(path.join(AGY_DIR, 'antigravity-oauth-token')) }),
    trust: trustAgy,
    trusted: trustedAgy,
  },
};
const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

const isAgent = (a: unknown): a is AgentId => typeof a === 'string' && a in AGENTS;
const svcName = (p: Project, a: AgentId) => `${AGENTS[a].prefix}-${p.id}`;
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
  const taken = (id: string) => config.projects.some((p) => p.id === id) || AGENT_IDS.some((a) => fs.existsSync(svcDir(`${AGENTS[a].prefix}-${id}`)));
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

function checkAgentConf(a: AgentId, b: Partial<AgentConf> | undefined, old?: AgentConf): AgentConf {
  const command = String(b?.command ?? old?.command ?? AGENTS[a].defaultCommand).trim();
  if (!command || /[\0\n]/.test(command)) throw new HttpError(400, 'Komut tek satır olmalı');
  const tty = b?.tty ?? old?.tty ?? true;
  if (tty && !which('script')) throw new HttpError(501, 'TTY için util-linux paketi (script komutu) gerekli: pkg install util-linux');
  return { command, tty };
}

function checkPath(v: unknown) {
  const raw = String(v ?? '').trim();
  if (!raw || /[\0\n]/.test(raw) || !(raw.startsWith('/') || raw === '~' || raw.startsWith('~/'))) throw new HttpError(400, 'Klasör / ya da ~ ile başlayan bir yol olmalı');
  const p = resolvePath(raw).replace(/\/+$/, '') || '/';
  // Ajana home'un ya da bir üst klasörün tamamını açmayalım: proje, kendi klasörü olmalı
  if (p === HOME || HOME.startsWith(`${p}/`) || p === '/') throw new HttpError(400, 'Home ya da onu içeren bir klasör proje olamaz; projeye ait bir alt klasör seç');
  return p;
}

function getProject(id: string) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Proje bulunamadı');
  return p;
}

function getAgent(p: Project, a: string): AgentId {
  if (!isAgent(a)) throw new HttpError(400, 'Bilinmeyen ajan');
  if (!p.agents[a]) throw new HttpError(404, `${AGENTS[a].title} bu projede etkin değil`);
  return a;
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

async function trustedClaude(): Promise<Set<string>> {
  const j = await readClaudeJson();
  const projects = (j?.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>;
  return new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k));
}

/** Yalnızca bu klasör için "bu klasöre güveniyor musun?" onayını işaretler */
async function trustClaude(dir: string) {
  const j = await readClaudeJson();
  if (!j) return false;
  const projects = (j.projects ??= {}) as Record<string, Record<string, unknown>>;
  if (projects[dir]?.hasTrustDialogAccepted) return true;
  projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
  const tmp = `${CLAUDE_JSON}.tp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CLAUDE_JSON);
  return true;
}

// ---- ~/.gemini/antigravity-cli/settings.json: klasör güven onayı (trustedWorkspaces) ----

async function readAgySettings(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fsp.readFile(AGY_SETTINGS, 'utf8'));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
}

async function trustedAgy(): Promise<Set<string>> {
  const j = await readAgySettings();
  return new Set(Array.isArray(j?.trustedWorkspaces) ? (j.trustedWorkspaces as unknown[]).map(String) : []);
}

/** Yalnızca bu klasörü güvenilenlere ekler */
async function trustAgy(dir: string) {
  const j = await readAgySettings();
  if (!j) return false;
  const list = Array.isArray(j.trustedWorkspaces) ? (j.trustedWorkspaces as unknown[]).map(String) : [];
  if (list.includes(dir)) return true;
  j.trustedWorkspaces = [...list, dir];
  await fsp.mkdir(AGY_DIR, { recursive: true });
  const tmp = `${AGY_SETTINGS}.tp-${process.pid}`;
  await fsp.writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, AGY_SETTINGS);
  return true;
}

// ---- runit servisi ----

/** runit'in çalıştıracağı betik: proje klasörüne gir, (isteğe bağlı) sahte TTY ile komutu çalıştır. */
function runScript(p: Project, c: AgentConf) {
  // stdin /dev/null: script çocuk bitene kadar bekler ve onun çıkış koduyla çıkar
  // (boru ya da hiç kapanmayan stdin ile script çocuk bitse de takılı kalıyor)
  // Terminal arayüzleri (agy) 0x0 boyutlu pty'de hiçbir şey çizmiyor; geniş tutmak oturum
  // bağlantısının tek satırda (bölünmeden) loga düşmesini de sağlar
  const inner = `stty cols 200 rows 50 2>/dev/null; ${c.command}`;
  const run = c.tty ? `exec script -qfec ${shq(inner)} /dev/null </dev/null` : `exec ${c.command} </dev/null`;
  // Giriş kabuğu (~/.profile'daki değişkenler için) PATH'i değiştirebilir; sonra yeniden ayarlanır.
  // ~/.local/bin: claude kendi "native" kurulum yolunu PATH'te arar
  const cmd = `export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"; ${run}`;
  return `#!${SH}
# Termux Panel tarafından oluşturuldu. Panelden düzenle: Menü → Projeler
exec 2>&1
# Android Termux'u uyutmasın
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
export HOME=${shq(HOME)}
export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"
export TERM=xterm-256color
# Bir claude oturumundan sızmış değişkenler (runsvdir bunları başlatıldığı kabuktan devralabilir).
# BUN_OPTIONS: claude sarmalayıcısı --preload yolunu göreli yazar; başka klasörde claude hemen çıkar
unset CLAUDECODE CLAUDE_CODE_EXECPATH CLAUDE_CODE_ENTRYPOINT BUN_OPTIONS
echo "==> ${p.path.replace(/[`$"\\]/g, '')} · ${c.command.replace(/[`$"\\]/g, '')}"
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

async function writeService(p: Project, a: AgentId) {
  const name = svcName(p, a);
  const dir = svcDir(name);
  const fresh = !fs.existsSync(dir);
  await fsp.mkdir(path.join(dir, 'log'), { recursive: true });
  // Yeni servis kendiliğinden başlamasın; başlatma kararını çağıran verir
  if (fresh) await fsp.writeFile(path.join(dir, 'down'), '');
  const files: [string, string][] = [
    ['run', runScript(p, p.agents[a]!)],
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

async function start(p: Project, a: AgentId) {
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Klasör bulunamadı: ${p.path}`);
  if (!(await AGENTS[a].state()).installed) throw new HttpError(501, `${AGENTS[a].title} kurulu değil. Kurulum sayfasından kur.`);
  await AGENTS[a].trust?.(p.path).catch(() => false);
  const name = svcName(p, a);
  if (!fs.existsSync(path.join(svcDir(name), 'run'))) await writeService(p, a);
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
 * Servisi durdurur. runit TERM'i yalnızca ana sürece gönderir; ajanın alt süreçleri
 * geride kalabileceği için süreç ağacı önceden alınır ve kalanlar kapatılır.
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

async function readLog(name: string, urlRe: RegExp, lines = 300) {
  const txt = await fsp.readFile(path.join(SV_LOGDIR, name, 'current'), 'utf8').catch(() => '');
  const clean = txt.slice(-256 * 1024).replace(ANSI_RE, '');
  // En yeni bağlantı başta
  const urls = [...new Set((clean.match(urlRe) ?? []).reverse())].slice(0, 3);
  const out = clean.split('\n').filter((l) => l.replace(/^\S+\s/, '').trim());
  return { log: out.slice(-lines).join('\n'), urls };
}

const isRunning = async (name: string) => fs.existsSync(path.join(svcDir(name), 'supervise')) && (await svStatus(name)).state === 'run';

async function projectInfo(p: Project, available: boolean, trusted: Partial<Record<AgentId, Set<string>>>) {
  const agents = await Promise.all(
    AGENT_IDS.filter((a) => p.agents[a]).map(async (a) => {
      const name = svcName(p, a);
      const installed = fs.existsSync(path.join(svcDir(name), 'run'));
      const status = available && installed ? await svStatus(name) : null;
      const { urls } = installed ? await readLog(name, AGENTS[a].urlRe, 0) : { urls: [] };
      return {
        agent: a,
        ...p.agents[a]!,
        service: name,
        trusted: trusted[a] ? trusted[a]!.has(p.path) : null,
        status,
        url: status?.state === 'run' ? (urls[0] ?? null) : null,
      };
    }),
  );
  return { id: p.id, name: p.name, path: p.path, exists: fs.existsSync(p.path), agents };
}

/** Eski tek servis (claude-rc) ayarını bir projeye çevirir (distro yolu değilse) */
function migrateLegacyConfig() {
  const old = config.claudeRc;
  if (!old) return;
  const patch: Parameters<typeof updateConfig>[0] = { claudeRc: undefined };
  if (!old.distro && old.cwd && !config.projects.some((p) => p.path === old.cwd)) {
    try {
      const p = checkPath(old.cwd);
      const agents = { claude: { command: old.command || 'claude rc', tty: old.tty !== false } };
      patch.projects = [...config.projects, { id: slug(path.basename(p)), name: path.basename(p), path: p, agents }];
    } catch {
      /* geçersiz eski yol: atla */
    }
  }
  updateConfig(patch);
}

const saveProject = (p: Project) => updateConfig({ projects: config.projects.map((x) => (x.id === p.id ? p : x)) });

export default async function projectRoutes(app: FastifyInstance) {
  migrateLegacyConfig();
  // Panel güncellendiyse servis betikleri de güncel olsun (çalışanlar bir sonraki başlatmada kullanır)
  for (const p of config.projects)
    for (const a of AGENT_IDS)
      if (p.agents[a] && fs.existsSync(path.join(svcDir(svcName(p, a)), 'run'))) await writeService(p, a).catch(() => {});

  app.get('/api/projects', async () => {
    const [available, phantom] = await Promise.all([svAvailable(), phantomStatus()]);
    const trusted: Partial<Record<AgentId, Set<string>>> = {};
    const agents: Record<string, unknown> = {};
    for (const a of AGENT_IDS) {
      const d = AGENTS[a];
      if (d.trusted) trusted[a] = await d.trusted();
      agents[a] = { id: a, title: d.title, defaultCommand: d.defaultCommand, autoTrust: Boolean(d.trust), ...(await d.state()) };
    }
    return {
      svAvailable: available,
      agents,
      projects: await Promise.all(config.projects.map((p) => projectInfo(p, available, trusted))),
      // Eski sürümden kalan tek servis (distroda ya da genel klasörde çalışıyor olabilir)
      legacy: fs.existsSync(path.join(svcDir(LEGACY), 'run')),
      home: HOME,
      tty: Boolean(which('script')),
      wakeLock: Boolean(which('termux-wake-lock')),
      phantom,
    };
  });

  /** Yeni proje: klasörü oluştur (create) ya da var olanı bağla; seçilen ajanların servislerini kur, istenirse başlat */
  app.post('/api/projects', async (req) => {
    if (!(await svAvailable())) throw new HttpError(501, 'termux-services kurulu değil ya da Termux yeniden başlatılmadı');
    const b = (req.body ?? {}) as { name?: string; path?: string; create?: boolean; agents?: string[]; start?: boolean };
    const dir = checkPath(b.path);
    const agentIds = [...new Set(b.agents ?? ['claude'])].filter(isAgent);
    if (!agentIds.length) throw new HttpError(400, 'En az bir ajan seç');
    if (config.projects.some((p) => p.path === dir)) throw new HttpError(409, 'Bu klasör zaten bir proje');
    const st = await fsp.stat(dir).catch(() => null);
    if (b.create) {
      if (st) throw new HttpError(409, `Bu klasör zaten var: ${dir}. "Var olan klasör" ile ekle.`);
    } else if (!st?.isDirectory()) throw new HttpError(404, `Klasör bulunamadı: ${dir}`);
    const agents: Project['agents'] = {};
    for (const a of agentIds) agents[a] = checkAgentConf(a, undefined);
    if (b.create) await fsp.mkdir(dir, { recursive: true });
    const name = String(b.name ?? '').trim().slice(0, 60) || path.basename(dir);
    const p: Project = { id: slug(name), name, path: dir, agents };
    for (const a of agentIds) await writeService(p, a);
    updateConfig({ projects: [...config.projects, p] });
    // Başlatılamayanlar (ör. ajan kurulu değil) projeyi eklemeye engel olmaz; nedenleri döner
    const errors: string[] = [];
    for (const a of agentIds) {
      await AGENTS[a].trust?.(dir).catch(() => false);
      if (b.start === false) continue;
      try {
        // Başlatılan ajan Termux açılınca da başlasın (proje kartından kapatılabilir)
        await fsp.rm(path.join(svcDir(svcName(p, a)), 'down'), { force: true });
        await start(p, a);
      } catch (e) {
        errors.push(`${AGENTS[a].title}: ${(e as Error).message}`);
      }
    }
    return { ok: true, id: p.id, errors };
  });

  /** Proje adını değiştir */
  app.put<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const p = getProject(req.params.id);
    const name = String((req.body as { name?: string })?.name ?? '').trim().slice(0, 60);
    if (name) saveProject({ ...p, name });
    return { ok: true };
  });

  /** Projeyi listeden ve tüm ajan servislerini kaldırır; klasöre dokunmaz */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const p = getProject(req.params.id);
    for (const a of AGENT_IDS) if (p.agents[a]) await removeService(svcName(p, a));
    updateConfig({ projects: config.projects.filter((x) => x.id !== p.id) });
    return { ok: true };
  });

  /** Projeye ajan ekle ya da ayarlarını güncelle; çalışıyorsa yeni ayarlarla yeniden başlar */
  app.put<{ Params: { id: string; agent: string } }>('/api/projects/:id/agents/:agent', async (req) => {
    const old = getProject(req.params.id);
    const a = req.params.agent;
    if (!isAgent(a)) throw new HttpError(400, 'Bilinmeyen ajan');
    const b = (req.body ?? {}) as Partial<AgentConf> & { start?: boolean };
    const p: Project = { ...old, agents: { ...old.agents, [a]: checkAgentConf(a, b, old.agents[a]) } };
    const name = svcName(p, a);
    const running = (await svAvailable()) && (await isRunning(name));
    if (running) await stop(name);
    await writeService(p, a);
    saveProject(p);
    if (running || b.start) {
      if (!old.agents[a]) await fsp.rm(path.join(svcDir(name), 'down'), { force: true });
      await start(p, a);
    }
    return { ok: true };
  });

  /** Ajanı projeden çıkarır (servisi siler) */
  app.delete<{ Params: { id: string; agent: string } }>('/api/projects/:id/agents/:agent', async (req) => {
    const p = getProject(req.params.id);
    const a = getAgent(p, req.params.agent);
    await removeService(svcName(p, a));
    const agents = { ...p.agents };
    delete agents[a];
    saveProject({ ...p, agents });
    return { ok: true };
  });

  app.post<{ Params: { id: string; agent: string; action: string } }>('/api/projects/:id/agents/:agent/:action', async (req) => {
    const p = getProject(req.params.id);
    const a = getAgent(p, req.params.agent);
    const name = svcName(p, a);
    const act = req.params.action;
    if (act === 'up') await start(p, a);
    else if (act === 'down') await stop(name);
    else if (act === 'restart') {
      await stop(name);
      await start(p, a);
    } else if (act === 'trust') {
      const t = AGENTS[a].trust;
      if (!t) throw new HttpError(400, `${AGENTS[a].title} için güven onayı otomatik verilemiyor; terminalde bir kez aç`);
      if (!(await t(p.path))) throw new HttpError(500, 'Ayar dosyası okunamadı');
    } else if (act === 'clear-log') {
      await fsp.writeFile(path.join(SV_LOGDIR, name, 'current'), '').catch(() => {});
    } else throw new HttpError(400, 'Geçersiz işlem');
    return { ok: true };
  });

  app.get<{ Params: { id: string; agent: string } }>('/api/projects/:id/agents/:agent/log', async (req) => {
    const p = getProject(req.params.id);
    const a = getAgent(p, req.params.agent);
    return readLog(svcName(p, a), AGENTS[a].urlRe);
  });

  app.delete('/api/projects/legacy', async () => {
    await removeService(LEGACY);
    return { ok: true };
  });
}
