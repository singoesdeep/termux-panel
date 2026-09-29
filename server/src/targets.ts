import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { HOME, PKG, PREFIX, PYTHON, SHELL, isTermux, resolvePath, which } from './env.js';
import { HttpError, run, type RunResult } from './exec.js';

/**
 * Komutların çalışacağı ortam: Termux'un kendisi ya da bir proot-distro container'ı.
 * Distro içinde komutlar `proot-distro login <ad> -- komut` ile çalıştırılır.
 */

export const PD_BIN = process.env.TP_PD_BIN || which('proot-distro');
export const PD_ROOT = process.env.TP_PD_ROOT || path.join(PREFIX, 'var/lib/proot-distro');

export type PkgManager = 'apt' | 'apk' | 'pacman' | 'dnf' | null;

export interface Distro {
  name: string;
  rootfs: string;
  os: string | null;
  image: string | null;
  pm: PkgManager;
  shell: string;
}

export type Target = { kind: 'termux' } | ({ kind: 'distro' } & Distro);

export const TERMUX: Target = { kind: 'termux' };

/** proot-distro kullanılabilir mi? proot içinden proot-distro çalıştırılamaz. */
export function pdStatus(): { available: boolean; reason?: string } {
  if (!PD_BIN) return { available: false, reason: 'proot-distro kurulu değil' };
  if (!isTermux && !process.env.TP_PD_BIN)
    return { available: false, reason: 'Panel bir proot içinde çalışıyor. Distroları yönetmek için paneli Termux\'ta çalıştır.' };
  return { available: true };
}

const exists = (p: string) => fs.existsSync(p);

/** v5: containers/<ad>/rootfs, v4: installed-rootfs/<ad> */
function rootfsOf(name: string): string | null {
  const v5 = path.join(PD_ROOT, 'containers', name, 'rootfs');
  if (exists(v5)) return v5;
  const v4 = path.join(PD_ROOT, 'installed-rootfs', name);
  if (exists(v4)) return v4;
  return null;
}

async function osName(rootfs: string) {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    try {
      const txt = await fsp.readFile(path.join(rootfs, f), 'utf8');
      const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(txt);
      if (m) return m[1];
    } catch {
      /* sıradaki */
    }
  }
  return null;
}

async function imageRef(name: string) {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(PD_ROOT, 'containers', name, 'manifest.json'), 'utf8'));
    return typeof m.image_ref === 'string' ? m.image_ref : null;
  } catch {
    return null;
  }
}

function detectPm(rootfs: string): PkgManager {
  if (exists(path.join(rootfs, 'usr/bin/apt-get'))) return 'apt';
  if (exists(path.join(rootfs, 'sbin/apk'))) return 'apk';
  if (exists(path.join(rootfs, 'usr/bin/pacman'))) return 'pacman';
  if (exists(path.join(rootfs, 'usr/bin/dnf'))) return 'dnf';
  return null;
}

export async function listDistros(): Promise<Distro[]> {
  const names = new Set<string>();
  for (const dir of ['containers', 'installed-rootfs']) {
    try {
      for (const n of await fsp.readdir(path.join(PD_ROOT, dir))) names.add(n);
    } catch {
      /* yok */
    }
  }
  const out: Distro[] = [];
  for (const name of [...names].sort()) {
    const rootfs = rootfsOf(name);
    if (!rootfs) continue;
    out.push({
      name,
      rootfs,
      os: await osName(rootfs),
      image: await imageRef(name),
      pm: detectPm(rootfs),
      shell: exists(path.join(rootfs, 'bin/bash')) || exists(path.join(rootfs, 'usr/bin/bash')) ? '/bin/bash' : '/bin/sh',
    });
  }
  return out;
}

export const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** `?env=` değerinden hedef ortamı çözer. Boş/`termux` → Termux. */
export async function getTarget(env: unknown): Promise<Target> {
  if (env === undefined || env === null || env === '' || env === 'termux') return TERMUX;
  if (typeof env !== 'string' || !NAME_RE.test(env)) throw new HttpError(400, 'Geçersiz ortam adı');
  const st = pdStatus();
  if (!st.available) throw new HttpError(501, st.reason ?? 'proot-distro kullanılamıyor');
  const d = (await listDistros()).find((x) => x.name === env);
  if (!d) throw new HttpError(404, `"${env}" adında kurulu distro yok`);
  return { kind: 'distro', ...d };
}

export interface WrapOpts {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface Wrapped {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Ortak klasörler: Termux'ta var olanlar her distro oturumuna `--bind` ile bağlanır. */
export function activeBinds(): { src: string; dst: string }[] {
  return config.binds
    .map((b) => ({ src: resolvePath(b.src), dst: b.dst }))
    .filter((b) => b.dst.startsWith('/') && !b.dst.includes(':') && !b.src.includes(':') && exists(b.src));
}

export const bindArgs = () => activeBinds().flatMap((b) => ['--bind', `${b.src}:${b.dst}`]);

/** Bir komutu hedef ortamda çalışacak hale getirir. */
export function wrap(t: Target, cmd: string, args: string[], opts: WrapOpts = {}): Wrapped {
  if (t.kind === 'termux') return { cmd, args, cwd: opts.cwd, env: opts.env };
  const pdArgs = ['login', t.name, '--user', opts.user ?? 'root', ...bindArgs()];
  if (opts.cwd) pdArgs.push('--work-dir', opts.cwd);
  for (const [k, v] of Object.entries(opts.env ?? {})) pdArgs.push('--env', `${k}=${v}`);
  return { cmd: PD_BIN!, args: [...pdArgs, '--', cmd, ...args], cwd: HOME };
}

export function runIn(t: Target, cmd: string, args: string[], opts: WrapOpts & { timeout?: number } = {}): Promise<RunResult> {
  const w = wrap(t, cmd, args, opts);
  return run(w.cmd, w.args, { cwd: w.cwd, env: w.env, timeout: opts.timeout });
}

/** Ortamdaki kabukla bir komut satırı çalıştırır. */
export function shellCmd(t: Target, command: string): [string, string[]] {
  return t.kind === 'termux' ? [SHELL, ['-lc', command]] : [t.shell, ['-lc', command]];
}

/** Ortamın paket yöneticisi komutu (yalnızca apt tabanlılar destekleniyor). */
export function aptBin(t: Target) {
  if (t.kind === 'termux') return PKG;
  if (t.pm !== 'apt') throw new HttpError(501, `${t.name} için paket yönetimi (${t.pm ?? 'bilinmiyor'}) henüz desteklenmiyor. Terminali kullan.`);
  return 'apt-get';
}

export const pythonBin = (t: Target) => (t.kind === 'termux' ? PYTHON : 'python3');

/** dpkg veritabanının bulunduğu kök (Termux'ta $PREFIX, distroda rootfs) */
export function dpkgRoot(t: Target) {
  return t.kind === 'termux' ? (isTermux ? PREFIX : '/') : t.rootfs;
}

// ---- Oturum kapatma ----

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** pid'in tüm alt süreçleri (/proc okunabildiği kadarıyla) */
export async function descendants(root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  try {
    for (const d of await fsp.readdir('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = await fsp.readFile(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
        children.set(ppid, [...(children.get(ppid) ?? []), Number(d)]);
      } catch {
        /* süreç bitmiş ya da okunamıyor */
      }
    }
  } catch {
    return [];
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* zaten bitmiş */
  }
};

/**
 * Bir süreç ağacını kapatır: önce içerideki kabuklar SIGHUP alır (etkileşimli bash
 * SIGTERM'i yok sayar), sonra kök SIGTERM, hâlâ yaşayan varsa SIGKILL.
 */
export async function killTree(root: number) {
  const kids = await descendants(root);
  for (const k of kids.reverse()) signal(k, 'SIGHUP');
  signal(root, 'SIGHUP');
  signal(root, 'SIGTERM');
  for (let i = 0; i < 20 && alive(root); i++) await sleep(100);
  for (const p of [root, ...kids]) if (alive(p)) signal(p, 'SIGKILL');
}

/** Bir proot-distro oturumunu (ya da `name` verilirse o distronun tüm oturumlarını) kapatır. */
export async function killPd(target: { pid: number } | { name: string }) {
  // v5'in kendi `kill` komutu oturumun tüm ağacını (kilit dosyasını tutan her süreci) bulur
  if (PD_BIN && pdStatus().available && fs.existsSync(path.join(PD_ROOT, 'sessions'))) {
    const arg = 'pid' in target ? String(target.pid) : target.name;
    const r = await run(PD_BIN, ['kill', arg], { timeout: 20000, env: { NO_COLOR: '1' } });
    if (r.code === 0) return;
  }
  const pids = 'pid' in target ? [target.pid] : (await listSessions()).filter((s) => s.container === target.name).map((s) => s.pid);
  await Promise.all(pids.map(killTree));
}

// ---- Çalışan proot-distro oturumları (v5: sessions/*.json) ----
export interface PdSession {
  pid: number;
  container: string;
  kind: string;
  command: string[];
  user: string;
  startTime: number;
}

export async function listSessions(): Promise<PdSession[]> {
  const dir = path.join(PD_ROOT, 'sessions');
  let files: string[] = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: PdSession[] = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      const pid = Number(s.pid);
      // Dosya kalmış ama süreç ölmüş olabilir
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') continue;
      }
      out.push({
        pid,
        container: String(s.container ?? '?'),
        kind: String(s.kind ?? 'login'),
        command: Array.isArray(s.command) ? s.command.map(String) : [],
        user: String(s.user ?? 'root'),
        startTime: Number(s.start_time ?? 0) * 1000,
      });
    } catch {
      /* bozuk dosya */
    }
  }
  return out.sort((a, b) => b.startTime - a.startTime);
}
