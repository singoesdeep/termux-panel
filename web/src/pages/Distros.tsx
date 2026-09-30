import { useEffect, useState } from 'react';
import { api, errMsg, fmtBytes, fmtDate, post, q } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, SearchInput, Sheet, Spinner, useDebounced } from '../components/ui';
import { refreshEnvs, useEnvs, type Distro } from '../envs';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

const POPULAR = ['debian', 'ubuntu:24.04', 'alpine', 'archlinux', 'fedora'];

const stamp = () => new Date().toISOString().slice(0, 10);

function setEnvFor(page: string, env: string) {
  try {
    localStorage.setItem(`tp-env-${page}`, env);
  } catch {
    /* yok */
  }
}

export default function Distros() {
  const { runJob, toast, prompt, confirm } = useApp();
  const { info } = useEnvs();
  const [menu, setMenu] = useState<Distro | null>(null);
  const [sizes, setSizes] = useState<Record<string, number | 'loading'>>({});
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    refreshEnvs().catch((e) => toast(errMsg(e), 'err'));
  }, [toast]);

  const afterJob = () => refreshEnvs().catch(() => {});
  const job = (p: Promise<JobMeta>) => runJob(p, afterJob);
  const enc = encodeURIComponent;

  const size = async (d: Distro) => {
    setSizes((s) => ({ ...s, [d.name]: 'loading' }));
    try {
      const r = await api<{ size: number }>(`/api/distros/${enc(d.name)}/size`);
      setSizes((s) => ({ ...s, [d.name]: r.size }));
    } catch (e) {
      toast(errMsg(e), 'err');
      setSizes((s) => {
        const { [d.name]: _x, ...rest } = s;
        return rest;
      });
    }
  };

  if (!info) return <Spinner label="Distrolar okunuyor…" />;
  const usable = info.available;

  return (
    <>
      <Header
        title="Distrolar"
        subtitle="proot-distro"
        actions={
          <>
            <IconButton icon="refresh" label="Yenile" onClick={afterJob} />
            {usable && <IconButton icon="plus" label="Distro kur" onClick={() => setInstalling(true)} />}
          </>
        }
      />
      <div className="content stack">
        {!usable && (
          <div className="callout">
            <Icon name="alert" />
            <div>
              {info.reason}
              {info.reason?.includes('kurulu değil') && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => job(post<JobMeta>('/api/pkg/install', { names: ['proot-distro'] }))}>
                    proot-distro kur
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {info.distros.length === 0 ? (
          <Empty icon="box" title="Kurulu distro yok">
            Termux içinde tam bir Linux (Debian, Ubuntu, Alpine…) çalıştırabilirsin. Claude Code gibi glibc isteyen araçlar için idealdir.
            {usable && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-primary" onClick={() => setInstalling(true)}>
                  <Icon name="plus" size={18} /> Distro kur
                </button>
              </div>
            )}
          </Empty>
        ) : (
          info.distros.map((d) => {
            const running = info.sessions.filter((s) => s.container === d.name).length;
            const sz = sizes[d.name];
            return (
              <div key={d.name} className="card">
                <div className="row">
                  <span className="list-ico folder">
                    <Icon name="box" size={20} />
                  </span>
                  <div className="list-main">
                    <div className="list-title">{d.name}</div>
                    <div className="list-sub">
                      {d.os ?? 'Bilinmeyen sistem'}
                      {d.image && d.image !== d.name && ` · ${d.image}`}
                    </div>
                  </div>
                  {running > 0 && (
                    <span className="badge badge-run">
                      <span className="dot-pulse" /> {running} oturum
                    </span>
                  )}
                  {running > 0 && usable && (
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `${d.name} durdurulsun mu?`,
                          message: `${running} oturum ve içlerinde çalışan her şey kapanır (ör. dev server'lar). Distronun dosyalarına dokunulmaz.`,
                          confirm: 'Durdur',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await post(`/api/distros/${enc(d.name)}/stop`);
                          toast(`${d.name} durduruldu`, 'ok');
                        } catch (e) {
                          toast(errMsg(e), 'err');
                        }
                        afterJob();
                      }}
                    >
                      <Icon name="stop" size={16} /> Durdur
                    </button>
                  )}
                  {usable && <IconButton icon="more" label="Diğer işlemler" onClick={() => setMenu(d)} />}
                </div>
                <div className="row faint" style={{ fontSize: 12.5, marginTop: 6, flexWrap: 'wrap' }}>
                  <span>Paket yöneticisi: {d.pm ?? '?'}</span>
                  <span>·</span>
                  {sz === undefined ? (
                    <button className="btn btn-sm btn-ghost" style={{ minHeight: 26, padding: '0 6px' }} onClick={() => size(d)}>
                      Boyutu hesapla
                    </button>
                  ) : sz === 'loading' ? (
                    <span>Hesaplanıyor…</span>
                  ) : (
                    <span>{fmtBytes(sz)}</span>
                  )}
                </div>
                <div className="grid grid-2" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={!usable} onClick={() => navigate('terminal', { env: d.name })}>
                    <Icon name="terminal" size={18} /> Terminal
                  </button>
                  <button className="btn" onClick={() => navigate('files', { path: `${d.rootfs}/root` })}>
                    <Icon name="folder" size={18} /> Dosyalar
                  </button>
                  {d.pm === 'apt' && (
                    <button
                      className="btn"
                      disabled={!usable}
                      onClick={() => {
                        setEnvFor('packages', d.name);
                        navigate('packages');
                      }}
                    >
                      <Icon name="package" size={18} /> Paketler
                    </button>
                  )}
                  <button
                    className="btn"
                    disabled={!usable}
                    onClick={() => {
                      setEnvFor('devtools', d.name);
                      navigate('devtools');
                    }}
                  >
                    <Icon name="code" size={18} /> Python & Node
                  </button>
                </div>
              </div>
            );
          })
        )}

        {info.sessions.length > 0 && (
          <>
            <div className="section-title">Çalışan oturumlar</div>
            <div className="list">
              {info.sessions.map((s) => (
                <div key={s.pid} className="list-item">
                  <div className="list-main">
                    <div className="list-title">
                      {s.container} <span className="faint mono" style={{ fontSize: 12 }}>PID {s.pid}</span>
                      {s.panelTerminal && (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          <Icon name="terminal" size={11} /> {s.panelTerminal}
                        </span>
                      )}
                    </div>
                    <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                      {s.user}$ {s.command.join(' ')} · {fmtDate(s.startTime)}
                    </div>
                  </div>
                  <IconButton
                    icon="stop"
                    label="Oturumu kapat"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `${s.container} oturumu (PID ${s.pid}) kapatılsın mı?`,
                        message: 'Bu oturumun içinde çalışan her şey kapanır (ör. orada çalışan bir dev server).',
                        confirm: 'Kapat',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await post(`/api/distros/sessions/${s.pid}/kill`);
                        toast('Oturum kapatıldı', 'ok');
                        afterJob();
                      } catch (e) {
                        toast(errMsg(e), 'err');
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {usable && (
          <>
            <div className="section-title">Diğer</div>
            <div className="row-wrap">
              <button
                className="btn"
                onClick={async () => {
                  const f = await prompt({ title: 'Yedekten geri yükle', label: 'Yedek dosyasının yolu', placeholder: '~/proot-yedek/debian.tar.gz', confirm: 'Geri yükle' });
                  if (f) job(post<JobMeta>('/api/distros/restore', { archive: f }));
                }}
              >
                <Icon name="upload" size={18} /> Yedekten geri yükle
              </button>
              <button className="btn btn-ghost" onClick={() => job(post<JobMeta>('/api/distros/clear-cache'))}>
                <Icon name="trash" size={18} /> İndirme önbelleğini temizle
              </button>
            </div>
          </>
        )}
      </div>

      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu?.name}>
        {menu && (
          <div className="action-list">
            <button
              onClick={async () => {
                setMenu(null);
                const out = await prompt({
                  title: `${menu.name} yedekle`,
                  label: 'Yedeğin kaydedileceği dosya',
                  value: `~/proot-yedek/${menu.name}-${stamp()}.tar.gz`,
                  confirm: 'Yedekle',
                });
                if (out) job(post<JobMeta>(`/api/distros/${enc(menu.name)}/backup`, { output: out }));
              }}
            >
              <Icon name="archive" /> Yedekle
            </button>
            <button
              onClick={async () => {
                setMenu(null);
                const to = await prompt({ title: 'Yeniden adlandır', value: menu.name, confirm: 'Kaydet' });
                if (!to || to === menu.name) return;
                try {
                  await post(`/api/distros/${enc(menu.name)}/rename`, { to });
                  toast('Adlandırıldı', 'ok');
                  afterJob();
                } catch (e) {
                  toast(errMsg(e), 'err');
                }
              }}
            >
              <Icon name="edit" /> Yeniden adlandır
            </button>
            <button
              className="danger"
              onClick={async () => {
                setMenu(null);
                const ok = await confirm({
                  title: `${menu.name} sıfırlansın mı?`,
                  message: 'Distro ilk kurulduğu haline döner; içindeki tüm dosyalar, paketler ve projeler silinir. Önce yedek almak isteyebilirsin.',
                  confirm: 'Sıfırla',
                  danger: true,
                });
                if (ok) job(post<JobMeta>(`/api/distros/${enc(menu.name)}/reset`));
              }}
            >
              <Icon name="restart" /> Sıfırla
            </button>
            <button
              className="danger"
              onClick={async () => {
                setMenu(null);
                const typed = await prompt({
                  title: `${menu.name} kaldırılsın mı?`,
                  label: `Distro ve içindeki her şey kalıcı olarak silinir. Onaylamak için "${menu.name}" yaz.`,
                  placeholder: menu.name,
                  confirm: 'Kalıcı olarak kaldır',
                });
                if (typed === null) return;
                if (typed.trim() !== menu.name) return toast('Ad eşleşmedi, kaldırılmadı', 'err');
                job(post<JobMeta>(`/api/distros/${enc(menu.name)}/remove`));
              }}
            >
              <Icon name="trash" /> Kaldır
            </button>
          </div>
        )}
      </Sheet>

      {installing && <InstallSheet onClose={() => setInstalling(false)} onStart={(p) => (setInstalling(false), job(p))} />}
    </>
  );
}

function InstallSheet({ onClose, onStart }: { onClose: () => void; onStart: (p: Promise<JobMeta>) => void }) {
  const { distros } = useEnvs();
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 500);
  const [results, setResults] = useState<string[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const ctl = new AbortController();
    setErr('');
    api<{ results: string[] }>(`/api/distros/search?${q({ q: query })}`, { signal: ctl.signal })
      .then((r) => setResults(r.results))
      .catch((e) => e.name !== 'AbortError' && setErr(errMsg(e)));
    return () => ctl.abort();
  }, [query]);

  // Aynı imaj ikinci kez kurulacaksa farklı bir ad öner
  const base = image.split(/[:/@]/)[0];
  const clash = !name && distros.some((d) => d.name === base);

  return (
    <Sheet
      open
      onClose={onClose}
      title="Distro kur"
      footer={
        <button
          className="btn btn-primary"
          disabled={!image.trim() || clash}
          onClick={() => onStart(post<JobMeta>('/api/distros/install', { image: image.trim(), ...(name.trim() ? { name: name.trim() } : {}) }))}
        >
          <Icon name="download" size={18} /> Kur
        </button>
      }
    >
      <div className="stack">
        <div>
          <label className="field-label">Popüler</label>
          <div className="chips" style={{ flexWrap: 'wrap' }}>
            {POPULAR.map((p) => (
              <button key={p} className={`chip ${image === p ? 'on' : ''}`} onClick={() => setImage(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="field-label">İmaj ara</label>
          <SearchInput value={search} onChange={setSearch} placeholder="ör. ubuntu, python, node" />
          {err && <div className="faint" style={{ marginTop: 6 }}>{err}</div>}
          {results && (
            <div className="list" style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
              {results.length === 0 && <div className="list-item faint">Sonuç yok</div>}
              {results.map((r) => (
                <button key={r} className={`list-item ${image === r ? 'selected' : ''}`} style={{ minHeight: 44 }} onClick={() => setImage(r)}>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {r}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="field-label">İmaj</label>
          <input
            className="input mono"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="ubuntu:24.04"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="field-label">Container adı (isteğe bağlı)</label>
          <input
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={base || 'ubuntu'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {clash && <div style={{ color: 'var(--critical)', fontSize: 13, marginTop: 6 }}>"{base}" adında bir distro zaten var, farklı bir ad gir.</div>}
        </div>
      </div>
    </Sheet>
  );
}
