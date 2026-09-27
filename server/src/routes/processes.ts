import fs from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { HttpError, run } from '../exec.js';

const CLK_TCK = 100;
let pageSize = 4096;
run('getconf', ['PAGESIZE'], { timeout: 2000 }).then((r) => {
  const n = Number(r.stdout.trim());
  if (n > 0) pageSize = n;
});

interface Proc {
  ticks: number;
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  cmd: string;
  state: string;
  cpu: number;
  rss: number;
  mem: number;
  elapsed: number;
  threads: number;
}

async function snapshot() {
  // Android, Termux'ta /proc/uptime okumayı engelliyor; os.uptime() sysinfo() ile çalışır
  const uptime = await fs
    .readFile('/proc/uptime', 'utf8')
    .then((t) => Number(t.split(' ')[0]))
    .catch(() => os.uptime());
  const totalMem = os.totalmem();
  const pids = (await fs.readdir('/proc').catch(() => [] as string[])).filter((d) => /^\d+$/.test(d)).map(Number);
  const procs = (await Promise.all(pids.map((p) => readProc(p, uptime, totalMem)))).filter((p): p is Proc => p !== null);
  return { at: performance.now(), procs };
}

/** Anlık CPU yüzdesi için önceki örnek (panel birkaç saniyede bir sorar) */
let previous: { at: number; ticks: Map<number, number> } | null = null;

async function readProc(pid: number, uptime: number, totalMem: number): Promise<Proc | null> {
  try {
    const [stat, cmdline, status] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
    ]);
    // comm parantez içinde ve boşluk içerebilir: son ')' karakterinden böl
    const close = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).split(' ');
    const state = f[0];
    const ppid = Number(f[1]);
    const utime = Number(f[11]);
    const stime = Number(f[12]);
    const threads = Number(f[17]);
    const start = Number(f[19]) / CLK_TCK;
    const rss = Number(f[21]) * pageSize;
    // proot gibi ortamlarda /proc/uptime sahte olabilir → negatif süreyi gösterme
    const elapsed = uptime - start > 0 ? uptime - start : 0;
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    return {
      pid,
      ppid,
      uid,
      name,
      cmd: cmdline.replace(/\0+$/, '').replace(/\0/g, ' ') || `[${name}]`,
      state,
      ticks: utime + stime,
      cpu: 0,
      rss,
      mem: Math.round((rss / totalMem) * 1000) / 10,
      elapsed: Math.round(elapsed),
      threads,
    };
  } catch {
    return null;
  }
}

const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2']);

export default async function processRoutes(app: FastifyInstance) {
  app.get('/api/proc', async () => {
    if (!previous || performance.now() - previous.at > 30_000) {
      const first = await snapshot();
      previous = { at: first.at, ticks: new Map(first.procs.map((p) => [p.pid, p.ticks])) };
      await new Promise((r) => setTimeout(r, 400));
    }
    const { at, procs } = await snapshot();
    const dt = (at - previous.at) / 1000;
    for (const p of procs) {
      const before = previous.ticks.get(p.pid);
      p.cpu = before === undefined || dt <= 0 ? 0 : Math.round(((p.ticks - before) / CLK_TCK / dt) * 1000) / 10;
    }
    previous = { at, ticks: new Map(procs.map((p) => [p.pid, p.ticks])) };
    const processes = procs.map(({ ticks: _t, ...p }) => p);
    return { processes, self: process.pid, uid: process.getuid?.() ?? -1 };
  });

  app.post<{ Params: { pid: string } }>('/api/proc/:pid/signal', async (req) => {
    const pid = Number(req.params.pid);
    const signal = String((req.body as { signal?: string })?.signal ?? 'SIGTERM');
    if (!Number.isInteger(pid) || pid <= 1) throw new HttpError(400, 'Geçersiz PID');
    if (!SIGNALS.has(signal)) throw new HttpError(400, 'Geçersiz sinyal');
    if (pid === process.pid) throw new HttpError(400, 'Panelin kendi sürecini buradan durduramazsın');
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch (e) {
      throw new HttpError(403, (e as Error).message);
    }
    return { ok: true };
  });
}
