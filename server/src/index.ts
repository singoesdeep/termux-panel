import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyRequest } from 'fastify';
import { CONFIG_DIR, config } from './config.js';
import { HttpError } from './exec.js';
import projectRoutes from './routes/projects.js';
import deviceRoutes from './routes/device.js';
import distroRoutes from './routes/distros.js';
import devtoolRoutes from './routes/devtools.js';
import fileRoutes from './routes/files.js';
import miscRoutes from './routes/misc.js';
import packageRoutes from './routes/packages.js';
import processRoutes from './routes/processes.js';
import serviceRoutes from './routes/services.js';
import setupRoutes from './routes/setup.js';
import systemRoutes from './routes/system.js';

const COOKIE = 'tp_auth';
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

/** Arayüz derlemesinin kimliği: değişince açık sekmeler "yenile" uyarısı gösterir */
function buildId() {
  try {
    return String(fs.statSync(path.join(WEB_DIR, 'index.html')).mtimeMs);
  } catch {
    return 'dev';
  }
}

const app = Fastify({ logger: { level: process.env.TP_LOG ?? 'warn' }, bodyLimit: 16 * 1024 * 1024 });

await app.register(cookie);
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

function tokenOk(value: string | undefined) {
  if (!value) return false;
  const a = crypto.createHash('sha256').update(value).digest();
  const b = crypto.createHash('sha256').update(config.token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** DNS rebinding'e karşı: yalnızca IP adresi veya localhost ile gelen isteklere izin ver. */
function hostOk(req: FastifyRequest) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || net.isIP(host) !== 0 || host === config.host;
}

app.addHook('onRequest', async (req, reply) => {
  if (!hostOk(req)) return reply.code(403).send({ error: 'Geçersiz Host başlığı' });
  const url = req.url;
  if (!url.startsWith('/api/') && !url.startsWith('/ws/')) return;
  if (url.startsWith('/api/auth/')) return;
  if (!config.auth) return;
  if (tokenOk(req.cookies[COOKIE])) return;
  return reply.code(401).send({ error: 'Giriş gerekli' });
});

app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
  const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const codeMap: Record<string, number> = { ENOENT: 404, EACCES: 403, EPERM: 403, EEXIST: 409, ENOTDIR: 400, EISDIR: 400 };
  const final = err.code && codeMap[err.code] ? codeMap[err.code] : status;
  if (final >= 500) app.log.error(err);
  reply.code(final).send({ error: err.message });
});

// ---- Giriş ----
const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, maxAge: 60 * 60 * 24 * 365 };

app.get('/api/auth/status', async (req) => ({
  authenticated: !config.auth || tokenOk(req.cookies[COOKIE]),
  authRequired: config.auth,
  build: buildId(),
}));

app.post('/api/auth/login', async (req, reply) => {
  const token = String((req.body as { token?: string })?.token ?? '').trim();
  if (!tokenOk(token)) {
    await new Promise((r) => setTimeout(r, 800)); // kaba kuvvete karşı küçük gecikme
    return reply.code(401).send({ error: 'Token hatalı' });
  }
  reply.setCookie(COOKIE, token, cookieOpts);
  return { ok: true };
});

app.post('/api/auth/logout', async (_req, reply) => {
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

await app.register(systemRoutes);
await app.register(fileRoutes);
await app.register(packageRoutes);
await app.register(processRoutes);
await app.register(serviceRoutes);
await app.register(devtoolRoutes);
await app.register(deviceRoutes);
await app.register(distroRoutes);
await app.register(setupRoutes);
await app.register(projectRoutes);
await app.register(miscRoutes);

// ---- Arayüz ----
if (fs.existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, { root: WEB_DIR, wildcard: true, index: false });
  // /?token=... ile gelindiyse çerezi yaz ve temiz adrese yönlendir
  app.get('/', async (req, reply) => {
    const t = (req.query as { token?: string }).token;
    if (t && tokenOk(t)) {
      reply.setCookie(COOKIE, t, cookieOpts);
      return reply.redirect('/');
    }
    return reply.sendFile('index.html');
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'Bulunamadı' });
    return reply.sendFile('index.html');
  });
} else {
  app.get('/', async () => 'Arayüz derlenmemiş. Önce `npm run build` çalıştırın (geliştirme için `npm run dev`).');
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} kullanımda. TP_PORT=xxxx ile başka port seçin.` : err.message);
  // Servis olarak çalışırken (runit her çıkışta yeniden başlatır) elle açılmış panel portu
  // tutuyorsa saniyede bir denemek yerine bekle
  if (process.env.TP_SERVICE && err.code === 'EADDRINUSE') await new Promise((r) => setTimeout(r, 15_000));
  process.exit(1);
}

const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const url = `http://${shown}:${config.port}`;
console.log(`\n  Termux Panel çalışıyor → ${url}`);
if (config.auth) {
  console.log(`  Otomatik giriş bağlantısı: ${url}/?token=${config.token}`);
  console.log(`  Token: ${config.token}  (${path.join(CONFIG_DIR, 'config.json')})`);
} else {
  console.log('  Uyarı: kimlik doğrulama kapalı (TP_NO_AUTH).');
}
if (config.host === '0.0.0.0') console.log('  Uyarı: panel ağdaki diğer cihazlara açık.');
console.log('');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
