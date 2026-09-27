import { useEffect, useRef, useState } from 'react';
import { api, errMsg, fmtBytes, fmtDuration, post } from '../api';
import { LevelTag, Meter, Sparkline } from '../components/charts';
import { Icon } from '../components/Icon';
import { Header, IconButton, Spinner, useInterval } from '../components/ui';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';
import { bulkTodo, type SetupInfo } from './Setup';

interface Mem {
  total: number;
  used: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
}
interface Info {
  hostname: string;
  platform: string;
  arch: string;
  isTermux: boolean;
  termuxVersion: string | null;
  home: string;
  prefix: string;
  shell: string;
  ptyBackend: string;
  cpuModel: string | null;
  cpuCount: number;
  memory: Mem;
  disks: { mount: string; label: string; total: number; used: number; free: number }[];
  versions: { node: string; python: string | null; git: string | null };
  network: { name: string; address: string; family: string }[];
  termuxApi: boolean;
}
interface Stats {
  cpu: number | null;
  load: number[];
  uptime: number;
  memory: Mem;
  battery: { percentage: number; status: string; temperature: number; health: string; plugged: string } | null;
}

const HISTORY = 40;
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);

export default function Dashboard() {
  const { runJob } = useApp();
  const [info, setInfo] = useState<Info | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState('');
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);

  const loadStats = () =>
    api<Stats>('/api/system/stats')
      .then((s) => {
        const cpuVal = s.cpu ?? Math.min(100, (s.load[0] / Math.max(1, info?.cpuCount ?? 1)) * 100);
        cpuHist.current = [...cpuHist.current, cpuVal].slice(-HISTORY);
        memHist.current = [...memHist.current, pct(s.memory.used, s.memory.total)].slice(-HISTORY);
        setStats(s);
        setErr('');
      })
      .catch((e) => setErr(errMsg(e)));

  const [setupMissing, setSetupMissing] = useState<string[]>([]);
  useEffect(() => {
    api<Info>('/api/system/info').then(setInfo).catch((e) => setErr(errMsg(e)));
    loadStats();
    // Kurulum durumu ekranı bekletmesin: biraz sonra sor
    const t = setTimeout(
      () =>
        api<SetupInfo>('/api/setup')
          .then((s) => s.isTermux && setSetupMissing(bulkTodo(s.items).filter((i) => i.id !== 'upgrade').map((i) => i.title)))
          .catch(() => {}),
      1500,
    );
    return () => clearTimeout(t);
  }, []);
  useInterval(loadStats, 3000);


  const mem = stats?.memory ?? info?.memory;
  const memPct = mem ? pct(mem.used, mem.total) : null;
  const swapPct = mem && mem.swapTotal ? pct(mem.swapUsed, mem.swapTotal) : null;
  const cpu = stats?.cpu;
  const loadPct = stats && info ? (stats.load[0] / info.cpuCount) * 100 : null;
  const bat = stats?.battery;

  return (
    <>
      <Header
        title="Panel"
        subtitle={info ? `${info.hostname} · ${info.isTermux ? `Termux ${info.termuxVersion ?? ''}` : info.platform}` : undefined}
        actions={<IconButton icon="refresh" label="Yenile" onClick={loadStats} />}
      />
      <div className="content">
        {err && (
          <div className="callout" style={{ marginBottom: 12 }}>
            <Icon name="alert" /> {err}
          </div>
        )}

        {setupMissing.length > 0 && (
          <button className="update-bar" style={{ margin: '0 0 12px', width: '100%', border: 0, textAlign: 'left' }} onClick={() => navigate('setup')}>
            <Icon name="download" size={18} />
            <span className="list-main">
              <span style={{ display: 'block' }}>Kurulum tamamlanmadı</span>
              <span className="muted ellipsis" style={{ display: 'block', fontWeight: 500, fontSize: 12.5 }}>
                Eksik: {setupMissing.join(', ')}
              </span>
            </span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}

        <div className="grid grid-2 grid-4">
          <div className="card">
            <div className="card-title">
              <Icon name="activity" size={16} /> {cpu != null ? 'CPU' : 'Yük (1 dk)'}
              <LevelTag pct={cpu ?? loadPct} />
            </div>
            {cpu != null ? (
              <div className="stat-value">
                {cpu.toFixed(0)}
                <span className="stat-unit">%</span>
              </div>
            ) : (
              <div className="stat-value">{stats?.load[0].toFixed(2) ?? '–'}</div>
            )}
            <div className="stat-sub">
              {info?.cpuCount} çekirdek · {stats?.load.map((l) => l.toFixed(2)).join(' ')}
            </div>
            <Sparkline values={cpuHist.current} format={(v) => `%${v.toFixed(0)}`} />
          </div>

          <div className="card">
            <div className="card-title">
              <Icon name="server" size={16} /> Bellek
              <LevelTag pct={memPct} warn={80} crit={92} />
            </div>
            <div className="stat-value">
              {memPct?.toFixed(0) ?? '–'}
              <span className="stat-unit">%</span>
            </div>
            <div className="stat-sub">
              {fmtBytes(mem?.used)} / {fmtBytes(mem?.total)}
            </div>
            <Sparkline values={memHist.current} format={(v) => `%${v.toFixed(0)}`} />
          </div>

          <div className="card">
            <div className="card-title">
              <Icon name="battery" size={16} /> Pil
              {bat && <LevelTag pct={100 - bat.percentage} warn={80} crit={90} />}
            </div>
            {bat ? (
              <>
                <div className="stat-value">
                  {bat.percentage}
                  <span className="stat-unit">%</span>
                </div>
                <div className="stat-sub">
                  {batteryStatus(bat.status)} · {bat.temperature?.toFixed(1)}°C
                </div>
                <Meter pct={bat.percentage} warn={101} crit={101} label="Pil seviyesi" />
              </>
            ) : (
              <>
                <div className="stat-value faint">–</div>
                <div className="stat-sub">
                  {!info || !stats
                    ? 'Yükleniyor…'
                    : !info.termuxApi
                      ? 'termux-api kurulu değil'
                      : cpuHist.current.length < 4
                        ? 'Okunuyor…'
                        : 'Termux:API yanıt vermedi'}
                </div>
              </>
            )}
          </div>

          <div className="card">
            <div className="card-title">
              <Icon name="refresh" size={16} /> Açık kalma süresi
            </div>
            <div className="stat-value">{fmtDuration(stats?.uptime)}</div>
            {swapPct != null && (
              <>
                <div className="stat-sub">
                  Swap {fmtBytes(mem?.swapUsed)} / {fmtBytes(mem?.swapTotal)}
                </div>
                <Meter pct={swapPct} label="Swap kullanımı" />
              </>
            )}
          </div>
        </div>

        <div className="section-title">Hızlı işlemler</div>
        <QuickActions runJob={runJob} />

        <div className="grid grid-md-2" style={{ marginTop: 12 }}>
          <div className="card">
            <div className="card-title">
              <Icon name="save" size={16} /> Depolama
            </div>
            <div className="stack">
              {info?.disks.map((d) => {
                const p = pct(d.used, d.total);
                return (
                  <div key={d.mount}>
                    <div className="row">
                      <span style={{ fontWeight: 600 }}>{d.label}</span>
                      <LevelTag pct={p} warn={85} crit={95} />
                      <span className="spacer" />
                      <span className="muted num" style={{ fontSize: 13 }}>
                        {fmtBytes(d.free)} boş / {fmtBytes(d.total)}
                      </span>
                    </div>
                    <Meter pct={p} warn={85} crit={95} label={`${d.label} doluluk`} />
                  </div>
                );
              })}
              {!info && <Spinner />}
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              <Icon name="info" size={16} /> Sistem
            </div>
            {info && (
              <dl className="kv" style={{ margin: 0 }}>
                <dt>Mimari</dt>
                <dd>{info.arch}</dd>
                <dt>Çekirdek</dt>
                <dd title={info.platform}>{info.platform}</dd>
                <dt>Node.js</dt>
                <dd>{info.versions.node}</dd>
                <dt>Python</dt>
                <dd>{info.versions.python?.replace('Python ', '') ?? 'yok'}</dd>
                <dt>Git</dt>
                <dd>{info.versions.git?.replace('git version ', '') ?? 'yok'}</dd>
                <dt>Kabuk</dt>
                <dd>{info.shell}</dd>
                <dt>Terminal</dt>
                <dd>{info.ptyBackend}</dd>
                <dt>Home</dt>
                <dd title={info.home}>{info.home}</dd>
                {info.network
                  .filter((n) => n.family === 'IPv4')
                  .map((n) => (
                    <FragmentKV key={n.name + n.address} k={n.name} v={n.address} />
                  ))}
              </dl>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function batteryStatus(s: string) {
  const m: Record<string, string> = { CHARGING: 'Şarj oluyor', DISCHARGING: 'Deşarj', FULL: 'Dolu', NOT_CHARGING: 'Şarj olmuyor' };
  return m[s] ?? s;
}

function QuickActions({ runJob }: { runJob: (p: Promise<JobMeta>) => Promise<void> }) {
  return (
    <div className="quick">
      <button onClick={() => navigate('terminal', { new: '1' })}>
        <Icon name="terminal" size={22} />
        Yeni terminal
      </button>
      <button onClick={() => runJob(post<JobMeta>('/api/pkg/update'))}>
        <Icon name="refresh" size={22} />
        pkg update
      </button>
      <button onClick={() => navigate('packages', { tab: 'updates' })}>
        <Icon name="download" size={22} />
        Güncellemeler
      </button>
      <button onClick={() => navigate('files')}>
        <Icon name="folder" size={22} />
        Dosyalar
      </button>
      <button onClick={() => navigate('processes')}>
        <Icon name="activity" size={22} />
        Süreçler
      </button>
      <button onClick={() => navigate('shortcuts')}>
        <Icon name="zap" size={22} />
        Kısayollar
      </button>
    </div>
  );
}
