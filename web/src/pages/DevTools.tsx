import { useEffect, useMemo, useState } from 'react';
import { api, errMsg, post, q } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, SearchInput, Spinner, Switch, Tabs } from '../components/ui';
import { EnvPicker, envQ, usePersistedEnv } from '../envs';
import { useApp, type JobMeta } from '../store';

interface Pkg {
  name: string;
  version: string;
  latest?: string;
  latest_version?: string;
}
type Kind = 'pip' | 'npm';

export default function DevTools() {
  const [tab, setTab] = useState<Kind>('pip');
  const [env, setEnv] = usePersistedEnv('devtools');
  const where = env === 'termux' ? 'Termux' : env;
  return (
    <>
      <Header title="Python & Node" subtitle={`${tab === 'pip' ? 'pip paketleri' : 'Global npm paketleri'} · ${where}`} />
      <div className="content stack">
        <EnvPicker value={env} onChange={setEnv} />
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'pip', label: 'Python (pip)' },
            { value: 'npm', label: 'Node (npm -g)' },
          ]}
        />
        <PackageManager key={`${tab}-${env}`} kind={tab} env={env} />
      </div>
    </>
  );
}

function PackageManager({ kind, env }: { kind: Kind; env: string }) {
  const eq = env === 'termux' ? '' : `?${q({ env })}`;
  const { runJob, confirm, toast } = useApp();
  const [data, setData] = useState<{ available: boolean; error?: string; python?: string; node?: string; packages: Pkg[] } | null>(null);
  const [filter, setFilter] = useState('');
  const [install, setInstall] = useState('');
  const [outdated, setOutdated] = useState<Pkg[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [breakSys, setBreakSys] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    setData(null);
    api<typeof data>(`/api/${kind}/list${eq}`)
      .then(setData)
      .catch((e) => setData({ available: false, error: errMsg(e), packages: [] }));
  }, [kind, version, eq]);

  const shown = useMemo(() => (data?.packages ?? []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  const extra = { ...(kind === 'pip' ? { breakSystem: breakSys } : {}), ...envQ(env) };

  const doInstall = (names: string[], upgrade = false) =>
    runJob(post<JobMeta>(`/api/${kind}/install`, { names, upgrade, ...extra }), (j) => {
      if (j.status === 'done') {
        refresh();
        setOutdated(null);
      }
    });

  const checkOutdated = async () => {
    setChecking(true);
    try {
      const r = await api<{ packages: Pkg[] }>(`/api/${kind}/outdated${eq}`);
      setOutdated(r.packages);
      if (!r.packages.length) toast('Tüm paketler güncel', 'ok');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setChecking(false);
    }
  };

  if (!data) return <Spinner />;
  if (!data.available)
    return (
      <Empty icon="alert" title={kind === 'pip' ? 'pip kullanılamıyor' : 'npm kullanılamıyor'}>
        <div className="mono" style={{ fontSize: 12.5 }}>
          {data.error}
        </div>
        <div style={{ marginTop: 14 }}>
          <button
            className="btn btn-primary"
            onClick={() => runJob(post<JobMeta>('/api/pkg/install', { names: kind === 'pip' ? [env === 'termux' ? 'python-pip' : 'python3-pip'] : env === 'termux' ? ['nodejs'] : ['nodejs', 'npm'], ...envQ(env) }), refresh)}
          >
            <Icon name="download" size={18} /> {kind === 'pip' ? (env === 'termux' ? 'python-pip' : 'python3-pip') : env === 'termux' ? 'nodejs' : 'nodejs + npm'} kur
          </button>
        </div>
      </Empty>
    );

  return (
    <>
      <div className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const names = install.trim().split(/\s+/).filter(Boolean);
            if (names.length) {
              doInstall(names);
              setInstall('');
            }
          }}
        >
          <input
            className="input mono"
            value={install}
            onChange={(e) => setInstall(e.target.value)}
            placeholder={kind === 'pip' ? 'requests flask==3.0' : 'pm2 yarn@latest'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={!install.trim()}>
            Kur
          </button>
        </form>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <span className="faint" style={{ fontSize: 13 }}>
            {data.python ?? data.node} · {data.packages.length} paket
          </span>
          <span className="spacer" />
          {kind === 'pip' && <Switch checked={breakSys} onChange={setBreakSys} label="--break-system-packages" />}
        </div>
      </div>

      <div className="row">
        <button className="btn" onClick={checkOutdated} disabled={checking}>
          <Icon name="refresh" size={18} /> {checking ? 'Kontrol ediliyor…' : 'Güncellemeleri kontrol et'}
        </button>
        {outdated && outdated.length > 0 && (
          <button className="btn btn-primary" onClick={() => doInstall(outdated.map((p) => p.name), true)}>
            Hepsini güncelle ({outdated.length})
          </button>
        )}
      </div>

      {outdated && outdated.length > 0 && (
        <div className="list">
          {outdated.map((p) => (
            <div key={p.name} className="list-item">
              <div className="list-main">
                <div className="list-title">{p.name}</div>
                <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                  {p.version} → {p.latest_version ?? p.latest}
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => doInstall([kind === 'npm' ? `${p.name}@latest` : p.name], true)}>
                Güncelle
              </button>
            </div>
          ))}
        </div>
      )}

      <SearchInput value={filter} onChange={setFilter} placeholder="Kurulu paketlerde ara…" />
      <div className="list">
        {shown.map((p) => (
          <div key={p.name} className="list-item">
            <span className="list-ico">
              <Icon name={kind === 'pip' ? 'python' : 'package'} size={18} />
            </span>
            <div className="list-main">
              <div className="list-title">{p.name}</div>
              <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                {p.version}
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label={`${p.name} kaldır`}
              onClick={async () => {
                if (await confirm({ title: `${p.name} kaldırılsın mı?`, confirm: 'Kaldır', danger: true }))
                  runJob(post<JobMeta>(`/api/${kind}/uninstall`, { names: [p.name], ...extra }), refresh);
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        ))}
        {shown.length === 0 && <Empty title="Paket yok" />}
      </div>
    </>
  );
}
