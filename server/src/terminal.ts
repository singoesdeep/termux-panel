import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { WebSocket } from 'ws';
import { HOME, SHELL, which } from './env.js';
import { TERMUX, killPd, killTree, wrap, type Target } from './targets.js';

const shq = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** node-pty'nin kullandığımız kısmı (opsiyonel bağımlılık, derlenemezse yedeğe düşeriz). */
interface Pty {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => Pty;

let ptySpawn: PtySpawn | null = null;
try {
  ptySpawn = (createRequire(import.meta.url)('node-pty') as { spawn: PtySpawn }).spawn;
} catch {
  ptySpawn = null;
}
export const ptyBackend = ptySpawn ? 'node-pty' : which('script') ? 'script' : 'pipe';

/** node-pty yoksa `script` ile sahte bir pty, o da yoksa düz pipe kullanır. */
function spawnFallback(file: string, args: string[], cwd: string, cols: number, rows: number): Pty {
  const env = { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) };
  const proc =
    ptyBackend === 'script'
      ? spawn('script', ['-qfc', [file, ...args].map(shq).join(' '), '/dev/null'], { cwd, env })
      : spawn(file, file === SHELL && args[0] === '-l' ? ['-i'] : args, { cwd, env });
  const dataCbs: ((d: string) => void)[] = [];
  proc.stdout!.setEncoding('utf8').on('data', (d: string) => dataCbs.forEach((cb) => cb(d)));
  proc.stderr!.setEncoding('utf8').on('data', (d: string) => dataCbs.forEach((cb) => cb(d)));
  return {
    pid: proc.pid ?? -1,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => proc.on('close', (code) => cb({ exitCode: code ?? 0 })),
    write: (d) => proc.stdin!.write(ptyBackend === 'pipe' ? d.replace(/\r/g, '\n') : d),
    resize: () => {},
    kill: (sig) => proc.kill((sig as NodeJS.Signals) ?? 'SIGHUP'),
  };
}

const MAX_BUFFER = 200 * 1024;

interface Session {
  id: string;
  title: string;
  pty: Pty;
  buffer: string;
  clients: Set<WebSocket>;
  createdAt: number;
  exited: boolean;
  env: string;
}

const sessions = new Map<string, Session>();
let counter = 0;

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function createSession(opts: { cols?: number; rows?: number; command?: string; cwd?: string; target?: Target } = {}) {
  const { cols = 80, rows = 24, command, target = TERMUX } = opts;
  const id = crypto.randomBytes(6).toString('hex');
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  let file: string;
  let args: string[];
  let cwd = HOME;
  if (target.kind === 'termux') {
    file = SHELL;
    args = command ? ['-lc', command] : ['-l'];
    if (opts.cwd) cwd = opts.cwd;
  } else {
    // Komut yoksa proot-distro kullanıcının varsayılan giriş kabuğunu açar
    const w = command ? wrap(target, target.shell, ['-lc', command], { cwd: opts.cwd }) : wrap(target, '', [], { cwd: opts.cwd });
    file = w.cmd;
    args = command ? w.args : w.args.slice(0, w.args.indexOf('--'));
  }
  const pty = ptySpawn ? ptySpawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env }) : spawnFallback(file, args, cwd, cols, rows);

  const prefix = target.kind === 'distro' ? `${target.name} ` : '';
  const s: Session = {
    id,
    env: target.kind === 'distro' ? target.name : 'termux',
    title: command ? prefix + command.slice(0, 30) : `${prefix || 'Oturum '}${++counter}`,
    pty,
    buffer: '',
    clients: new Set(),
    createdAt: Date.now(),
    exited: false,
  };
  pty.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
    for (const ws of s.clients) send(ws, { t: 'o', d });
  });
  pty.onExit(({ exitCode }) => {
    s.exited = true;
    for (const ws of s.clients) send(ws, { t: 'x', code: exitCode });
    // Çıkan oturumu kısa süre sonra temizle
    setTimeout(() => sessions.delete(id), 60_000);
  });
  sessions.set(id, s);
  return info(s);
}

function info(s: Session) {
  return { id: s.id, title: s.title, env: s.env, pid: s.pty.pid, createdAt: s.createdAt, exited: s.exited };
}

export function listSessions() {
  return [...sessions.values()].map(info);
}

export async function killSession(id: string): Promise<boolean> {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  for (const ws of s.clients) ws.close();
  if (!s.exited) {
    if (s.env !== 'termux') {
      // pty'nin pid'i proot-distro oturumunun pid'idir (login, proot'u exec eder).
      // Sadece SIGHUP göndermek içerideki bash'i kapatmıyordu; tüm ağacı kapat.
      await killPd({ pid: s.pty.pid }).catch(() => killTree(s.pty.pid));
    } else {
      s.pty.kill();
    }
  }
  return true;
}

/** Panel terminallerinin pid'leri (distro oturum listesinde "panel" etiketi için) */
export function terminalPids() {
  return new Map([...sessions.values()].filter((s) => !s.exited).map((s) => [s.pty.pid, s.title]));
}

export function attach(id: string, ws: WebSocket) {
  const s = sessions.get(id);
  if (!s) {
    send(ws, { t: 'e', d: 'Oturum bulunamadı' });
    ws.close();
    return;
  }
  s.clients.add(ws);
  // Yeniden bağlanan istemciye geçmişi gönder (mobilde sekme arka plana gidince bağlantı kopar)
  if (s.buffer) send(ws, { t: 'o', d: s.buffer });
  if (s.exited) send(ws, { t: 'x', code: 0 });

  ws.on('message', (raw) => {
    let msg: { t: string; d?: string; c?: number; r?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (s.exited) return;
    if (msg.t === 'i' && typeof msg.d === 'string') s.pty.write(msg.d);
    else if (msg.t === 'r' && msg.c && msg.r) {
      try {
        s.pty.resize(Math.max(2, Math.min(500, msg.c)), Math.max(2, Math.min(300, msg.r)));
      } catch {
        /* süreç kapanmış olabilir */
      }
    }
  });
  ws.on('close', () => s.clients.delete(ws));
}
