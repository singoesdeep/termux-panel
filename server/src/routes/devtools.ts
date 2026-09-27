import type { FastifyInstance } from 'fastify';
import { which } from '../env.js';
import { HttpError } from '../exec.js';
import { startJobIn } from '../jobs.js';
import { getTarget, pythonBin, runIn, type Target } from '../targets.js';

// pip: "requests==2.31", "numpy>=1", "git+https://..." gibi girdilere izin ver, kabuk karakterlerine değil
const PIP_RE = /^[\w.\-\[\],<>=!~+:/@]+$/;
// npm: "@scope/name@1.2.3"
const NPM_RE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.\-^~<>=*]+)?$/;

function checkList(names: unknown, re: RegExp): string[] {
  if (!Array.isArray(names) || names.length === 0) throw new HttpError(400, 'Paket adı gerekli');
  for (const n of names) {
    if (typeof n !== 'string' || !re.test(n) || n.startsWith('-')) throw new HttpError(400, `Geçersiz paket: ${n}`);
  }
  return names as string[];
}

const pip = (t: Target, ...args: string[]): [string, string[]] => [pythonBin(t), ['-m', 'pip', ...args]];

type Req = { Querystring: { env?: string }; Body: { env?: string; names?: unknown; upgrade?: boolean; breakSystem?: boolean } };

export default async function devtoolRoutes(app: FastifyInstance) {
  // ---- Python / pip ----
  app.get<Req>('/api/pip/list', async (req) => {
    const t = await getTarget(req.query.env);
    const [cmd, args] = pip(t, 'list', '--format=json', '--disable-pip-version-check');
    const [r, ver] = await Promise.all([runIn(t, cmd, args, { timeout: 90000 }), runIn(t, pythonBin(t), ['--version'])]);
    if (r.code !== 0) return { available: false, error: r.stderr.trim(), packages: [] };
    return { available: true, python: ver.stdout.trim(), packages: JSON.parse(r.stdout) };
  });

  app.get<Req>('/api/pip/outdated', async (req) => {
    const t = await getTarget(req.query.env);
    const [cmd, args] = pip(t, 'list', '--outdated', '--format=json', '--disable-pip-version-check');
    const r = await runIn(t, cmd, args, { timeout: 180000 });
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim());
    return { packages: JSON.parse(r.stdout) };
  });

  app.post<Req>('/api/pip/install', async (req) => {
    const b = req.body ?? {};
    const t = await getTarget(b.env);
    const names = checkList(b.names, PIP_RE);
    const extra = [...(b.upgrade ? ['--upgrade'] : []), ...(b.breakSystem ? ['--break-system-packages'] : [])];
    const [cmd, args] = pip(t, 'install', ...extra, ...names);
    return startJobIn(t, `pip install ${names.join(' ')}`, cmd, args);
  });

  app.post<Req>('/api/pip/uninstall', async (req) => {
    const b = req.body ?? {};
    const t = await getTarget(b.env);
    const names = checkList(b.names, PIP_RE);
    const [cmd, args] = pip(t, 'uninstall', '-y', ...(b.breakSystem ? ['--break-system-packages'] : []), ...names);
    return startJobIn(t, `pip uninstall ${names.join(' ')}`, cmd, args);
  });

  // ---- Node / npm (global) ----
  app.get<Req>('/api/npm/list', async (req) => {
    const t = await getTarget(req.query.env);
    if (t.kind === 'termux' && !which('npm')) return { available: false, packages: [] };
    const [r, ver] = await Promise.all([
      runIn(t, 'npm', ['ls', '-g', '--depth=0', '--json'], { timeout: 90000 }),
      t.kind === 'termux' ? Promise.resolve({ stdout: process.version }) : runIn(t, 'node', ['--version']),
    ]);
    try {
      const deps = (JSON.parse(r.stdout).dependencies ?? {}) as Record<string, { version?: string }>;
      return {
        available: true,
        node: ver.stdout.trim(),
        packages: Object.entries(deps).map(([name, d]) => ({ name, version: d.version ?? '?' })),
      };
    } catch {
      return { available: false, error: r.stderr.trim() || 'npm bulunamadı', packages: [] };
    }
  });

  app.get<Req>('/api/npm/outdated', async (req) => {
    const t = await getTarget(req.query.env);
    const r = await runIn(t, 'npm', ['outdated', '-g', '--json'], { timeout: 180000 });
    try {
      const data = JSON.parse(r.stdout || '{}') as Record<string, { current: string; latest: string }>;
      return { packages: Object.entries(data).map(([name, d]) => ({ name, version: d.current, latest: d.latest })) };
    } catch {
      throw new HttpError(500, r.stderr.trim() || 'npm outdated başarısız');
    }
  });

  app.post<Req>('/api/npm/install', async (req) => {
    const t = await getTarget(req.body?.env);
    const names = checkList(req.body?.names, NPM_RE);
    return startJobIn(t, `npm i -g ${names.join(' ')}`, 'npm', ['install', '-g', ...names]);
  });

  app.post<Req>('/api/npm/uninstall', async (req) => {
    const t = await getTarget(req.body?.env);
    const names = checkList(req.body?.names, NPM_RE);
    return startJobIn(t, `npm rm -g ${names.join(' ')}`, 'npm', ['uninstall', '-g', ...names]);
  });
}
