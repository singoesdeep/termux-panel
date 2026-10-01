import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './env.js';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  /** Çalışacağı ortam: yoksa Termux, aksi halde distro adı */
  env?: string;
}

/** Distrolara bağlanan Termux klasörü: `proot-distro login --bind src:dst` */
export interface Bind {
  /** Termux tarafı (~ ile başlayabilir) */
  src: string;
  /** Distro içindeki yol */
  dst: string;
}

export type AgentId = 'claude' | 'agy';

/** Bir projede çalışan AI aracının uzaktan kontrol servisi */
export interface AgentConf {
  command: string;
  tty: boolean;
}

/**
 * Proje: Termux'taki bir klasör. Her ajan (Claude Code, Antigravity) için ayrı bir runit
 * servisi vardır: claude-rc-<id>, agy-rc-<id>.
 */
export interface Project {
  /** Servis adında kullanılır: [a-z0-9-] */
  id: string;
  name: string;
  /** Termux'taki mutlak yol */
  path: string;
  agents: Partial<Record<AgentId, AgentConf>>;
}

/** Eski tek servis ayarı (claude-rc). Yalnızca taşıma için okunur. */
export interface LegacyClaudeRc {
  cwd: string;
  command: string;
  tty: boolean;
  distro?: string;
}

export interface Config {
  host: string;
  port: number;
  token: string;
  auth: boolean;
  snippets: Snippet[];
  binds: Bind[];
  projects: Project[];
  claudeRc?: LegacyClaudeRc;
}

export const CONFIG_DIR = process.env.TP_CONFIG_DIR || path.join(HOME, '.termux-panel');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const defaultSnippets: Snippet[] = [
  { id: 'upd', name: 'Depoları güncelle', command: 'pkg update -y' },
  { id: 'storage', name: 'Depolama izni ver', command: 'termux-setup-storage' },
  { id: 'ip', name: 'IP adreslerim', command: 'ip -brief addr 2>/dev/null || ifconfig' },
  { id: 'du', name: 'Home klasör boyutları', command: 'du -sh ~/* ~/.[!.]* 2>/dev/null | sort -h | tail -20' },
];

/** Önceki sürüm: proje yalnızca Claude içindi (command/tty doğrudan projede) */
function migrateProject(p: Project & { command?: string; tty?: boolean }): Project {
  if (p.agents) return p;
  const { command, tty, ...rest } = p;
  return { ...rest, agents: { claude: { command: command ?? 'claude rc', tty: tty !== false } } };
}

function load(): Config {
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* ilk çalıştırma */
  }
  const cfg: Config = {
    host: stored.host ?? '127.0.0.1',
    port: stored.port ?? 8088,
    token: stored.token ?? crypto.randomBytes(18).toString('base64url'),
    auth: stored.auth ?? true,
    snippets: stored.snippets ?? defaultSnippets,
    binds: stored.binds ?? [{ src: '~/projeler', dst: '/root/projeler' }],
    projects: (stored.projects ?? []).map(migrateProject),
    ...(stored.claudeRc ? { claudeRc: stored.claudeRc } : {}),
  };
  if (JSON.stringify(stored) !== JSON.stringify(cfg)) save(cfg);

  // Ortam değişkenleri dosyadaki değerleri geçersiz kılar (kaydedilmez).
  return {
    ...cfg,
    host: process.env.TP_HOST || cfg.host,
    port: Number(process.env.TP_PORT) || cfg.port,
    token: process.env.TP_TOKEN || cfg.token,
    auth: process.env.TP_NO_AUTH ? false : cfg.auth,
  };
}

function save(cfg: Config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export const config = load();

/** Ayarların bir kısmını değiştirip kaydeder (ortam değişkeni geçersiz kılmaları dosyaya yazılmaz). */
export function updateConfig(patch: Partial<Pick<Config, 'snippets' | 'binds' | 'projects' | 'claudeRc'>>) {
  Object.assign(config, patch);
  // undefined → alanı dosyadan da kaldır
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (config as unknown as Record<string, unknown>)[k];
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* yok */
  }
  save({ ...(stored as Config), ...patch });
}

export const saveSnippets = (snippets: Snippet[]) => updateConfig({ snippets });
