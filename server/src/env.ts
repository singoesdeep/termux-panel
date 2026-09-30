import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TERMUX_PREFIX = '/data/data/com.termux/files/usr';

/** Termux içinde doğrudan mı çalışıyoruz (proot içinde değil)? */
export const isTermux = Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX ?? '').includes('com.termux');

// Panel bir claude oturumundan başlatıldıysa bu değişkenler terminallere ve işlere geçip
// orada açılan claude'u "iç içe oturum" sanmaya itmesin
// (CLAUDE_CODE_OAUTH_TOKEN gibi kullanıcı ayarlarına dokunulmaz). BUN_OPTIONS: claude sarmalayıcısı
// buraya göreli bir --preload yolu yazar; başka klasörde açılan claude onu bulamayıp çıkar.
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'BUN_OPTIONS' || /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_|CHILD_SESSION|MESSAGING_)/.test(k)) delete process.env[k];
}

export const PREFIX = process.env.PREFIX || (isTermux ? TERMUX_PREFIX : '/usr');
export const HOME = os.homedir();

export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* devam */
    }
  }
  return null;
}

function pickShell(): string {
  const candidates = [process.env.SHELL, path.join(PREFIX, 'bin/bash'), '/bin/bash', path.join(PREFIX, 'bin/sh'), '/bin/sh'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'sh';
}

export const SHELL = pickShell();

export const PYTHON = which('python3') ?? which('python') ?? 'python3';

/** Paket yöneticisi komutları: Termux'ta `pkg`, diğer Debian tabanlılarda `apt-get`. */
export const PKG = isTermux && which('pkg') ? 'pkg' : 'apt-get';

export const APT_ENV = {
  DEBIAN_FRONTEND: 'noninteractive',
  APT_LISTCHANGES_FRONTEND: 'none',
};

export const APT_OPTS = ['-y', '-o', 'Dpkg::Options::=--force-confold', '-o', 'Dpkg::Options::=--force-confdef'];

/** `~` ile başlayan yolları genişletir ve mutlak yola çevirir. */
export function resolvePath(p: string | undefined): string {
  if (!p || p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.resolve(HOME, p);
}
