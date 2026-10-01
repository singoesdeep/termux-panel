import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, errMsg, fmtDuration, post, put, shq } from '../api';
import { Icon } from '../components/Icon';
import { FolderPicker } from '../components/FolderPicker';
import { Empty, Header, IconButton, Sheet, Spinner, Switch, useInterval } from '../components/ui';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

type AgentId = 'claude' | 'agy';

interface SvStatus {
  state: string;
  pid: number | null;
  seconds: number | null;
  enabled: boolean;
}
interface AgentInfo {
  id: AgentId;
  title: string;
  defaultCommand: string;
  /** Klasöre güven onayı panel tarafından verilebiliyor mu */
  autoTrust: boolean;
  installed: boolean;
  version: string | null;
  /** null: bilinmiyor */
  loggedIn: boolean | null;
}
interface ProjectAgent {
  agent: AgentId;
  command: string;
  tty: boolean;
  service: string;
  trusted: boolean | null;
  status: SvStatus | null;
  url: string | null;
}
interface Project {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  agents: ProjectAgent[];
}
interface Info {
  svAvailable: boolean;
  agents: Record<AgentId, AgentInfo>;
  projects: Project[];
  legacy: boolean;
  home: string;
  tty: boolean;
  wakeLock: boolean;
  phantom: { status: 'ok' | 'warn'; detail: string };
}

type Form = { name: string; path: string; agents: AgentId[]; start: boolean };

const AGENT_IDS: AgentId[] = ['claude', 'agy'];
/** Terminalde etkileşimli açmak için komut (giriş, klasör güveni) */
const CLI: Record<AgentId, string> = { claude: 'claude', agy: 'agy' };

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? '';

/** Proje olamayacak klasörler (sunucudaki kontrolle aynı) */
const rejectDir = (p: string, home: string) =>
  p === home || home.startsWith(`${p}/`) || p === '/' ? 'Home ya da onu içeren bir klasör proje olamaz: projeye ait bir alt klasöre gir ya da yeni klasör oluştur.' : null;

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* yok say */
  }
};

export default function Projects({ params }: { params: URLSearchParams }) {
  const { toast, confirm, prompt, runJob } = useApp();
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  /** Klasör seçici: yeni proje için (form yok) ya da formdaki klasörü değiştirmek için */
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<Project | null>(null);
  const [agentMenu, setAgentMenu] = useState<{ p: Project; a: ProjectAgent } | null>(null);
  const [edit, setEdit] = useState<{ p: Project; a: ProjectAgent } | null>(null);
  const [logOf, setLogOf] = useState<{ p: Project; a: ProjectAgent } | null>(null);

  const load = useCallback(
    () =>
      api<Info>('/api/projects')
        .then((d) => {
          setInfo(d);
          setErr('');
        })
        .catch((e) => setErr(errMsg(e))),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);
  useInterval(load, info?.projects.some((p) => p.agents.some((a) => a.status)) ? 4000 : null);

  const installed = info ? AGENT_IDS.filter((a) => info.agents[a].installed) : [];

  // Dosyalar → "Proje yap" ile gelindiğinde: #/projects?add=/yol
  const add = params.get('add');
  useEffect(() => {
    if (!add || !info) return;
    navigate('projects', undefined, true);
    setForm({ name: basename(add), path: add, agents: installed.slice(0, 1), start: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [add, info === null]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      await load();
      return true;
    } catch (e) {
      toast(errMsg(e), 'err');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (err) return <div className="content">{err}</div>;
  if (!info) return <Spinner label="Kontrol ediliyor…" />;

  const versions = AGENT_IDS.filter((a) => info.agents[a].installed).map((a) => `${info.agents[a].title}${info.agents[a].version ? ` ${info.agents[a].version}` : ''}`);
  const header = (
    <Header title="Projeler" subtitle={versions.length ? versions.join(' · ') : 'AI ajanları için uzaktan kontrol'} actions={<IconButton icon="refresh" label="Yenile" onClick={load} />} />
  );

  if (!installed.length)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="message" title="Kurulu AI aracı yok">
            Claude Code ve Antigravity CLI doğrudan Termux'a kurulur. İstediğini ya da ikisini birden Kurulum sayfasından kurabilirsin.
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => navigate('setup')}>
                Kurulum'a git
              </button>
            </div>
          </Empty>
        </div>
      </>
    );

  if (!info.svAvailable)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="server" title="termux-services gerekli">
            Her projenin uzaktan kontrol oturumu panelden bağımsız, sürekli çalışan bir servis olarak kurulur. Bunun için <code>termux-services</code> paketi
            gerekli. Kurduktan sonra Termux'u tamamen kapatıp yeniden aç.
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => runJob(post<JobMeta>('/api/pkg/install', { names: ['termux-services'] }), () => load())}>
                <Icon name="download" size={18} /> termux-services kur
              </button>
            </div>
          </Empty>
        </div>
      </>
    );

  const tilde = (p: string) => (p === info.home ? '~' : p.startsWith(`${info.home}/`) ? `~${p.slice(info.home.length)}` : p);
  const title = (a: AgentId) => info.agents[a].title;
  const picked = (path: string) => {
    setPicking(false);
    // Ad elle değiştirilmediyse klasör adından gelir
    setForm((f) => (f ? { ...f, path, name: !f.name || f.name === basename(f.path) ? basename(path) : f.name } : { name: basename(path), path, agents: installed.slice(0, 1), start: true }));
  };
  const agentUrl = (p: Project, a: AgentId) => `/api/projects/${p.id}/agents/${a}`;
  const openCli = (p: Project, a: AgentId) => {
    lsSet(`tp-cli-opened-${p.id}-${a}`, '1');
    navigate('terminal', { cmd: `cd ${shq(p.path)} && ${CLI[a]}` });
  };

  const submit = async () => {
    if (!form) return;
    setBusy('form');
    try {
      const r = await post<{ errors: string[] }>('/api/projects', { name: form.name, path: form.path, create: false, agents: form.agents, start: form.start });
      setForm(null);
      if (r.errors.length) toast(`Proje eklendi, ama başlatılamadı: ${r.errors.join(' · ')}`, 'err');
      else toast(form.start ? 'Proje eklendi, başlatıldı' : 'Proje eklendi', 'ok');
      await load();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {header}
      <div className="content stack">
        {info.phantom.status === 'warn' && (
          <button className="callout" style={{ border: 0, textAlign: 'left', width: '100%' }} onClick={() => navigate('setup')}>
            <Icon name="alert" />
            <span>Android arka plandaki süreçleri öldürebilir (phantom process killer). {info.phantom.detail} Ayrıntı için dokun.</span>
          </button>
        )}

        {AGENT_IDS.filter((a) => info.agents[a].installed && info.agents[a].loggedIn === false).map((a) => (
          <div key={a} className="callout">
            <Icon name="info" />
            <span>
              Henüz {title(a)}'e giriş yapılmamış görünüyor. Başlatmadan önce terminalde bir kez <code>{CLI[a]}</code> çalıştırıp giriş yap.{' '}
              <button className="btn btn-sm" onClick={() => navigate('terminal', { cmd: CLI[a] })}>
                <Icon name="terminal" size={16} /> Terminalde aç
              </button>
            </span>
          </div>
        ))}

        {info.legacy && (
          <div className="callout">
            <Icon name="alert" />
            <span>
              Eski sürümden kalan tek bir <code>claude-rc</code> servisi var (distroda ya da genel bir klasörde çalışıyor olabilir). Artık her proje kendi servisine
              sahip; eskisini kaldırabilirsin.{' '}
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={async () => {
                  if (await confirm({ title: 'Eski servis kaldırılsın mı?', message: 'claude-rc durdurulur ve silinir. Dosyalara dokunulmaz.', confirm: 'Kaldır', danger: true }))
                    act('legacy', () => del('/api/projects/legacy'), 'Eski servis kaldırıldı');
                }}
              >
                <Icon name="trash" size={16} /> Kaldır
              </button>
            </span>
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setPicking(true)}>
            <Icon name="folder-plus" size={18} /> Proje ekle
          </button>
        </div>

        {info.projects.length === 0 ? (
          <Empty icon="folder" title="Henüz proje yok">
            Her proje Termux'ta bir klasördür. İçinde Claude Code, Antigravity ya da ikisi birden ayrı uzaktan kontrol oturumlarıyla çalışır; ajan yalnızca o
            klasörü görür. <b>Proje ekle</b> ile klasörünü seç ya da orada yeni klasör oluştur. Dosyalar sayfasında bir klasörün menüsündeki <b>Proje yap</b> da aynı işi görür.
          </Empty>
        ) : (
          info.projects.map((p) => {
            const missing = installed.filter((a) => !p.agents.some((x) => x.agent === a));
            return (
              <div key={p.id} className="card">
                <div className="row">
                  <Icon name="folder" />
                  <div className="list-main">
                    <div className="list-title">{p.name}</div>
                    <div className="list-sub mono" style={{ fontSize: 12 }}>
                      {tilde(p.path)}
                    </div>
                  </div>
                  <IconButton icon="more" label="Proje seçenekleri" onClick={() => setMenu(p)} />
                </div>
                {!p.exists && (
                  <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                    Klasör bulunamadı. Silinmiş ya da taşınmış olabilir.
                  </div>
                )}
                {p.agents.map((a) => (
                  <AgentRow
                    key={a.agent}
                    p={p}
                    a={a}
                    title={title(a.agent)}
                    agentInstalled={info.agents[a.agent].installed}
                    needsSetup={!info.agents[a.agent].autoTrust && !lsGet(`tp-cli-opened-${p.id}-${a.agent}`)}
                    busy={busy}
                    onToggle={(v) => act(`${p.id}:${a.agent}`, () => post(`/api/services/${a.service}/${v ? 'enable' : 'disable'}`))}
                    onStart={() => act(`${p.id}:${a.agent}`, () => post(`${agentUrl(p, a.agent)}/up`))}
                    onStop={() => act(`${p.id}:${a.agent}`, () => post(`${agentUrl(p, a.agent)}/down`))}
                    onLog={() => setLogOf({ p, a })}
                    onMenu={() => setAgentMenu({ p, a })}
                    onOpenCli={() => openCli(p, a.agent)}
                  />
                ))}
                {missing.length > 0 && (
                  <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
                    {missing.map((a) => (
                      <button
                        key={a}
                        className="btn btn-sm btn-ghost"
                        disabled={busy !== null}
                        onClick={() => act(`${p.id}:${a}`, () => put(agentUrl(p, a), {}), `${title(a)} eklendi`)}
                      >
                        <Icon name="plus" size={16} /> {title(a)} ekle
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Proje ekle: önce klasör seçilir (gerekirse orada oluşturulur), sonra ad ve ajanlar */}
      <FolderPicker
        open={picking}
        start={form?.path ?? '~'}
        title={form ? 'Proje klasörünü değiştir' : 'Proje klasörü seç'}
        reject={rejectDir}
        onPick={picked}
        onClose={() => setPicking(false)}
      />
      <Sheet
        open={form !== null && !picking}
        onClose={() => setForm(null)}
        title="Proje ekle"
        footer={
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy !== null || !form?.agents.length || !form.name.trim()} onClick={submit}>
            <Icon name="plus" size={18} /> Ekle
          </button>
        }
      >
        {form && (
          <div className="stack">
            <div>
              <label className="field-label">Klasör</label>
              <button className="btn" style={{ width: '100%', justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => setPicking(true)}>
                <Icon name="folder" size={18} />
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, flex: 1, textAlign: 'left' }}>
                  {tilde(form.path)}
                </span>
                <span className="faint" style={{ fontSize: 12.5 }}>
                  Değiştir
                </span>
              </button>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                Ajan yalnızca bu klasörde çalışır.
              </div>
            </div>
            <div>
              <label className="field-label">Proje adı</label>
              <input className="input" value={form.name} placeholder="ör. blog" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Ajanlar</label>
              <div className="chips">
                {AGENT_IDS.map((a) => {
                  const on = form.agents.includes(a);
                  const ok = info.agents[a].installed;
                  return (
                    <button
                      key={a}
                      role="checkbox"
                      aria-checked={on}
                      disabled={!ok}
                      className={`chip ${on ? 'on' : ''}`}
                      onClick={() => setForm({ ...form, agents: on ? form.agents.filter((x) => x !== a) : [...form.agents, a] })}
                      title={ok ? undefined : 'Kurulu değil'}
                    >
                      <Icon name={on ? 'check' : 'plus'} size={14} /> {title(a)}
                      {!ok && ' (kurulu değil)'}
                    </button>
                  );
                })}
              </div>
            </div>
            <Switch checked={form.start} onChange={(v) => setForm({ ...form, start: v })} label="Hemen başlat (Termux açılınca da başlar)" />
          </div>
        )}
      </Sheet>

      {/* Proje menüsü */}
      <Sheet open={menu !== null} onClose={() => setMenu(null)} title={menu?.name}>
        {menu && (
          <div className="action-list">
            <button onClick={() => (setMenu(null), navigate('terminal', { cwd: menu.path }))}>
              <Icon name="terminal" /> Burada terminal aç
            </button>
            <button onClick={() => (setMenu(null), navigate('files', { path: menu.path }))}>
              <Icon name="folder" /> Dosyalarda aç
            </button>
            <button
              onClick={async () => {
                const p = menu;
                setMenu(null);
                const name = await prompt({ title: 'Yeniden adlandır', label: 'Proje adı', value: p.name, confirm: 'Kaydet' });
                if (name?.trim()) act(p.id, () => put(`/api/projects/${p.id}`, { name }), 'Kaydedildi');
              }}
            >
              <Icon name="edit" /> Yeniden adlandır
            </button>
            <button
              className="danger"
              onClick={async () => {
                const p = menu;
                setMenu(null);
                if (
                  await confirm({
                    title: `${p.name} kaldırılsın mı?`,
                    message: `Tüm ajan servisleri durdurulur ve proje listeden çıkar. ${tilde(p.path)} klasörüne dokunulmaz.`,
                    confirm: 'Kaldır',
                    danger: true,
                  })
                )
                  act(p.id, () => del(`/api/projects/${p.id}`), 'Proje kaldırıldı');
              }}
            >
              <Icon name="trash" /> Projeyi kaldır
            </button>
          </div>
        )}
      </Sheet>

      {/* Ajan menüsü */}
      <Sheet open={agentMenu !== null} onClose={() => setAgentMenu(null)} title={agentMenu && `${agentMenu.p.name} · ${title(agentMenu.a.agent)}`}>
        {agentMenu && (
          <div className="action-list">
            {agentMenu.a.status?.state === 'run' && (
              <button onClick={() => (setAgentMenu(null), act(`${agentMenu.p.id}:${agentMenu.a.agent}`, () => post(`${agentUrl(agentMenu.p, agentMenu.a.agent)}/restart`), 'Yeniden başlatıldı'))}>
                <Icon name="restart" /> Yeniden başlat
              </button>
            )}
            <button onClick={() => (setAgentMenu(null), openCli(agentMenu.p, agentMenu.a.agent))}>
              <Icon name="terminal" /> Terminalde {CLI[agentMenu.a.agent]} aç
            </button>
            <button onClick={() => (setAgentMenu(null), setEdit(agentMenu))}>
              <Icon name="edit" /> Ayarlar
            </button>
            {agentMenu.a.trusted === false && (
              <button onClick={() => (setAgentMenu(null), act(agentMenu.p.id, () => post(`${agentUrl(agentMenu.p, agentMenu.a.agent)}/trust`), 'Klasöre güven onayı verildi'))}>
                <Icon name="check" /> Klasöre güven
              </button>
            )}
            <button
              className="danger"
              onClick={async () => {
                const { p, a } = agentMenu;
                setAgentMenu(null);
                if (
                  await confirm({
                    title: `${title(a.agent)} bu projeden çıkarılsın mı?`,
                    message: 'Servisi durdurulur ve silinir. Klasöre dokunulmaz.',
                    confirm: 'Çıkar',
                    danger: true,
                  })
                )
                  act(p.id, () => del(agentUrl(p, a.agent)), `${title(a.agent)} çıkarıldı`);
              }}
            >
              <Icon name="trash" /> Projeden çıkar
            </button>
          </div>
        )}
      </Sheet>

      {edit && (
        <EditSheet
          title={`${edit.p.name} · ${title(edit.a.agent)}`}
          a={edit.a}
          defaultCommand={info.agents[edit.a.agent].defaultCommand}
          ttyAvailable={info.tty}
          busy={busy !== null}
          onClose={() => setEdit(null)}
          onSave={async (b) => {
            if (await act(`${edit.p.id}:${edit.a.agent}`, () => put(agentUrl(edit.p, edit.a.agent), b), 'Kaydedildi')) setEdit(null);
          }}
        />
      )}
      {logOf && <LogSheet title={`${logOf.p.name} · ${title(logOf.a.agent)}`} url={`${agentUrl(logOf.p, logOf.a.agent)}`} onClose={() => setLogOf(null)} />}
    </>
  );
}

function AgentRow({
  p,
  a,
  title,
  agentInstalled,
  needsSetup,
  busy,
  onToggle,
  onStart,
  onStop,
  onLog,
  onMenu,
  onOpenCli,
}: {
  p: Project;
  a: ProjectAgent;
  title: string;
  agentInstalled: boolean;
  needsSetup: boolean;
  busy: string | null;
  onToggle: (v: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onLog: () => void;
  onMenu: () => void;
  onOpenCli: () => void;
}) {
  const st = a.status;
  const up = st?.state === 'run';
  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
      <div className="row">
        <span className={`badge ${up ? 'badge-good' : ''}`}>
          <Icon name={up ? 'play' : 'stop'} size={11} />
          {up ? 'Çalışıyor' : st?.state === 'down' || !st ? 'Durdu' : st.state}
        </span>
        <div className="list-main">
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div className="list-sub mono" style={{ fontSize: 11.5 }}>
            {a.command}
            {up && st?.seconds != null ? ` · ${fmtDuration(st.seconds)}` : ''}
          </div>
        </div>
        {busy === `${p.id}:${a.agent}` && <div className="spinner" />}
        <IconButton icon="more" label={`${title} seçenekleri`} onClick={onMenu} />
      </div>
      {!agentInstalled && (
        <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
          {title} kurulu değil. <a href="#/setup">Kurulum</a> sayfasından kur.
        </div>
      )}
      {agentInstalled && needsSetup && (
        <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
          İlk kez: giriş ve klasör güveni için bir kez terminalde aç, sonra başlat.{' '}
          <button className="btn btn-sm btn-ghost" onClick={onOpenCli}>
            <Icon name="terminal" size={14} /> Terminalde aç
          </button>
        </div>
      )}
      {a.url && (
        <a className="btn btn-primary" href={a.url} target="_blank" rel="noreferrer" style={{ justifyContent: 'flex-start', overflow: 'hidden', marginTop: 10, width: '100%' }}>
          <Icon name="link" size={16} />
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
            {a.url}
          </span>
        </a>
      )}
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {st && <Switch checked={st.enabled} onChange={onToggle} label="Termux açılınca başlat" disabled={busy !== null} />}
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={onLog}>
          <Icon name="list" size={16} /> Log
        </button>
        {up ? (
          <button className="btn btn-sm" disabled={busy !== null} onClick={onStop}>
            <Icon name="stop" size={16} /> Durdur
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={busy !== null || !p.exists || !agentInstalled} onClick={onStart}>
            <Icon name="play" size={16} /> Başlat
          </button>
        )}
      </div>
    </div>
  );
}

function EditSheet({
  title,
  a,
  defaultCommand,
  ttyAvailable,
  busy,
  onClose,
  onSave,
}: {
  title: string;
  a: ProjectAgent;
  defaultCommand: string;
  ttyAvailable: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (b: { command: string; tty: boolean }) => void;
}) {
  const [f, setF] = useState({ command: a.command, tty: a.tty });
  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !f.command.trim()} onClick={() => onSave(f)}>
          <Icon name="save" size={18} /> Kaydet{a.status?.state === 'run' ? ' ve yeniden başlat' : ''}
        </button>
      }
    >
      <div className="stack">
        <div>
          <label className="field-label">Komut</label>
          <input className="input mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder={defaultCommand} autoCapitalize="off" spellCheck={false} />
          {f.command !== defaultCommand && (
            <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setF({ ...f, command: defaultCommand })}>
              Varsayılana dön: <code>{defaultCommand}</code>
            </button>
          )}
        </div>
        <Switch checked={f.tty} onChange={(v) => setF({ ...f, tty: v })} label="Sahte terminal (TTY) ver: ajan etkileşimli terminal isterse açık kalsın" />
        {f.tty && !ttyAvailable && (
          <div className="faint" style={{ fontSize: 12.5 }}>
            TTY için <code>script</code> komutu gerekli: <code>pkg install util-linux</code>
          </div>
        )}
        <div className="faint mono" style={{ fontSize: 12 }}>
          servis: {a.service}
        </div>
      </div>
    </Sheet>
  );
}

function LogSheet({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const { toast } = useApp();
  const [log, setLog] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const load = useCallback(
    () =>
      api<{ log: string }>(`${url}/log`)
        .then((d) => setLog(d.log))
        .catch((e) => setLog(errMsg(e))),
    [url],
  );
  useEffect(() => {
    load();
  }, [load]);
  useInterval(load, 3000);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <Sheet
      open
      full
      onClose={onClose}
      title={`${title} · log`}
      footer={
        <button
          className="btn btn-ghost"
          onClick={() =>
            post(`${url}/clear-log`)
              .then(load)
              .catch((e) => toast(errMsg(e), 'err'))
          }
        >
          <Icon name="trash" size={16} /> Temizle
        </button>
      }
    >
      <pre ref={ref} className="job-output" style={{ maxHeight: '70vh', overflow: 'auto', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
        {log === null ? 'Yükleniyor…' : log || '(henüz çıktı yok)'}
      </pre>
    </Sheet>
  );
}
