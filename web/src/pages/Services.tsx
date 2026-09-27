import { useEffect, useState } from 'react';
import { api, errMsg, fmtDuration, post } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, Sheet, Spinner, Switch } from '../components/ui';
import { useApp, type JobMeta } from '../store';

interface Service {
  name: string;
  state: string;
  pid: number | null;
  seconds: number | null;
  enabled: boolean;
  hasLog: boolean;
  raw: string;
}

export default function Services() {
  const { toast, runJob } = useApp();
  const [data, setData] = useState<{ available: boolean; services: Service[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ name: string; content: string } | null>(null);

  const load = () =>
    api<{ available: boolean; services: Service[] }>('/api/services')
      .then((d) => {
        setData(d);
        setErr('');
      })
      .catch((e) => setErr(errMsg(e)));

  useEffect(() => {
    load();
  }, []);

  const action = async (name: string, a: string) => {
    setBusy(name);
    try {
      await post(`/api/services/${encodeURIComponent(name)}/${a}`);
      await load();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const showLog = async (name: string) => {
    try {
      const r = await api<{ content: string }>(`/api/services/${encodeURIComponent(name)}/log`);
      setLog({ name, content: r.content });
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <>
      <Header title="Servisler" subtitle="termux-services (runit)" actions={<IconButton icon="refresh" label="Yenile" onClick={load} />} />
      <div className="content stack">
        {err && <Empty icon="alert" title="Servisler okunamadı">{err}</Empty>}
        {!data && !err && <Spinner />}
        {data && !data.available && (
          <Empty icon="server" title="termux-services kurulu değil">
            Arka plan servislerini (sshd, crond, nginx, postgres…) yönetmek için <code>termux-services</code> paketi gerekli. Kurulumdan sonra Termux'u
            yeniden başlat.
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => runJob(post<JobMeta>('/api/pkg/install', { names: ['termux-services'] }), () => load())}>
                <Icon name="download" size={18} /> termux-services kur
              </button>
            </div>
          </Empty>
        )}
        {data?.available && data.services.length === 0 && <Empty title="Hiç servis yok">Servis sağlayan paketler (ör. openssh) kurulunca burada görünür.</Empty>}
        {data?.available &&
          data.services.map((s) => {
            const up = s.state === 'run';
            return (
              <div key={s.name} className="card">
                <div className="row">
                  <span className={`badge ${up ? 'badge-good' : 'badge-bad'}`}>
                    <Icon name={up ? 'play' : 'stop'} size={11} />
                    {up ? 'Çalışıyor' : s.state === 'down' ? 'Durdu' : s.state}
                  </span>
                  <div className="list-main">
                    <div className="list-title">{s.name}</div>
                    <div className="list-sub">{up ? `PID ${s.pid} · ${fmtDuration(s.seconds)}` : s.raw}</div>
                  </div>
                  {busy === s.name && <div className="spinner" />}
                </div>
                <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  <Switch checked={s.enabled} onChange={(v) => action(s.name, v ? 'enable' : 'disable')} label="Otomatik başlat" disabled={busy === s.name} />
                  <span className="spacer" />
                  {up ? (
                    <>
                      <button className="btn btn-sm" onClick={() => action(s.name, 'restart')} disabled={busy === s.name}>
                        <Icon name="restart" size={16} /> Yeniden
                      </button>
                      <button className="btn btn-sm" onClick={() => action(s.name, 'down')} disabled={busy === s.name}>
                        <Icon name="stop" size={16} /> Durdur
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => action(s.name, 'up')} disabled={busy === s.name}>
                      <Icon name="play" size={16} /> Başlat
                    </button>
                  )}
                  {s.hasLog && (
                    <button className="btn btn-sm btn-ghost" onClick={() => showLog(s.name)}>
                      Log
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
      <Sheet open={!!log} onClose={() => setLog(null)} title={`${log?.name} log`} full>
        <pre className="job-output">{log?.content}</pre>
      </Sheet>
    </>
  );
}
