import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { HOME, resolvePath } from '../env.js';
import { HttpError } from '../exec.js';

const MAX_EDIT_SIZE = 2 * 1024 * 1024;

interface Entry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  mode: string;
  target?: string;
}

function modeString(mode: number) {
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}

async function statEntry(dir: string, name: string): Promise<Entry> {
  const full = path.join(dir, name);
  try {
    const l = await fs.lstat(full);
    if (l.isSymbolicLink()) {
      const target = await fs.readlink(full).catch(() => undefined);
      // Link bir klasörü gösteriyorsa klasör gibi davran (ör. ~/storage/shared)
      const t = await fs.stat(full).catch(() => null);
      return {
        name,
        type: t?.isDirectory() ? 'dir' : 'link',
        size: t?.size ?? 0,
        mtime: l.mtimeMs,
        mode: modeString(l.mode),
        target,
      };
    }
    return {
      name,
      type: l.isDirectory() ? 'dir' : l.isFile() ? 'file' : 'other',
      size: l.size,
      mtime: l.mtimeMs,
      mode: modeString(l.mode),
    };
  } catch {
    return { name, type: 'other', size: 0, mtime: 0, mode: '?????????' };
  }
}

function isBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function body<T>(b: unknown): T {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Geçersiz istek gövdesi');
  return b as T;
}

export default async function fileRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/fs/list', async (req) => {
    const dir = resolvePath(req.query.path);
    const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => {
      throw new HttpError(e.code === 'ENOENT' ? 404 : 403, `${dir}: ${e.code}`);
    });
    const entries = await Promise.all(names.map((n) => statEntry(dir, n)));
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: dir, parent: dir === '/' ? null : path.dirname(dir), home: HOME, entries };
  });

  app.get<{ Querystring: { path: string } }>('/api/fs/read', async (req) => {
    const file = resolvePath(req.query.path);
    const st = await fs.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'Bu bir dosya değil');
    if (st.size > MAX_EDIT_SIZE) throw new HttpError(413, 'Dosya düzenlemek için çok büyük (2 MB sınırı)');
    const buf = await fs.readFile(file);
    if (isBinary(buf)) throw new HttpError(415, 'İkili (binary) dosya düzenlenemez');
    return { path: file, content: buf.toString('utf8'), mtime: st.mtimeMs };
  });

  app.put('/api/fs/write', async (req) => {
    const { path: p, content, create } = body<{ path: string; content: string; create?: boolean }>(req.body);
    const file = resolvePath(p);
    if (create) {
      await fs.writeFile(file, content ?? '', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        throw new HttpError(409, e.code === 'EEXIST' ? 'Bu isimde bir dosya zaten var' : e.message);
      });
    } else {
      await fs.writeFile(file, content ?? '');
    }
    return { ok: true };
  });

  app.post('/api/fs/mkdir', async (req) => {
    const { path: p } = body<{ path: string }>(req.body);
    await fs.mkdir(resolvePath(p), { recursive: true });
    return { ok: true };
  });

  app.post('/api/fs/rename', async (req) => {
    const { from, to } = body<{ from: string; to: string }>(req.body);
    const dest = resolvePath(to);
    if (await fs.stat(dest).catch(() => null)) throw new HttpError(409, 'Hedefte aynı isimde bir öğe var');
    await fs.rename(resolvePath(from), dest).catch(async (e: NodeJS.ErrnoException) => {
      // Farklı dosya sistemleri arası taşıma (ör. home → sdcard)
      if (e.code !== 'EXDEV') throw e;
      await fs.cp(resolvePath(from), dest, { recursive: true });
      await fs.rm(resolvePath(from), { recursive: true, force: true });
    });
    return { ok: true };
  });

  app.post('/api/fs/copy', async (req) => {
    const { from, to } = body<{ from: string; to: string }>(req.body);
    const dest = resolvePath(to);
    if (await fs.stat(dest).catch(() => null)) throw new HttpError(409, 'Hedefte aynı isimde bir öğe var');
    await fs.cp(resolvePath(from), dest, { recursive: true });
    return { ok: true };
  });

  app.post('/api/fs/delete', async (req) => {
    const { paths } = body<{ paths: string[] }>(req.body);
    for (const p of paths) {
      const full = resolvePath(p);
      if (full === '/' || full === HOME) throw new HttpError(400, `${full} silinemez`);
      await fs.rm(full, { recursive: true, force: true });
    }
    return { ok: true };
  });

  app.post('/api/fs/chmod', async (req) => {
    const { path: p, mode } = body<{ path: string; mode: string }>(req.body);
    if (!/^[0-7]{3,4}$/.test(mode)) throw new HttpError(400, 'Mod sekizlik olmalı (ör. 755)');
    await fs.chmod(resolvePath(p), parseInt(mode, 8));
    return { ok: true };
  });

  app.get<{ Querystring: { path: string; inline?: string } }>('/api/fs/download', async (req, reply) => {
    const file = resolvePath(req.query.path);
    const st = await fs.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'Bu bir dosya değil');
    const name = encodeURIComponent(path.basename(file));
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    reply.type(req.query.inline ? guessType(file) : 'application/octet-stream');
    // Önizlenen dosyalar (ör. SVG) panel oturumunda script çalıştıramasın
    reply.header('Content-Security-Policy', 'sandbox');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(file));
  });

  app.post<{ Querystring: { dir?: string } }>('/api/fs/upload', async (req) => {
    const dir = resolvePath(req.query.dir);
    const saved: string[] = [];
    for await (const part of req.files()) {
      const name = path.basename(part.filename);
      if (!name) continue;
      await pipeline(part.file, createWriteStream(path.join(dir, name)));
      saved.push(name);
    }
    return { ok: true, saved };
  });
}

function guessType(file: string) {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}
