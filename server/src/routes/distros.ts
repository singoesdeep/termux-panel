import type { FastifyInstance } from 'fastify';
import { resolvePath } from '../env.js';
import { HttpError, run } from '../exec.js';
import { startJob } from '../jobs.js';
import { NAME_RE, PD_BIN, PD_ROOT, activeBinds, killPd, listDistros, listSessions, pdStatus } from '../targets.js';
import { terminalPids } from '../terminal.js';

// Docker/OCI imaj referansı: "ubuntu:24.04", "ghcr.io/org/img:tag", v4 için düz takma ad
const IMAGE_RE = /^[a-z0-9][\w./:@-]{0,199}$/i;

function requirePd() {
  const st = pdStatus();
  if (!st.available) throw new HttpError(501, st.reason ?? 'proot-distro kullanılamıyor');
  return PD_BIN!;
}

async function requireDistro(name: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Geçersiz distro adı');
  const d = (await listDistros()).find((x) => x.name === name);
  if (!d) throw new HttpError(404, `"${name}" adında kurulu distro yok`);
  return d;
}

const pdJob = (title: string, args: string[]) => startJob(title, requirePd(), args, { env: { NO_COLOR: '1' } });

export default async function distroRoutes(app: FastifyInstance) {
  app.get('/api/distros', async () => {
    const st = pdStatus();
    const [distros, sessions] = await Promise.all([listDistros(), listSessions()]);
    const panel = terminalPids();
    return { ...st, root: PD_ROOT, binds: activeBinds(), distros, sessions: sessions.map((s) => ({ ...s, panelTerminal: panel.get(s.pid) ?? null })) };
  });

  app.get<{ Params: { name: string } }>('/api/distros/:name/size', async (req) => {
    const d = await requireDistro(req.params.name);
    const r = await run('du', ['-sk', d.rootfs], { timeout: 180000 });
    const kb = Number(r.stdout.trim().split(/\s+/)[0]);
    if (!kb) throw new HttpError(500, r.stderr.trim() || 'Boyut hesaplanamadı');
    return { size: kb * 1024 };
  });

  app.get<{ Querystring: { q?: string } }>('/api/distros/search', async (req) => {
    const bin = requirePd();
    const q = (req.query.q ?? '').trim();
    if (!q || !IMAGE_RE.test(q)) return { results: [] };
    const r = await run(bin, ['search', q, '--quiet', '--limit', '25'], { timeout: 45000 });
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Arama başarısız');
    return { results: r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
  });

  app.post('/api/distros/install', async (req) => {
    const b = (req.body ?? {}) as { image?: string; name?: string };
    const image = (b.image ?? '').trim();
    if (!IMAGE_RE.test(image)) throw new HttpError(400, 'Geçersiz imaj adı');
    const args = ['install', image];
    if (b.name) {
      if (!NAME_RE.test(b.name)) throw new HttpError(400, 'Geçersiz container adı');
      args.push('--name', b.name);
    }
    return pdJob(`Distro kuruluyor: ${image}`, args);
  });

  app.post('/api/distros/restore', async (req) => {
    const archive = String((req.body as { archive?: string })?.archive ?? '').trim();
    if (!archive) throw new HttpError(400, 'Yedek dosyası gerekli');
    return pdJob('Yedek geri yükleniyor', ['restore', resolvePath(archive)]);
  });

  app.post('/api/distros/clear-cache', async () => pdJob('İndirme önbelleği temizleniyor', ['clear-cache']));

  app.post<{ Params: { name: string } }>('/api/distros/:name/remove', async (req) => {
    const d = await requireDistro(req.params.name);
    return pdJob(`Distro kaldırılıyor: ${d.name}`, ['remove', d.name]);
  });

  app.post<{ Params: { name: string } }>('/api/distros/:name/reset', async (req) => {
    const d = await requireDistro(req.params.name);
    return pdJob(`Distro sıfırlanıyor: ${d.name}`, ['reset', d.name]);
  });

  app.post<{ Params: { name: string } }>('/api/distros/:name/backup', async (req) => {
    const d = await requireDistro(req.params.name);
    const output = String((req.body as { output?: string })?.output ?? '').trim();
    if (!output) throw new HttpError(400, 'Hedef dosya gerekli');
    return pdJob(`Yedekleniyor: ${d.name}`, ['backup', d.name, '--output', resolvePath(output)]);
  });

  app.post<{ Params: { name: string } }>('/api/distros/:name/rename', async (req) => {
    const d = await requireDistro(req.params.name);
    const to = String((req.body as { to?: string })?.to ?? '').trim();
    if (!NAME_RE.test(to)) throw new HttpError(400, 'Geçersiz yeni ad');
    const r = await run(requirePd(), ['rename', d.name, to], { timeout: 60000, env: { NO_COLOR: '1' } });
    if (r.code !== 0) throw new HttpError(500, (r.stderr || r.stdout).trim() || 'Yeniden adlandırılamadı');
    return { ok: true };
  });

  app.post<{ Params: { pid: string } }>('/api/distros/sessions/:pid/kill', async (req) => {
    const pid = Number(req.params.pid);
    // Yalnızca proot-distro'nun kaydettiği oturumlar öldürülebilir
    if (!(await listSessions()).some((s) => s.pid === pid)) throw new HttpError(404, 'Oturum bulunamadı');
    await killPd({ pid });
    return { ok: true };
  });

  /** Bir distronun tüm oturumlarını kapatır (distroyu "durdurur"). */
  app.post<{ Params: { name: string } }>('/api/distros/:name/stop', async (req) => {
    const d = await requireDistro(req.params.name);
    await killPd({ name: d.name });
    return { ok: true };
  });
}
