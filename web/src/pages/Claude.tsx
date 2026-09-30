import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, errMsg, fmtDuration, post, put, shq } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, Spinner, Switch, useInterval } from '../components/ui';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

interface RcConfig {
  cwd: string;
  command: string;
  tty: boolean;
}
interface RcInfo {
  svAvailable: boolean;
  installed: boolean;
  /** Servis eski sürümde bir distroda çalışacak şekilde kurulmuş */
  legacy: string | null;
  status: { state: string; pid: number | null; seconds: number | null; enabled: boolean; raw: string } | null;
  config: RcConfig;
  claude: { installed: boolean; npm: boolean; version: string | null; loggedIn: boolean };
  folders: string[];
  home: string;
  tty: boolean;
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
          setForm((f) => f ?? d.config);
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

  if (!info.claude.installed)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="message" title="Claude Code kurulu değil">
            {info.claude.npm
              ? 'Eski bir npm kurulumu bulundu. Kurulum sayfasındaki adım, taşıma (migrate.sh) komutlarını gösterir.'
              : 'Claude Code doğrudan Termux\'a kurulur (claude-code-android). Kurulum sayfasından tek dokunuşla kurabilirsin.'}
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
  const saved = info.config;
  const dirty = info.installed && (Boolean(info.legacy) || JSON.stringify(saved) !== JSON.stringify(form));
  const loginTerminal = () => navigate('terminal', { cmd: `mkdir -p ${shq(form.cwd)} && cd ${shq(form.cwd)} && claude` });

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

        {info.legacy && (
          <div className="callout">
            <Icon name="alert" />
            <span>
              Bu servis eski sürümde bir distro içinde ({info.legacy}) çalışacak şekilde kurulmuş. Claude artık doğrudan Termux'ta çalışıyor: klasörü kontrol edip{' '}
              <b>Kaydet ve yeniden başlat</b>'a dokun.
            </span>
          </div>
        )}
        {!info.claude.loggedIn && (
          <div className="callout">
            <Icon name="info" />
            <span>
              Henüz Claude'a giriş yapılmamış görünüyor. Servisten önce bir kez terminalde <code>claude</code> çalıştırıp giriş yap ve
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
                  {info.legacy ? `${info.legacy}:` : ''}
                  {saved.cwd}
                  {info.claude.version ? ` · v${info.claude.version}` : ''}
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
            <label className="field-label">Çalışma klasörü</label>
            <input className="input mono" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder={`${info.home}/projeler`} autoCapitalize="off" spellCheck={false} />
            {info.folders.length > 0 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {info.folders.map((f) => (
                  <button key={f} className="chip" onClick={() => setForm({ ...form, cwd: f })}>
                    <Icon name="folder" size={14} /> {f.startsWith(info.home) ? `~${f.slice(info.home.length)}` : f}
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
          {form.tty && !info.tty && (
            <div className="faint" style={{ fontSize: 12.5 }}>
              TTY için <code>script</code> komutu gerekli: <code>pkg install util-linux</code>
            </div>
          )}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {info.installed && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={async () => {
                  if (await confirm({ title: 'Servis kaldırılsın mı?', message: 'claude rc durdurulur ve servis silinir. Claude Code ve ayarların yerinde kalır.', confirm: 'Kaldır', danger: true }))
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
