import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { phantomStatus } from '../android.js';
import { config, updateConfig, type ClaudeRc } from '../config.js';
import { HOME, PREFIX, resolvePath, which } from '../env.js';
import { HttpError } from '../exec.js';
import { alive, descendants, sleep } from '../targets.js';
import { claudeState } from './setup.js';
import { SVDIR, SV_LOGDIR, sv, svAvailable, svStatus } from './services.js';

/**
 * `claude rc` (Remote Control) için termux-services (runit) servisi. Claude Code doğrudan
 * Termux'ta çalışır (claude-code-android kurulumu, $PREFIX/bin/claude).
 * Panelden bağımsız çalışır: panel yeniden başlasa da sürer, çökerse runit yeniden başlatır,
 * çıktısı svlogd ile $PREFIX/var/log/sv/claude-rc altında tutulur.
 */

const NAME = 'claude-rc';
const DIR = path.join(SVDIR, NAME);
const SH = path.join(PREFIX, 'bin/sh');
const BASH = path.join(PREFIX, 'bin/bash');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]|\r/g;
const URL_RE = /https:\/\/claude\.ai\/[^\s'"<>`)\]]+/g;

function defaults(): ClaudeRc {
  const bind = config.binds[0];
  return { cwd: bind ? resolvePath(bind.src) : HOME, command: 'claude rc', tty: true };
}

/** Eski sürümde servis bir distroda çalışıyordu (distro alanı ve distro içi yol) */
const isLegacy = (c: ClaudeRc | undefined) => Boolean(c?.distro);

function validate(b: Partial<ClaudeRc>): ClaudeRc {
  const raw = String(b.cwd ?? '').trim();
  const command = String(b.command ?? '').trim();
  if (!raw || /[\0\n]/.test(raw) || !(raw.startsWith('/') || raw === '~' || raw.startsWith('~/'))) throw new HttpError(400, 'Çalışma klasörü / ya da ~ ile başlayan bir yol olmalı');
  if (!command || /[\0\n]/.test(command)) throw new HttpError(400, 'Komut tek satır olmalı');
  return { cwd: resolvePath(raw), command, tty: b.tty !== false };
}

/** runit'in çalıştıracağı betik. Termux'ta: klasöre gir, (isteğe bağlı) sahte TTY ile komutu çalıştır. */
function runScript(c: ClaudeRc) {
  // stdin /dev/null: script çocuk bitene kadar bekler ve onun çıkış koduyla çıkar
  // (boru ya da hiç kapanmayan stdin ile script çocuk bitse de takılı kalıyor)
  const run = c.tty ? `exec script -qfec ${shq(c.command)} /dev/null </dev/null` : `exec ${c.command} </dev/null`;
  // Giriş kabuğu (~/.profile'daki değişkenler için) PATH'i değiştirebilir; sonra yeniden ayarlanır.
  // ~/.local/bin: claude kendi "native" kurulum yolunu PATH'te arar
  const cmd = `export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"; ${run}`;
  return `#!${SH}
# Termux Panel tarafından oluşturuldu. Panelden düzenle: Menü → Claude
exec 2>&1
# Android Termux'u uyutmasın
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
export HOME=${shq(HOME)}
export PATH="${PREFIX}/bin:$PATH:$HOME/.local/bin"
unset CLAUDECODE CLAUDE_CODE_EXECPATH CLAUDE_CODE_ENTRYPOINT
echo "==> ${c.cwd.replace(/[`$"\\]/g, '')} · ${c.command.replace(/[`$"\\]/g, '')}"
mkdir -p ${shq(c.cwd)} && cd ${shq(c.cwd)} || exit 1
exec ${shq(BASH)} -lc ${shq(cmd)}
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
 * Servisi durdurur. runit TERM'i yalnızca ana sürece gönderir; claude'un alt
 * süreçleri geride kalabileceği için süreç ağacı önceden alınır ve kalanlar kapatılır.
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
    const [available, phantom] = await Promise.all([svAvailable(), phantomStatus()]);
    const installed = fs.existsSync(path.join(DIR, 'run'));
    const status = available && installed ? await svStatus(NAME) : null;
    const legacy = isLegacy(config.claudeRc);
    return {
      svAvailable: available,
      installed,
      // Eski distro servisinin distro adı (yeniden kaydedilince Termux'a taşınır)
      legacy: installed && legacy ? config.claudeRc!.distro! : null,
      status,
      config: config.claudeRc && !legacy ? config.claudeRc : defaults(),
      claude: claudeState(),
      folders: config.binds.map((b) => resolvePath(b.src)).filter((p) => fs.existsSync(p)),
      home: HOME,
      tty: Boolean(which('script')),
      wakeLock: Boolean(which('termux-wake-lock')),
      phantom,
      ...(installed ? await readLog() : { log: '', urls: [] }),
    };
  });

  /** Kur ya da ayarları güncelle; servis çalışıyorsa yeni ayarlarla yeniden başlar */
  app.put('/api/claude-rc', async (req) => {
    if (!(await svAvailable())) throw new HttpError(501, 'termux-services kurulu değil ya da Termux yeniden başlatılmadı');
    if (!claudeState().installed) throw new HttpError(501, 'Claude Code Termux\'ta kurulu değil. Kurulum sayfasından kur.');
    const c = validate((req.body ?? {}) as Partial<ClaudeRc>);
    if (c.tty && !which('script')) throw new HttpError(501, 'TTY için util-linux paketi (script komutu) gerekli');
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
