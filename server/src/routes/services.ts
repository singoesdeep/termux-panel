import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PREFIX, which } from '../env.js';
import { HttpError, run } from '../exec.js';

/** termux-services (runit) entegrasyonu */
export const SVDIR = process.env.SVDIR || path.join(PREFIX, 'var/service');
export const SV_LOGDIR = path.join(PREFIX, 'var/log/sv');
const env = { SVDIR };

export const sv = (args: string[]) => run('sv', args, { timeout: 15000, env });

export async function svAvailable() {
  return Boolean(which('sv')) && (await fs.stat(SVDIR).catch(() => null))?.isDirectory() === true;
}

function checkName(name: string) {
  if (!/^[\w.@-]+$/.test(name)) throw new HttpError(400, 'Geçersiz servis adı');
  return name;
}

export async function svStatus(name: string) {
  const dir = path.join(SVDIR, name);
  const r = await run('sv', ['status', dir], { timeout: 5000, env });
  const line = r.stdout.trim();
  const m = /^(\w+): [^:]+: (?:\(pid (\d+)\) )?(\d+)s/.exec(line);
  const enabled = !(await fs.stat(path.join(dir, 'down')).catch(() => null));
  const hasLog = Boolean(await fs.stat(path.join(dir, 'log')).catch(() => null));
  return {
    name,
    state: m?.[1] ?? 'unknown',
    pid: m?.[2] ? Number(m[2]) : null,
    seconds: m?.[3] ? Number(m[3]) : null,
    enabled,
    hasLog,
    raw: line || r.stderr.trim(),
  };
}

export default async function serviceRoutes(app: FastifyInstance) {
  app.get('/api/services', async () => {
    if (!(await svAvailable())) return { available: false, services: [] };
    const names = (await fs.readdir(SVDIR)).filter((n) => !n.startsWith('.'));
    const services = await Promise.all(names.map(svStatus));
    return { available: true, services };
  });

  app.post<{ Params: { name: string; action: string } }>('/api/services/:name/:action', async (req) => {
    const name = checkName(req.params.name);
    const { action } = req.params;
    let r;
    if (['up', 'down', 'restart', 'once'].includes(action)) r = await sv([action, name]);
    else if (action === 'enable') r = await run('sv-enable', [name], { timeout: 15000, env });
    else if (action === 'disable') r = await run('sv-disable', [name], { timeout: 15000, env });
    else throw new HttpError(400, 'Geçersiz işlem');
    if (r.code !== 0) throw new HttpError(500, r.stderr || r.stdout || 'İşlem başarısız');
    return { ok: true, output: r.stdout };
  });

  app.get<{ Params: { name: string } }>('/api/services/:name/log', async (req) => {
    const name = checkName(req.params.name);
    const file = path.join(SV_LOGDIR, name, 'current');
    const content = await fs.readFile(file, 'utf8').catch(() => null);
    if (content === null) return { content: '(log bulunamadı)' };
    return { content: content.slice(-64 * 1024) };
  });
}
