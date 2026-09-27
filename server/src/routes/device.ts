import type { FastifyInstance } from 'fastify';
import { which } from '../env.js';
import { HttpError, run } from '../exec.js';

/** Termux:API komutları. Hem `termux-api` paketi hem de Termux:API uygulaması gerekir. */
type Action = { bin: string; args: (b: Record<string, unknown>) => string[]; json?: boolean; stdin?: boolean };

const str = (v: unknown, max = 2000) => String(v ?? '').slice(0, max);

const actions: Record<string, Action> = {
  battery: { bin: 'termux-battery-status', args: () => [], json: true },
  wifi: { bin: 'termux-wifi-connectioninfo', args: () => [], json: true },
  location: { bin: 'termux-location', args: () => ['-p', 'network', '-r', 'once'], json: true },
  'clipboard-get': { bin: 'termux-clipboard-get', args: () => [] },
  'clipboard-set': { bin: 'termux-clipboard-set', args: (b) => [str(b.text, 100_000)] },
  torch: { bin: 'termux-torch', args: (b) => [b.on ? 'on' : 'off'] },
  vibrate: { bin: 'termux-vibrate', args: (b) => ['-d', String(Math.min(5000, Number(b.ms) || 300))] },
  toast: { bin: 'termux-toast', args: (b) => [str(b.text)] },
  notify: { bin: 'termux-notification', args: (b) => ['--title', str(b.title, 200), '--content', str(b.text)] },
  tts: { bin: 'termux-tts-speak', args: (b) => [str(b.text)] },
  volume: { bin: 'termux-volume', args: () => [], json: true },
  brightness: {
    bin: 'termux-brightness',
    args: (b) => [String(Math.max(0, Math.min(255, Number(b.value) || 0)))],
  },
  'wake-lock': { bin: 'termux-wake-lock', args: () => [] },
  'wake-unlock': { bin: 'termux-wake-unlock', args: () => [] },
};

export default async function deviceRoutes(app: FastifyInstance) {
  app.get('/api/device', async () => ({
    available: Boolean(which('termux-battery-status')),
    wakeLock: Boolean(which('termux-wake-lock')),
  }));

  app.post<{ Params: { action: string } }>('/api/device/:action', async (req) => {
    const a = actions[req.params.action];
    if (!a) throw new HttpError(404, 'Bilinmeyen işlem');
    if (!which(a.bin)) throw new HttpError(501, `${a.bin} bulunamadı. Kurulum: pkg install termux-api (+ Termux:API uygulaması)`);
    const r = await run(a.bin, a.args((req.body as Record<string, unknown>) ?? {}), { timeout: 15000 });
    if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || 'Komut başarısız (Termux:API uygulaması kurulu mu?)');
    if (a.json) {
      try {
        return { result: JSON.parse(r.stdout) };
      } catch {
        /* düz metin döndür */
      }
    }
    return { result: r.stdout };
  });
}
