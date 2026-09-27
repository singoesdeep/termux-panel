import fs from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { HOME, PREFIX, PYTHON, SHELL, isTermux, which } from '../env.js';
import { run } from '../exec.js';
import { ptyBackend } from '../terminal.js';

async function readCpuTimes(): Promise<number[] | null> {
  try {
    const line = (await fs.readFile('/proc/stat', 'utf8')).split('\n')[0];
    return line.trim().split(/\s+/).slice(1).map(Number);
  } catch {
    return null;
  }
}

/** /proc/stat üzerinden anlık CPU kullanımı. Android 8+ bunu engelleyebilir → null. */
async function cpuUsage(): Promise<number | null> {
  const a = await readCpuTimes();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, 300));
  const b = await readCpuTimes();
  if (!b) return null;
  const idle = b[3] + (b[4] ?? 0) - (a[3] + (a[4] ?? 0));
  const total = b.reduce((s, v) => s + v, 0) - a.reduce((s, v) => s + v, 0);
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

async function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  let swapTotal = 0;
  let swapFree = 0;
  try {
    const info = await fs.readFile('/proc/meminfo', 'utf8');
    const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN) * 1024;
    if (!Number.isNaN(get('MemAvailable'))) available = get('MemAvailable');
    swapTotal = get('SwapTotal') || 0;
    swapFree = get('SwapFree') || 0;
  } catch {
    /* yok */
  }
  return { total, used: total - available, available, swapTotal, swapUsed: swapTotal - swapFree };
}

async function disks() {
  const candidates = [HOME, PREFIX, '/storage/emulated/0', '/sdcard'];
  const paths: string[] = [];
  for (const p of candidates) {
    try {
      await fs.access(p);
      paths.push(p);
    } catch {
      /* yok */
    }
  }
  const { stdout } = await run('df', ['-kP', ...paths], { timeout: 5000 });
  const seen = new Set<string>();
  const out: { mount: string; label: string; total: number; used: number; free: number }[] = [];
  const lines = stdout.trim().split('\n').slice(1);
  lines.forEach((line, i) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return;
    const mount = parts.slice(5).join(' ');
    if (seen.has(mount)) return;
    seen.add(mount);
    const p = paths[i] ?? mount;
    const label = p === HOME ? 'Home' : p === PREFIX ? 'Sistem ($PREFIX)' : p.includes('emulated') || p === '/sdcard' ? 'Dahili depolama' : mount;
    out.push({ mount, label, total: +parts[1] * 1024, used: +parts[2] * 1024, free: +parts[3] * 1024 });
  });
  return out;
}

let batteryCache: { at: number; value: unknown } | null = null;
let batteryPending: Promise<void> | null = null;

/**
 * Termux:API yanıtı saniyeler sürebiliyor (uygulama yoksa hiç gelmiyor). Bu yüzden
 * istek hiçbir zaman beklemez: eldeki son değer döner, yenisi arka planda alınır.
 */
function battery(): unknown {
  if (!which('termux-battery-status')) return null;
  const stale = !batteryCache || Date.now() - batteryCache.at > 30_000;
  if (stale && !batteryPending) {
    batteryPending = run('termux-battery-status', [], { timeout: 8000 })
      .then((r) => {
        let value: unknown = null;
        try {
          value = JSON.parse(r.stdout);
        } catch {
          /* API uygulaması yok */
        }
        batteryCache = { at: Date.now(), value };
      })
      .finally(() => {
        batteryPending = null;
      });
  }
  return batteryCache?.value ?? null;
}

function network() {
  try {
    const out: { name: string; address: string; family: string }[] = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (!a.internal) out.push({ name, address: a.address, family: a.family });
      }
    }
    return out;
  } catch {
    return []; // Android 11+ bazen izin vermiyor
  }
}

async function versions() {
  const v = async (cmd: string | null, args: string[]) => {
    if (!cmd) return null;
    const r = await run(cmd, args, { timeout: 4000 });
    return (r.stdout || r.stderr).trim().split('\n')[0] || null;
  };
  const [python, git] = await Promise.all([v(PYTHON, ['--version']), v(which('git'), ['--version'])]);
  return { node: process.version, python, git };
}

export default async function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/info', async () => {
    const [mem, disk, ver] = await Promise.all([memory(), disks(), versions()]);
    const cpus = os.cpus();
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      isTermux,
      termuxVersion: process.env.TERMUX_VERSION ?? null,
      home: HOME,
      prefix: PREFIX,
      shell: SHELL,
      ptyBackend,
      cpuModel: cpus[0]?.model ?? null,
      cpuCount: cpus.length,
      memory: mem,
      disks: disk,
      versions: ver,
      network: network(),
      termuxApi: Boolean(which('termux-battery-status')),
    };
  });

  app.get('/api/system/stats', async () => {
    const [cpu, mem] = await Promise.all([cpuUsage(), memory()]);
    const bat = battery();
    return { cpu, load: os.loadavg(), uptime: os.uptime(), memory: mem, battery: bat, time: Date.now() };
  });
}
