import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config, saveSnippets, type Snippet } from '../config.js';
import { resolvePath } from '../env.js';
import { HttpError } from '../exec.js';
import { addJobListener, getJob, killJob, listJobs, removeJob, startShellJob } from '../jobs.js';
import { getTarget, type Target } from '../targets.js';
import { attach, createSession, killSession, listSessions } from '../terminal.js';

/** Distroda yol distronun içindedir (~ → root kullanıcısının home'u); Termux'ta ~ genişletilir. */
const cwdFor = (t: Target, cwd?: string) =>
  !cwd ? undefined : t.kind === 'termux' ? resolvePath(cwd) : cwd.replace(/^~(?=\/|$)/, '/root');

export default async function miscRoutes(app: FastifyInstance) {
  // ---- İşler (arka plan komutları) ----
  app.get('/api/jobs', async () => ({ jobs: listJobs() }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const j = getJob(req.params.id);
    if (!j) throw new HttpError(404, 'İş bulunamadı');
    return j;
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/kill', async (req) => ({ ok: killJob(req.params.id) }));
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req) => ({ ok: removeJob(req.params.id) }));
  app.get('/ws/jobs', { websocket: true }, (socket) => addJobListener(socket));

  // ---- Terminal oturumları ----
  app.get('/api/terminals', async () => ({ sessions: listSessions() }));
  app.post('/api/terminals', async (req) => {
    const b = (req.body ?? {}) as { cols?: number; rows?: number; command?: string; cwd?: string; env?: string };
    const target = await getTarget(b.env);
    return createSession({ cols: b.cols, rows: b.rows, command: b.command, cwd: cwdFor(target, b.cwd), target });
  });
  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (req) => ({ ok: await killSession(req.params.id) }));
  app.get<{ Params: { id: string } }>('/ws/terminal/:id', { websocket: true }, (socket, req) => attach(req.params.id, socket));

  // ---- Kısayollar (kayıtlı komutlar) ----
  app.get('/api/snippets', async () => ({ snippets: config.snippets }));
  app.put('/api/snippets', async (req) => {
    const list = (req.body as { snippets?: Snippet[] })?.snippets;
    if (!Array.isArray(list)) throw new HttpError(400, 'Liste gerekli');
    const clean = list
      .filter((s) => s && typeof s.name === 'string' && typeof s.command === 'string' && s.command.trim())
      .map((s) => ({
        id: s.id || crypto.randomBytes(4).toString('hex'),
        name: s.name.trim().slice(0, 80) || s.command.slice(0, 30),
        command: s.command,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.env && s.env !== 'termux' ? { env: s.env } : {}),
      }));
    saveSnippets(clean);
    return { snippets: clean };
  });
  app.post<{ Params: { id: string } }>('/api/snippets/:id/run', async (req) => {
    const s = config.snippets.find((x) => x.id === req.params.id);
    if (!s) throw new HttpError(404, 'Kısayol bulunamadı');
    const target = await getTarget(s.env);
    return startShellJob(s.name, s.command, cwdFor(target, s.cwd), target);
  });
  app.post('/api/run', async (req) => {
    const b = req.body as { command?: string; cwd?: string; env?: string };
    if (!b?.command?.trim()) throw new HttpError(400, 'Komut gerekli');
    const target = await getTarget(b.env);
    return startShellJob(b.command.slice(0, 60), b.command, cwdFor(target, b.cwd), target);
  });
}
