import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './components/Icon';

export interface Distro {
  name: string;
  rootfs: string;
  os: string | null;
  image: string | null;
  pm: 'apt' | 'apk' | 'pacman' | 'dnf' | null;
  shell: string;
}
export interface PdSession {
  pid: number;
  container: string;
  kind: string;
  command: string[];
  user: string;
  startTime: number;
  /** Panelin açtığı bir terminal sekmesiyse sekmenin adı */
  panelTerminal: string | null;
}
export interface DistroInfo {
  available: boolean;
  reason?: string;
  root: string;
  /** Distrolara bağlanan Termux klasörleri */
  binds?: { src: string; dst: string }[];
  distros: Distro[];
  sessions: PdSession[];
}

/** Ortamlar birçok sayfada lazım: tek istek, paylaşılan önbellek */
let cache: DistroInfo | null = null;
let inflight: Promise<DistroInfo> | null = null;
const subs = new Set<(d: DistroInfo) => void>();

export function refreshEnvs() {
  inflight = api<DistroInfo>('/api/distros')
    .then((d) => {
      cache = d;
      subs.forEach((f) => f(d));
      return d;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useEnvs() {
  const [info, setInfo] = useState<DistroInfo | null>(cache);
  useEffect(() => {
    subs.add(setInfo);
    if (!cache && !inflight) refreshEnvs().catch(() => {});
    return () => {
      subs.delete(setInfo);
    };
  }, []);
  // Distrolar ancak proot-distro kullanılabilirken seçilebilir
  const distros = info?.available ? info.distros : [];
  return { info, distros };
}

/** Termux'taki bir yol bir distronun rootfs'i içindeyse o distroyu ve içerideki yolu döndürür. */
export function locate(p: string, distros: Distro[]): { env: string; inner: string } | null {
  for (const d of distros) {
    if (p === d.rootfs || p.startsWith(d.rootfs + '/')) return { env: d.name, inner: p.slice(d.rootfs.length) || '/' };
  }
  return null;
}

const KEY = 'tp-env-';

export function usePersistedEnv(page: string) {
  const { distros } = useEnvs();
  const [env, setEnvState] = useState(() => {
    try {
      return localStorage.getItem(KEY + page) || 'termux';
    } catch {
      return 'termux';
    }
  });
  const setEnv = (v: string) => {
    setEnvState(v);
    try {
      localStorage.setItem(KEY + page, v);
    } catch {
      /* yok */
    }
  };
  // Seçili distro kaldırıldıysa Termux'a dön
  const valid = env === 'termux' || distros.some((d) => d.name === env);
  return [valid ? env : 'termux', setEnv] as const;
}

/** Termux + kurulu distrolar arasında seçim. Distro yoksa hiç görünmez. */
export function EnvPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { distros } = useEnvs();
  if (!distros.length) return null;
  return (
    <div className="chips" role="radiogroup" aria-label="Ortam">
      {[{ name: 'termux', label: 'Termux' }, ...distros.map((d) => ({ name: d.name, label: d.name }))].map((e) => (
        <button key={e.name} role="radio" aria-checked={value === e.name} className={`chip ${value === e.name ? 'on' : ''}`} onClick={() => onChange(e.name)}>
          <Icon name={e.name === 'termux' ? 'phone' : 'box'} size={14} />
          {e.label}
        </button>
      ))}
    </div>
  );
}

/** API isteklerine eklenecek env parametresi (Termux için boş) */
export const envQ = (env: string) => (env && env !== 'termux' ? { env } : {});
