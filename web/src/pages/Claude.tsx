import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, errMsg, fmtDuration, post, put, shq } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, Spinner, Switch, useInterval } from '../components/ui';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

interface RcConfig {
  distro: string;
  cwd: string;
  command: string;
  tty: boolean;
}
interface RcInfo {
  svAvailable: boolean;
  pd: { available: boolean; reason?: string };
  installed: boolean;
  status: { state: string; pid: number | null; seconds: number | null; enabled: boolean; raw: string } | null;
  config: RcConfig;
  distros: { name: string; os: string | null; claude: boolean; loggedIn: boolean }[];
  binds: { src: string; dst: string }[];
  wakeLock: boolean;
  phantom: { status: 'ok' | 'warn'; detail: string };
  log: string;
  urls: string[];
}

export default function Claude() {
  const { toast, confirm, runJob } = useApp();
  const [info, setInfo] = useState<RcInfo | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<RcConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(
    () =>
      api<RcInfo>('/api/claude-rc')
        .then((d) => {
          setInfo(d);
          setErr('');
          setForm((f) => f ?? { ...d.config, distro: d.distros.some((x) => x.name === d.config.distro) ? d.config.distro : (d.distros[0]?.name ?? d.config.distro) });
        })
        .catch((e) => setErr(errMsg(e))),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);
  useInterval(load, info?.installed ? 4000 : null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [info?.log]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="content">{err}</div>;
  if (!info || !form) return <Spinner label="Kontrol ediliyor…" />;

  const header = <Header title="Claude" subtitle="Remote Control (claude rc) servisi" actions={<IconButton icon="refresh" label="Yenile" onClick={load} />} />;

  if (!info.svAvailable)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="server" title="termux-services gerekli">
            <code>claude rc</code> panelden bağımsız, sürekli çalışan bir servis olarak kurulur. Bunun için <code>termux-services</code> paketi gerekli. Kurduktan
            sonra Termux'u tamamen kapatıp yeniden aç.
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => runJob(post<JobMeta>('/api/pkg/install', { names: ['termux-services'] }), () => load())}>
                <Icon name="download" size={18} /> termux-services kur
              </button>
            </div>
          </Empty>
        </div>
      </>
    );

  if (!info.pd.available || !info.distros.length)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="box" title="Linux ortamı gerekli">
            {info.pd.available ? 'Claude Code bir proot-distro içinde (ör. Debian) çalışır. Önce bir distro ve Claude Code kur.' : info.pd.reason}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => navigate('setup')}>
                Kurulum'a git
              </button>
            </div>
          </Empty>
        </div>
      </>
    );

  const st = info.status;
  const up = st?.state === 'run';
  const d = info.distros.find((x) => x.name === form.distro);
  const saved = info.config;
  const dirty = info.installed && JSON.stringify(saved) !== JSON.stringify(form);
  const loginTerminal = () =>
    navigate('terminal', { env: form.distro, cmd: `export PATH="$HOME/.local/bin:$PATH"; mkdir -p ${shq(form.cwd)} && cd ${shq(form.cwd)} && claude` });

  return (
    <>
      {header}
      <div className="content stack">
        {info.phantom.status === 'warn' && (
          <button className="callout" style={{ border: 0, textAlign: 'left', width: '100%' }} onClick={() => navigate('setup')}>
            <Icon name="alert" />
            <span>
              Android arka plandaki süreçleri öldürebilir (phantom process killer). {info.phantom.detail} Ayrıntı için dokun.
            </span>
          </button>
        )}

        {d && !d.claude && (
          <div className="callout">
            <Icon name="alert" />
            <span>
              {form.distro} içinde <code>claude</code> bulunamadı. <a href="#/setup">Kurulum</a> sayfasından kur.
            </span>
          </div>
        )}
        {d?.claude && !d.loggedIn && (
          <div className="callout">
            <Icon name="info" />
            <span>
              {form.distro} içinde henüz Claude'a giriş yapılmamış görünüyor. Servisten önce bir kez terminalde <code>claude</code> çalıştırıp giriş yap ve
              klasöre güven.{' '}
              <button className="btn btn-sm" onClick={loginTerminal}>
                <Icon name="terminal" size={16} /> Terminalde aç
              </button>
            </span>
          </div>
        )}

        {info.installed && st && (
          <div className="card">
            <div className="row">
              <span className={`badge ${up ? 'badge-good' : 'badge-bad'}`}>
                <Icon name={up ? 'play' : 'stop'} size={11} />
                {up ? 'Çalışıyor' : st.state === 'down' ? 'Durdu' : st.state}
              </span>
              <div className="list-main">
                <div className="list-title">claude rc</div>
                <div className="list-sub">
                  {up ? `PID ${st.pid} · ${fmtDuration(st.seconds)} · ` : ''}
                  {saved.distro}:{saved.cwd}
                </div>
              </div>
              {busy && <div className="spinner" />}
            </div>
            {info.urls.length > 0 && (
              <div className="stack" style={{ marginTop: 12, gap: 6 }}>
                {info.urls.map((u, i) => (
                  <a key={u} className={`btn ${i === 0 ? 'btn-primary' : ''}`} href={u} target="_blank" rel="noreferrer" style={{ justifyContent: 'flex-start', overflow: 'hidden' }}>
                    <Icon name="link" size={16} />
                    <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                      {u}
                    </span>
                  </a>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <Switch
                checked={st.enabled}
                onChange={(v) => act(() => post(`/api/services/claude-rc/${v ? 'enable' : 'disable'}`))}
                label="Termux açılınca başlat"
                disabled={busy}
              />
              <span className="spacer" />
              {up ? (
                <>
                  <button className="btn btn-sm" disabled={busy} onClick={() => act(() => post('/api/claude-rc/restart'))}>
                    <Icon name="restart" size={16} /> Yeniden
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => act(() => post('/api/claude-rc/down'))}>
                    <Icon name="stop" size={16} /> Durdur
                  </button>
                </>
              ) : (
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => post('/api/claude-rc/up'))}>
                  <Icon name="play" size={16} /> Başlat
                </button>
              )}
            </div>
          </div>
        )}

        <div className="section-title">{info.installed ? 'Ayarlar' : 'Servisi kur'}</div>
        <div className="card stack">
          {!info.installed && (
            <div className="muted" style={{ fontSize: 13.5 }}>
              <code>claude rc</code> termux-services ile arka planda çalışır: panel kapansa da sürer, çökerse 10 sn sonra yeniden başlar ve wake lock alır.
              Oturum bağlantısı burada görünür.
            </div>
          )}
          <div>
            <label className="field-label">Distro</label>
            <div className="chips" role="radiogroup">
              {info.distros.map((x) => (
                <button key={x.name} role="radio" aria-checked={form.distro === x.name} className={`chip ${form.distro === x.name ? 'on' : ''}`} onClick={() => setForm({ ...form, distro: x.name })}>
                  <Icon name="box" size={14} />
                  {x.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">Çalışma klasörü (distro içindeki yol)</label>
            <input className="input mono" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder="/root/projeler" autoCapitalize="off" spellCheck={false} />
            {info.binds.length > 0 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {info.binds.map((b) => (
                  <button key={b.dst} className="chip" onClick={() => setForm({ ...form, cwd: b.dst })} title={b.src}>
                    <Icon name="folder" size={14} /> {b.dst}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="field-label">Komut</label>
            <input className="input mono" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="claude rc" autoCapitalize="off" spellCheck={false} />
          </div>
          <Switch checked={form.tty} onChange={(v) => setForm({ ...form, tty: v })} label="Sahte terminal (TTY) ver: claude etkileşimli terminal isterse açık kalsın" />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {info.installed && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={async () => {
                  if (await confirm({ title: 'Servis kaldırılsın mı?', message: 'claude rc durdurulur ve servis silinir. Distroya dokunulmaz.', confirm: 'Kaldır', danger: true }))
                    act(() => del('/api/claude-rc'), 'Servis kaldırıldı');
                }}
              >
                <Icon name="trash" size={16} /> Kaldır
              </button>
            )}
            <span className="spacer" />
            <button
              className="btn btn-primary"
              disabled={busy || (info.installed && !dirty)}
              onClick={() => act(() => put('/api/claude-rc', form), info.installed ? 'Kaydedildi, yeniden başlatıldı' : 'Servis kuruldu')}
            >
              <Icon name={info.installed ? 'save' : 'download'} size={18} /> {info.installed ? 'Kaydet ve yeniden başlat' : 'Kur ve başlat'}
            </button>
          </div>
        </div>

        {info.installed && (
          <>
            <div className="row">
              <div className="section-title" style={{ flex: 1 }}>
                Log
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => act(() => post('/api/claude-rc/clear-log'))}>
                Temizle
              </button>
            </div>
            <pre ref={logRef} className="job-output" style={{ maxHeight: '50vh', overflow: 'auto', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
              {info.log || '(henüz çıktı yok)'}
            </pre>
          </>
        )}
      </div>
    </>
  );
}
