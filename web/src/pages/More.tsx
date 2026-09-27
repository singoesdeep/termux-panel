import { useState } from 'react';
import { post } from '../api';
import { MORE_NAV } from '../nav';
import { Icon } from '../components/Icon';
import { Header, Tabs } from '../components/ui';
import { navigate } from '../router';
import { useApp } from '../store';

type Theme = 'system' | 'light' | 'dark';

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

export default function More() {
  const { jobs } = useApp();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const running = jobs.filter((j) => j.status === 'running').length;

  const applyTheme = (t: Theme) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === 'system') localStorage.removeItem('tp-theme');
      else localStorage.setItem('tp-theme', t);
    } catch {
      /* yok */
    }
  };

  return (
    <>
      <Header title="Menü" />
      <div className="content stack">
        <div className="list">
          {MORE_NAV.map((n) => (
            <button key={n.page} className="list-item" onClick={() => navigate(n.page)}>
              <span className="list-ico folder">
                <Icon name={n.icon} size={20} />
              </span>
              <div className="list-main">
                <div className="list-title">{n.label}</div>
                <div className="list-sub">{n.desc}</div>
              </div>
              {n.page === 'jobs' && running > 0 && <span className="badge badge-run">{running} çalışıyor</span>}
              <Icon name="chevron-right" size={18} className="faint" />
            </button>
          ))}
        </div>

        <div className="section-title">Görünüm</div>
        <Tabs
          value={theme}
          onChange={applyTheme}
          items={[
            { value: 'system', label: 'Sistem' },
            { value: 'light', label: 'Açık' },
            { value: 'dark', label: 'Koyu' },
          ]}
        />

        <div className="section-title">Oturum</div>
        <button
          className="btn"
          onClick={async () => {
            await post('/api/auth/logout').catch(() => {});
            location.reload();
          }}
        >
          <Icon name="logout" size={18} /> Çıkış yap
        </button>
      </div>
    </>
  );
}
