import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { config, updateConfig, type ClaudeRc } from '../config.js';
import { PREFIX, which } from '../env.js';
import { HttpError } from '../exec.js';
import { NAME_RE, PD_BIN, activeBinds, alive, bindArgs, descendants, getTarget, listDistros, pdStatus, sleep } from '../targets.js';
import { SVDIR, SV_LOGDIR, sv, svAvailable, svStatus } from './services.js';

/**
 * `claude rc` (Remote Control) için termux-services (runit) servisi.
 * Panelden bağımsız çalışır: panel yeniden başlasa da sürer, çökerse runit yeniden başlatır,
 * çıktısı svlogd ile $PREFIX/var/log/sv/claude-rc altında tutulur.
 */

const NAME = 'claude-rc';
const DIR = path.join(SVDIR, NAME);
const SH = path.join(PREFIX, 'bin/sh');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const CLAUDE_PATHS = ['root/.local/bin/claude', 'usr/local/bin/claude', 'usr/bin/claude'];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]|\r/g;
const URL_RE = /https:\/\/claude\.ai\/[^\s'"<>`)\]]+/g;

function defaults(): ClaudeRc {
  const bind = activeBinds()[0];
  return { distro: 'debian', cwd: bind?.dst ?? '/root', command: 'claude rc', tty: true };
}

function validate(b: Partial<ClaudeRc>): ClaudeRc {
  const distro = String(b.distro ?? '');
  const cwd = String(b.cwd ?? '').trim();
  const command = String(b.command ?? '').trim();
  if (!NAME_RE.test(distro)) throw new HttpError(400, 'Geçersiz distro adı');
  if (!/^\/[^\0\n]*$/.test(cwd)) throw new HttpError(400, 'Çalışma klasörü / ile başlayan bir yol olmalı');
  if (!command || /[\0\n]/.test(command)) throw new HttpError(400, 'Komut tek satır olmalı');
  return { distro, cwd, command, tty: b.tty !== false };
}

/** runit'in çalıştıracağı betik. Distro içinde: klasöre gir, (isteğe bağlı) sahte TTY ile komutu çalıştır. */
function runScript(c: ClaudeRc) {
  // Debian'da root için ~/.local/bin (native installer) PATH'te olmayabilir
  // stdin /dev/null: script çocuk bitene kadar bekler ve onun çıkış koduyla çıkar
  // (boru ya da hiç kapanmayan stdin ile script çocuk bitse de takılı kalıyor)
  const cmd = c.tty ? `exec script -qfec ${shq(c.command)} /dev/null </dev/null` : `exec ${c.command} </dev/null`;
  const inner = `export PATH="$HOME/.local/bin:$PATH"; mkdir -p ${shq(c.cwd)} && cd ${shq(c.cwd)} && ${cmd}`;
  const login = [PD_BIN!, 'login', c.distro, ...bindArgs(), '--', '/bin/bash', '-lc', inner].map(shq).join(' ');
  return `#!${SH}
# Termux Panel tarafından oluşturuldu. Panelden düzenle: Menü → Claude
exec 2>&1
# Android Termux'u uyutmasın
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
echo "==> ${c.distro}:${c.cwd} · ${c.command.replace(/[`$"\\]/g, '')}"
exec ${login}
`;
}

// Hata ile çıkınca (ör. giriş yapılmamış) saniyede bir yeniden başlamasın
const FINISH = `#!${SH}
[ "$1" -gt 0 ] 2>/dev/null && sleep 10
exit 0
`;

const LOG_RUN = `#!${SH}
mkdir -p "${SV_LOGDIR}/${NAME}"
exec svlogd -tt "${SV_LOGDIR}/${NAME}"
`;

async function writeService(c: ClaudeRc) {
  await fsp.mkdir(path.join(DIR, 'log'), { recursive: true });
  const files: [string, string][] = [
    ['run', runScript(c)],
    ['finish', FINISH],
    ['log/run', LOG_RUN],
  ];
  for (const [f, content] of files) {
    await fsp.writeFile(path.join(DIR, f), content, { mode: 0o755 });
    await fsp.chmod(path.join(DIR, f), 0o755);
  }
}

/** runsvdir yeni klasörü en geç ~5 sn'de fark eder; supervise hazır olana kadar bekle */
async function waitSupervise() {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(DIR, 'supervise/ok'))) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Servisi durdurur. runit TERM'i yalnızca ana sürece gönderir; proot içindeki claude
 * geride kalabileceği için süreç ağacı önceden alınır ve kalanlar kapatılır.
 */
async function stop() {
  const st = await svStatus(NAME);
  const tree = st.pid ? [st.pid, ...(await descendants(st.pid))] : [];
  await sv(['down', NAME]);
  if (!tree.length) return;
  for (let i = 0; i < 30 && tree.some(alive); i++) await sleep(100);
  for (const p of tree.reverse()) signal(p, 'SIGTERM');
  for (let i = 0; i < 15 && tree.some(alive); i++) await sleep(100);
  for (const p of tree) signal(p, 'SIGKILL');
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    if (alive(pid)) process.kill(pid, sig);
  } catch {
    /* zaten bitmiş */
  }
};

async function readLog() {
  const txt = await fsp.readFile(path.join(SV_LOGDIR, NAME, 'current'), 'utf8').catch(() => '');
  const clean = txt.slice(-256 * 1024).replace(ANSI_RE, '');
  const urls = [...new Set((clean.match(URL_RE) ?? []).reverse())].slice(0, 3);
  const lines = clean.split('\n').filter((l) => l.replace(/^\S+\s/, '').trim());
  return { log: lines.slice(-300).join('\n'), urls };
}

export default async function claudeRoutes(app: FastifyInstance) {
  app.get('/api/claude-rc', async () => {
    const [available, distros, phantom] = await Promise.all([svAvailable(), listDistros(), phantomStatus()]);
    const installed = fs.existsSync(path.join(DIR, 'run'));
    const status = available && installed ? await svStatus(NAME) : null;
    return {
      svAvailable: available,
      pd: pdStatus(),
      installed,
      status,
      config: config.claudeRc ?? defaults(),
      distros: distros.map((d) => ({
        name: d.name,
        os: d.os,
        claude: CLAUDE_PATHS.some((p) => fs.existsSync(path.join(d.rootfs, p))),
        loggedIn: fs.existsSync(path.join(d.rootfs, 'root/.claude/.credentials.json')),
      })),
      binds: activeBinds(),
      wakeLock: Boolean(which('termux-wake-lock')),
      phantom,
      ...(installed ? await readLog() : { log: '', urls: [] }),
    };
  });

  /** Kur ya da ayarları güncelle; servis çalışıyorsa yeni ayarlarla yeniden başlar */
  app.put('/api/claude-rc', async (req) => {
    if (!(await svAvailable())) throw new HttpError(501, 'termux-services kurulu değil ya da Termux yeniden başlatılmadı');
    const st = pdStatus();
    if (!st.available) throw new HttpError(501, st.reason ?? 'proot-distro kullanılamıyor');
    const c = validate((req.body ?? {}) as Partial<ClaudeRc>);
    await getTarget(c.distro); // distro var mı
    const fresh = !fs.existsSync(path.join(DIR, 'run'));
    if (!fresh) await stop();
    await writeService(c);
    updateConfig({ claudeRc: c });
    if (!(await waitSupervise())) throw new HttpError(500, 'Servis oluşturuldu ama runit görmedi. Termux\'u yeniden başlatmayı dene.');
    await sv(['up', NAME]);
    return { ok: true };
  });

  app.post<{ Params: { action: string } }>('/api/claude-rc/:action', async (req) => {
    if (!fs.existsSync(path.join(DIR, 'run'))) throw new HttpError(404, 'Servis kurulu değil');
    const a = req.params.action;
    if (a === 'up') await sv(['up', NAME]);
    else if (a === 'down') await stop();
    else if (a === 'restart') {
      await stop();
      await sv(['up', NAME]);
    } else if (a === 'clear-log') {
      await fsp.writeFile(path.join(SV_LOGDIR, NAME, 'current'), '').catch(() => {});
    } else throw new HttpError(400, 'Geçersiz işlem');
    return { ok: true };
  });

  app.delete('/api/claude-rc', async () => {
    if (fs.existsSync(DIR)) {
      await stop().catch(() => {});
      // Klasör silinince runsvdir servisin runsv'sini de kapatır
      await fsp.rm(DIR, { recursive: true, force: true });
    }
    return { ok: true };
  });
}
