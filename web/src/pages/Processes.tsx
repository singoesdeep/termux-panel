import { useEffect, useMemo, useState } from 'react';
import { api, errMsg, fmtBytes, fmtDuration, post } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, SearchInput, Sheet, Spinner, useInterval } from '../components/ui';
import { useApp } from '../store';

interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  cmd: string;
  state: string;
  cpu: number;
  rss: number;
  mem: number;
  elapsed: number;
  threads: number;
}
type Sort = 'cpu' | 'mem' | 'pid' | 'name';

const STATES: Record<string, string> = { R: 'Çalışıyor', S: 'Uyuyor', D: 'Disk bekliyor', Z: 'Zombi', T: 'Durduruldu', I: 'Boşta' };

export default function Processes() {
  const { toast, confirm } = useApp();
  const [list, setList] = useState<Proc[] | null>(null);
  const [self, setSelf] = useState(0);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('cpu');
  const [live, setLive] = useState(true);
  const [sel, setSel] = useState<Proc | null>(null);

  const load = () =>
    api<{ processes: Proc[]; self: number }>('/api/proc')
      .then((r) => {
        setList(r.processes);
        setSelf(r.self);
        setErr('');
      })
      .catch((e) => setErr(errMsg(e)));

  useEffect(() => {
    load();
  }, []);
  useInterval(load, live ? 3000 : null);

  const shown = useMemo(() => {
    if (!list) return [];
    const f = filter.toLowerCase();
    const l = f ? list.filter((p) => p.cmd.toLowerCase().includes(f) || String(p.pid) === f) : list;
    return [...l].sort((a, b) =>
      sort === 'cpu' ? b.cpu - a.cpu || b.rss - a.rss : sort === 'mem' ? b.rss - a.rss : sort === 'pid' ? a.pid - b.pid : a.name.localeCompare(b.name),
    );
  }, [list, filter, sort]);

  const signal = async (p: Proc, sig: string) => {
    if (
      (sig === 'SIGKILL' || sig === 'SIGTERM') &&
      !(await confirm({
        title: `${p.name} (${p.pid}) ${sig === 'SIGKILL' ? 'zorla ' : ''}durdurulsun mu?`,
        message: <span className="mono" style={{ fontSize: 12.5 }}>{p.cmd}</span>,
        confirm: sig === 'SIGKILL' ? 'Zorla öldür' : 'Durdur',
        danger: true,
      }))
    )
      return;
    try {
      await post(`/api/proc/${p.pid}/signal`, { signal: sig });
      toast(`${sig} gönderildi`, 'ok');
      setSel(null);
      setTimeout(load, 400);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const current = sel && list?.find((p) => p.pid === sel.pid);

  return (
    <>
      <Header
        title="Süreçler"
        subtitle={list ? `${list.length} süreç` : undefined}
        actions={
          <>
            <IconButton icon={live ? 'stop' : 'play'} label={live ? 'Canlı güncellemeyi durdur' : 'Canlı güncelle'} onClick={() => setLive(!live)} active={live} />
            <IconButton icon="refresh" label="Yenile" onClick={load} />
          </>
        }
      />
      <div className="content stack">
        <SearchInput value={filter} onChange={setFilter} placeholder="Komut veya PID ara…" />
        <div className="chips">
          {(
            [
              ['cpu', 'CPU'],
              ['mem', 'Bellek'],
              ['pid', 'PID'],
              ['name', 'Ad'],
            ] as [Sort, string][]
          ).map(([k, l]) => (
            <button key={k} className={`chip ${sort === k ? 'on' : ''}`} onClick={() => setSort(k)}>
              {sort === k && <Icon name="chevron-down" size={14} />} {l}
            </button>
          ))}
        </div>
        {err && <Empty icon="alert" title="Süreçler okunamadı">{err}</Empty>}
        {!list && !err && <Spinner />}
        {list && (
          <div className="list">
            {shown.slice(0, 300).map((p) => (
              <button key={p.pid} className="list-item" onClick={() => setSel(p)}>
                <div className="list-main">
                  <div className="list-title">
                    {p.name}
                    {p.pid === self && <span className="badge" style={{ marginLeft: 6 }}>panel</span>}
                    {p.state === 'Z' && <span className="badge badge-bad" style={{ marginLeft: 6 }}>zombi</span>}
                  </div>
                  <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                    {p.cmd}
                  </div>
                  <div className="proc-meta">
                    <span>PID {p.pid}</span>
                    <span>{fmtBytes(p.rss)}</span>
                    {p.elapsed > 0 && <span>{fmtDuration(p.elapsed)}</span>}
                  </div>
                </div>
                <div className="proc-cpu" style={{ color: p.cpu >= 50 ? 'var(--critical)' : undefined }}>
                  {p.cpu.toFixed(1)}%
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Sheet open={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.name} · ${sel.pid}` : ''}>
        {sel && (
          <div className="stack">
            <pre className="job-output" style={{ minHeight: 0, maxHeight: 140 }}>
              {sel.cmd}
            </pre>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Durum</dt>
              <dd>{STATES[(current ?? sel).state] ?? (current ?? sel).state}</dd>
              <dt>CPU</dt>
              <dd>{(current ?? sel).cpu.toFixed(1)}%</dd>
              <dt>Bellek (RSS)</dt>
              <dd>
                {fmtBytes((current ?? sel).rss)} · %{(current ?? sel).mem}
              </dd>
              <dt>Üst süreç</dt>
              <dd>{sel.ppid}</dd>
              <dt>İş parçacığı</dt>
              <dd>{sel.threads}</dd>
              {sel.elapsed > 0 && (
                <>
                  <dt>Çalışma süresi</dt>
                  <dd>{fmtDuration(sel.elapsed)}</dd>
                </>
              )}
            </dl>
            {!current && <div className="faint">Süreç artık çalışmıyor.</div>}
            <div className="grid grid-2">
              <button className="btn" onClick={() => signal(sel, 'SIGTERM')} disabled={!current}>
                <Icon name="stop" size={18} /> Durdur
              </button>
              <button className="btn btn-danger" onClick={() => signal(sel, 'SIGKILL')} disabled={!current}>
                <Icon name="x" size={18} /> Zorla öldür
              </button>
              <button className="btn" onClick={() => signal(sel, 'SIGSTOP')} disabled={!current}>
                Duraklat
              </button>
              <button className="btn" onClick={() => signal(sel, 'SIGCONT')} disabled={!current}>
                Devam ettir
              </button>
              <button className="btn" onClick={() => signal(sel, 'SIGHUP')} disabled={!current}>
                SIGHUP
              </button>
              <button className="btn" onClick={() => signal(sel, 'SIGINT')} disabled={!current}>
                SIGINT
              </button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
