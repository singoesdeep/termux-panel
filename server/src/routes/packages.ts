import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { APT_ENV, APT_OPTS } from '../env.js';
import { HttpError } from '../exec.js';
import { startJobIn } from '../jobs.js';
import { aptBin, dpkgRoot, getTarget, runIn, type Target } from '../targets.js';

const NAME_RE = /^[a-z0-9][a-z0-9+.\-:]*$/i;

function checkNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length === 0) throw new HttpError(400, 'Paket adı gerekli');
  for (const n of names) {
    if (typeof n !== 'string' || !NAME_RE.test(n)) throw new HttpError(400, `Geçersiz paket adı: ${n}`);
  }
  return names as string[];
}

/** Debian kontrol dosyası biçimini (boş satırla ayrılmış "Alan: değer" blokları) ayrıştırır. */
function parseStanzas(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  let last = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      if (Object.keys(cur).length) out.push(cur);
      cur = {};
      last = '';
    } else if (line[0] === ' ' || line[0] === '\t') {
      if (last) cur[last] += '\n' + line.trim();
    } else {
      const i = line.indexOf(':');
      if (i > 0) cur[(last = line.slice(0, i))] = line.slice(i + 1).trim();
    }
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}

/**
 * Kurulu paketleri dpkg veritabanından doğrudan okur. Distroda proot başlatmaktan
 * çok daha hızlıdır ve Termux'ta da aynı şekilde çalışır.
 */
async function readInstalled(t: Target) {
  const root = dpkgRoot(t);
  const status = await fs.readFile(path.join(root, 'var/lib/dpkg/status'), 'utf8').catch(() => {
    throw new HttpError(501, 'dpkg veritabanı bulunamadı (apt tabanlı olmayan bir sistem olabilir)');
  });
  const ext = await fs.readFile(path.join(root, 'var/lib/apt/extended_states'), 'utf8').catch(() => '');
  const auto = new Set(parseStanzas(ext).filter((s) => s['Auto-Installed'] === '1').map((s) => s.Package));
  return parseStanzas(status)
    .filter((s) => s.Status?.endsWith(' installed'))
    .map((s) => ({
      name: s.Package,
      version: s.Version ?? '',
      size: Number(s['Installed-Size'] ?? 0) * 1024,
      summary: (s.Description ?? '').split('\n')[0],
      manual: !auto.has(s.Package),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Req = { Querystring: { env?: string; q?: string }; Body: { env?: string; names?: unknown } };

export default async function packageRoutes(app: FastifyInstance) {
  app.get<Req>('/api/pkg/installed', async (req) => ({ packages: await readInstalled(await getTarget(req.query.env)) }));

  app.get<Req>('/api/pkg/search', async (req) => {
    const t = await getTarget(req.query.env);
    aptBin(t);
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return { packages: [] };
    const [r, inst] = await Promise.all([runIn(t, 'apt-cache', ['search', '--', q], { timeout: 30000 }), readInstalled(t)]);
    if (r.code !== 0 && !r.stdout) throw new HttpError(500, r.stderr.trim() || 'Arama başarısız');
    const names = new Set(inst.map((p) => p.name));
    const packages = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(' - ');
        const name = i > 0 ? l.slice(0, i) : l;
        return { name, summary: i > 0 ? l.slice(i + 3) : '', installed: names.has(name) };
      })
      // İsimde geçenler önce
      .sort((a, b) => Number(b.name.includes(q)) - Number(a.name.includes(q)) || a.name.length - b.name.length)
      .slice(0, 150);
    return { packages };
  });

  app.get<Req>('/api/pkg/upgradable', async (req) => {
    const t = await getTarget(req.query.env);
    aptBin(t);
    const r = await runIn(t, 'apt', ['list', '--upgradable'], { timeout: 30000 });
    const packages = r.stdout
      .split('\n')
      .map((l) => /^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => ({ name: m[1], version: m[2], from: m[3] }));
    return { packages };
  });

  app.get<Req & { Params: { name: string } }>('/api/pkg/show/:name', async (req) => {
    const t = await getTarget(req.query.env);
    aptBin(t);
    const [name] = checkNames([req.params.name]);
    const r = await runIn(t, 'apt-cache', ['show', '--no-all-versions', name], { timeout: 30000 });
    if (r.code !== 0) throw new HttpError(404, 'Paket bulunamadı');
    const [fields = {}] = parseStanzas(r.stdout);
    return { fields };
  });

  const job = async (env: unknown, title: string, args: (pkg: string) => string[]) => {
    const t = await getTarget(env);
    const pkg = aptBin(t);
    return startJobIn(t, title, pkg, args(pkg), { env: APT_ENV });
  };

  app.post<Req>('/api/pkg/update', async (req) =>
    job(req.body?.env, 'Depolar güncelleniyor', (pkg) => ['update', ...(pkg === 'pkg' ? [] : ['-y'])]),
  );

  app.post<Req>('/api/pkg/install', async (req) => {
    const names = checkNames(req.body?.names);
    return job(req.body?.env, `Kuruluyor: ${names.join(', ')}`, () => ['install', ...APT_OPTS, ...names]);
  });

  app.post<Req>('/api/pkg/remove', async (req) => {
    const names = checkNames(req.body?.names);
    return job(req.body?.env, `Kaldırılıyor: ${names.join(', ')}`, (pkg) => [pkg === 'pkg' ? 'uninstall' : 'remove', '-y', ...names]);
  });

  app.post<Req>('/api/pkg/upgrade', async (req) => {
    const names = req.body?.names;
    if (Array.isArray(names) && names.length) {
      const n = checkNames(names);
      return job(req.body?.env, `Güncelleniyor: ${n.join(', ')}`, () => ['install', '--only-upgrade', ...APT_OPTS, ...n]);
    }
    return job(req.body?.env, 'Tüm paketler güncelleniyor', (pkg) => [pkg === 'pkg' ? 'upgrade' : 'full-upgrade', ...APT_OPTS]);
  });

  app.post<Req>('/api/pkg/autoremove', async (req) => job(req.body?.env, 'Gereksiz paketler temizleniyor', () => ['autoremove', '-y']));
}
