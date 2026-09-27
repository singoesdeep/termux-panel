import { useEffect, useState, type ReactNode } from 'react';
import { api, errMsg, post } from './api';
import { Icon } from './components/Icon';
import { Spinner } from './components/ui';
import Dashboard from './pages/Dashboard';
import Distros from './pages/Distros';
import DevTools from './pages/DevTools';
import Device from './pages/Device';
import Files from './pages/Files';
import Jobs from './pages/Jobs';
import More from './pages/More';
import Packages from './pages/Packages';
import Processes from './pages/Processes';
import Services from './pages/Services';
import Setup from './pages/Setup';
import Shortcuts from './pages/Shortcuts';
import TerminalPage from './pages/Terminal';
import { MORE_NAV } from './nav';
import { navigate, useRoute, type Page } from './router';
import { AppProvider, useApp } from './store';

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'in' | 'out'>('loading');

  useEffect(() => {
    api<{ authenticated: boolean }>('/api/auth/status')
      .then((s) => setAuth(s.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('out'));
    const onUnauth = () => setAuth('out');
    window.addEventListener('tp:unauth', onUnauth);
    return () => window.removeEventListener('tp:unauth', onUnauth);
  }, []);

  if (auth === 'loading') return <Spinner />;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await post('/api/auth/login', { token });
            onDone();
          } catch (e) {
            setErr(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-logo">
          <img src="/icon.svg" width={44} height={44} alt="" />
          Termux Panel
        </div>
        <div className="muted">
          Panel başlatıldığında terminalde gösterilen token'ı gir. Token <code>~/.termux-panel/config.json</code> dosyasında da duruyor.
        </div>
        <input
          className="input mono"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token"
          autoFocus
          autoComplete="current-password"
        />
        {err && <div style={{ color: 'var(--critical)' }}>{err}</div>}
        <button className="btn btn-primary" disabled={!token || busy}>
          {busy ? 'Kontrol ediliyor…' : 'Giriş yap'}
        </button>
      </form>
    </div>
  );
}

const MAIN_NAV: { page: Page; label: string; icon: string }[] = [
  { page: 'dashboard', label: 'Panel', icon: 'gauge' },
  { page: 'terminal', label: 'Terminal', icon: 'terminal' },
  { page: 'files', label: 'Dosyalar', icon: 'folder' },
  { page: 'packages', label: 'Paketler', icon: 'package' },
];



function Shell() {
  const { page, params } = useRoute();
  const { jobs } = useApp();
  const running = jobs.filter((j) => j.status === 'running').length;
  useViewport();
  const updated = useUpdateCheck();

  const pages: Record<Page, ReactNode> = {
    dashboard: <Dashboard />,
    terminal: null, // Terminal her zaman bağlı kalır, aşağıda
    files: <Files params={params} />,
    packages: <Packages />,
    more: <More />,
    processes: <Processes />,
    services: <Services />,
    devtools: <DevTools />,
    device: <Device />,
    shortcuts: <Shortcuts />,
    jobs: <Jobs />,
    distros: <Distros />,
    setup: <Setup />,
  };
  const inMore = MORE_NAV.some((m) => m.page === page) || page === 'more';

  return (
    <div className="app">
      <nav className="nav" aria-label="Ana menü">
        <div className="nav-brand">
          <img src="/icon.svg" width={28} height={28} alt="" /> Termux Panel
        </div>
        {MAIN_NAV.map((n) => (
          <NavItem key={n.page} {...n} on={page === n.page} />
        ))}
        <button className={`nav-item nav-more ${inMore ? 'on' : ''}`} onClick={() => navigate('more')}>
          <span className="nav-ico">
            <Icon name="grid" />
          </span>
          Menü
          {running > 0 && <span className="nav-badge">{running}</span>}
        </button>
        <div className="nav-side-extra">
          <div className="nav-sep" />
          {MORE_NAV.map((n) => (
            <NavItem key={n.page} {...n} on={page === n.page} badge={n.page === 'jobs' ? running : 0} />
          ))}
        </div>
      </nav>
      <main className="main">
        {updated && (
          <div className="update-bar">
            <Icon name="refresh" size={18} />
            <span>Panel güncellendi</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-primary" onClick={() => location.reload()}>
              Yenile
            </button>
          </div>
        )}
        {/* Terminal sayfası gizlenip korunur ki oturumlar/bağlantı kopmasın */}
        <div style={{ display: page === 'terminal' ? 'block' : 'none' }}>
          <TerminalPage active={page === 'terminal'} params={params} />
        </div>
        {page !== 'terminal' && (pages[page] ?? <Dashboard />)}
      </main>
    </div>
  );
}

function NavItem({ page, label, icon, on, badge }: { page: Page; label: string; icon: string; on: boolean; badge?: number }) {
  return (
    <button className={`nav-item ${on ? 'on' : ''}`} onClick={() => navigate(page)} aria-current={on ? 'page' : undefined}>
      <span className="nav-ico">
        <Icon name={icon} />
      </span>
      {label}
      {!!badge && <span className="nav-badge">{badge}</span>}
    </button>
  );
}

/** Sunucudaki arayüz derlemesi değişirse (panel güncellendiyse) haber verir. */
function useUpdateCheck() {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    let first: string | null = null;
    const check = () =>
      api<{ build?: string }>('/api/auth/status')
        .then((s) => {
          if (!s.build || s.build === 'dev') return;
          if (first === null) first = s.build;
          else if (s.build !== first) setUpdated(true);
        })
        .catch(() => {});
    check();
    const id = setInterval(check, 60_000);
    // Telefonda sekmeye geri dönüldüğünde hemen kontrol et
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return updated;
}

/** Mobil klavye açıldığında görünür yüksekliği takip eder, alt menüyü gizler. */
function useViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      const kb = window.innerWidth < 900 && vv.height < window.innerHeight * 0.78;
      document.body.classList.toggle('kb-open', kb);
    };
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);
}
