import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, errMsg, fmtBytes, post, q } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, SearchInput, Sheet, Spinner, Switch, Tabs, useDebounced } from '../components/ui';
import { EnvPicker, envQ, usePersistedEnv, useEnvs } from '../envs';
import { useRoute } from '../router';
import { useApp, type JobMeta } from '../store';

interface Installed {
  name: string;
  version: string;
  size: number;
  summary: string;
  manual: boolean;
}
interface Found {
  name: string;
  summary: string;
  installed: boolean;
}
interface Upgradable {
  name: string;
  version: string;
  from: string;
}
type Tab = 'installed' | 'search' | 'updates';

/** Seçili ortam (Termux ya da distro adı) tüm alt bileşenlere buradan ulaşır */
const EnvCtx = createContext('termux');
const useEnv = () => useContext(EnvCtx);
const withEnv = (url: string, env: string) => (env === 'termux' ? url : `${url}${url.includes('?') ? '&' : '?'}${q({ env })}`);

export default function Packages() {
  const { params } = useRoute();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'installed');
  const [detail, setDetail] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // işlem bitince listeleri yenilemek için
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [env, setEnv] = usePersistedEnv('packages');
  const { distros } = useEnvs();
  const distro = distros.find((d) => d.name === env);

  return (
    <>
      <Header title="Paketler" subtitle={distro ? `${distro.name} · ${distro.os ?? 'apt'}` : 'Termux · pkg'} />
      <EnvCtx.Provider value={env}>
      <div className="content stack">
        <EnvPicker value={env} onChange={setEnv} />
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'installed', label: 'Kurulu' },
            { value: 'search', label: 'Ara & kur' },
            { value: 'updates', label: 'Güncellemeler' },
          ]}
        />
        {distro && distro.pm !== 'apt' ? (
          <Empty icon="package" title={`${distro.pm ?? 'Bu'} paket yöneticisi henüz desteklenmiyor`}>
            Şimdilik yalnızca apt tabanlı distrolar (Debian, Ubuntu…) destekleniyor. Paketleri terminalden yönetebilirsin.
          </Empty>
        ) : (
          <>
            {tab === 'installed' && <InstalledTab key={env} onOpen={setDetail} version={version} />}
            {tab === 'search' && <SearchTab key={env} onOpen={setDetail} version={version} onChanged={bump} />}
            {tab === 'updates' && <UpdatesTab key={env} version={version} onChanged={bump} />}
          </>
        )}
      </div>
      {detail && <PackageSheet name={detail} onClose={() => setDetail(null)} onChanged={bump} />}
      </EnvCtx.Provider>
    </>
  );
}

function InstalledTab({ onOpen, version }: { onOpen: (n: string) => void; version: number }) {
  const env = useEnv();
  const [list, setList] = useState<Installed[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [manualOnly, setManualOnly] = useState(true);

  useEffect(() => {
    api<{ packages: Installed[] }>(withEnv('/api/pkg/installed', env))
      .then((r) => setList(r.packages))
      .catch((e) => setErr(errMsg(e)));
  }, [version]);

  const shown = useMemo(() => {
    if (!list) return [];
    const f = filter.toLowerCase();
    return list.filter((p) => (!manualOnly || p.manual || f) && (!f || p.name.includes(f) || p.summary?.toLowerCase().includes(f)));
  }, [list, filter, manualOnly]);

  if (err) return <Empty icon="alert" title="Liste alınamadı">{err}</Empty>;
  if (!list) return <Spinner label="Paketler okunuyor…" />;
  return (
    <>
      <SearchInput value={filter} onChange={setFilter} placeholder={`${list.length} paket içinde ara…`} />
      <div className="row">
        <Switch checked={manualOnly} onChange={setManualOnly} label="Yalnızca elle kurulanlar" />
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 13 }}>
          {shown.length} paket
        </span>
      </div>
      {shown.length === 0 ? (
        <Empty title="Eşleşen paket yok" />
      ) : (
        <div className="list">
          {shown.slice(0, 400).map((p) => (
            <button key={p.name} className="list-item" onClick={() => onOpen(p.name)}>
              <span className="list-ico">
                <Icon name="package" size={18} />
              </span>
              <div className="list-main">
                <div className="list-title">{p.name}</div>
                <div className="list-sub">{p.summary}</div>
              </div>
              <div className="list-end mono" style={{ fontSize: 11.5, flexDirection: 'column', alignItems: 'flex-end' }}>
                <span className="ellipsis" style={{ maxWidth: 110 }}>
                  {p.version}
                </span>
                <span>{fmtBytes(p.size, 0)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function SearchTab({ onOpen, version, onChanged }: { onOpen: (n: string) => void; version: number; onChanged: () => void }) {
  const env = useEnv();
  const { runJob } = useApp();
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), 400);
  const [res, setRes] = useState<Found[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (query.length < 2) {
      setRes(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    api<{ packages: Found[] }>(withEnv(`/api/pkg/search?${q({ q: query })}`, env), { signal: ctl.signal })
      .then((r) => {
        setRes(r.packages);
        setErr('');
      })
      .catch((e) => e.name !== 'AbortError' && setErr(errMsg(e)))
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [query, version]);

  return (
    <>
      <SearchInput value={text} onChange={setText} placeholder="Paket ara (ör. python, git, nmap)…" autoFocus />
      {err && <Empty icon="alert" title="Arama başarısız">{err}</Empty>}
      {loading && !res && <Spinner />}
      {!res && !loading && (
        <Empty icon="search" title="Paket ara">
          En az 2 karakter yaz. Sonuç gelmiyorsa önce <b>Güncellemeler</b> sekmesinden depoları güncelle.
        </Empty>
      )}
      {res && res.length === 0 && <Empty title="Sonuç yok" />}
      {res && res.length > 0 && (
        <div className="list">
          {res.map((p) => (
            <div key={p.name} className="list-item">
              <button className="list-main" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left' }} onClick={() => onOpen(p.name)}>
                <div className="list-title">{p.name}</div>
                <div className="list-sub">{p.summary}</div>
              </button>
              {p.installed ? (
                <span className="badge badge-good">
                  <Icon name="check" size={12} /> Kurulu
                </span>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={() => runJob(post<JobMeta>('/api/pkg/install', { names: [p.name], ...envQ(env) }), onChanged)}>
                  Kur
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function UpdatesTab({ version, onChanged }: { version: number; onChanged: () => void }) {
  const env = useEnv();
  const { runJob, confirm } = useApp();
  const [list, setList] = useState<Upgradable[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setList(null);
    api<{ packages: Upgradable[] }>(withEnv('/api/pkg/upgradable', env))
      .then((r) => setList(r.packages))
      .catch((e) => setErr(errMsg(e)));
  }, [version]);

  return (
    <>
      <div className="row-wrap">
        <button className="btn" onClick={() => runJob(post<JobMeta>('/api/pkg/update', envQ(env)), onChanged)}>
          <Icon name="refresh" size={18} /> Depoları güncelle
        </button>
        <button
          className="btn btn-primary"
          disabled={!list?.length}
          onClick={async () => {
            if (await confirm({ title: 'Tüm paketler güncellensin mi?', message: `${list?.length} paket güncellenecek.`, confirm: 'Güncelle' }))
              runJob(post<JobMeta>('/api/pkg/upgrade', envQ(env)), onChanged);
          }}
        >
          <Icon name="download" size={18} /> Hepsini güncelle
        </button>
        <button className="btn btn-ghost" onClick={() => runJob(post<JobMeta>('/api/pkg/autoremove', envQ(env)), onChanged)}>
          <Icon name="trash" size={18} /> Temizle
        </button>
      </div>
      {err && <Empty icon="alert" title="Liste alınamadı">{err}</Empty>}
      {!list && !err && <Spinner />}
      {list?.length === 0 && (
        <Empty icon="check" title="Her şey güncel">
          Yeni sürümleri görmek için önce depoları güncelle.
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="list">
          {list.map((p) => (
            <div key={p.name} className="list-item">
              <div className="list-main">
                <div className="list-title">{p.name}</div>
                <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                  {p.from} → {p.version}
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => runJob(post<JobMeta>('/api/pkg/upgrade', { names: [p.name], ...envQ(env) }), onChanged)}>
                Güncelle
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PackageSheet({ name, onClose, onChanged }: { name: string; onClose: () => void; onChanged: () => void }) {
  const env = useEnv();
  const { runJob, confirm } = useApp();
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api<{ fields: Record<string, string> }>(withEnv(`/api/pkg/show/${encodeURIComponent(name)}`, env))
      .then((r) => setFields(r.fields))
      .catch((e) => setErr(errMsg(e)));
    api<{ packages: Installed[] }>(withEnv('/api/pkg/installed', env))
      .then((r) => setInstalled(r.packages.some((p) => p.name === name)))
      .catch(() => setInstalled(null));
  }, [name]);

  const keys: [string, string][] = [
    ['Version', 'Sürüm'],
    ['Installed-Size', 'Kurulu boyut'],
    ['Maintainer', 'Bakımcı'],
    ['Depends', 'Bağımlılıklar'],
    ['Homepage', 'Ana sayfa'],
  ];

  return (
    <Sheet
      open
      onClose={onClose}
      title={name}
      footer={
        installed === null ? undefined : installed ? (
          <>
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (await confirm({ title: `${name} kaldırılsın mı?`, confirm: 'Kaldır', danger: true })) {
                  onClose();
                  runJob(post<JobMeta>('/api/pkg/remove', { names: [name], ...envQ(env) }), onChanged);
                }
              }}
            >
              <Icon name="trash" size={18} /> Kaldır
            </button>
            <button className="btn" onClick={() => (onClose(), runJob(post<JobMeta>('/api/pkg/install', { names: [name], ...envQ(env) }), onChanged))}>
              <Icon name="refresh" size={18} /> Yeniden kur
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => (onClose(), runJob(post<JobMeta>('/api/pkg/install', { names: [name], ...envQ(env) }), onChanged))}>
            <Icon name="download" size={18} /> Kur
          </button>
        )
      }
    >
      {err && <div className="muted">{err}</div>}
      {!fields && !err && <Spinner />}
      {fields && (
        <div className="stack">
          <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
            {fields.Description ?? fields['Description-en'] ?? ''}
          </div>
          <dl className="kv" style={{ margin: 0 }}>
            {keys
              .filter(([k]) => fields[k])
              .map(([k, label]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{label}</dt>
                  <dd title={fields[k]} style={{ whiteSpace: k === 'Depends' ? 'normal' : undefined }}>
                    {k === 'Installed-Size' ? fmtBytes(Number(fields[k]) * 1024) : fields[k]}
                  </dd>
                </div>
              ))}
          </dl>
          {installed && (
            <span className="badge badge-good" style={{ alignSelf: 'flex-start' }}>
              <Icon name="check" size={12} /> Kurulu
            </span>
          )}
        </div>
      )}
    </Sheet>
  );
}

