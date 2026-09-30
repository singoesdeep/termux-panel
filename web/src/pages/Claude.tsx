import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, errMsg, fmtDuration, post, put, shq } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, Sheet, Spinner, Switch, useInterval } from '../components/ui';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

interface SvStatus {
  state: string;
  pid: number | null;
  seconds: number | null;
  enabled: boolean;
}
interface Project {
  id: string;
  name: string;
  path: string;
  command: string;
  tty: boolean;
  service: string;
  exists: boolean;
  trusted: boolean;
  status: SvStatus | null;
  url: string | null;
}
interface ClaudeInfo {
  svAvailable: boolean;
  claude: { installed: boolean; npm: boolean; version: string | null; loggedIn: boolean };
  projects: Project[];
  legacy: boolean;
  home: string;
  tty: boolean;
  wakeLock: boolean;
  phantom: { status: 'ok' | 'warn'; detail: string };
}

type Form = { mode: 'new' | 'existing'; name: string; path: string; start: boolean; pathTouched: boolean };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9ğüşıöç._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

export default function Claude({ params }: { params: URLSearchParams }) {
  const { toast, confirm, runJob } = useApp();
  const [info, setInfo] = useState<ClaudeInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [edit, setEdit] = useState<Project | null>(null);
  const [menu, setMenu] = useState<Project | null>(null);
  const [logOf, setLogOf] = useState<Project | null>(null);

  const load = useCallback(
    () =>
      api<ClaudeInfo>('/api/claude')
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
  useInterval(load, info?.projects.some((p) => p.status) ? 4000 : null);

  // Dosyalar → "Claude projesi yap" ile gelindiğinde: #/claude?add=/yol
  const add = params.get('add');
  useEffect(() => {
    if (!add) return;
    navigate('claude', undefined, true);
    setForm({ mode: 'existing', name: add.split('/').filter(Boolean).pop() ?? '', path: add, start: true, pathTouched: true });
  }, [add]);

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

  const header = (
    <Header
      title="Claude"
      subtitle={info.claude.version ? `Claude Code ${info.claude.version} · her projeye ayrı claude rc` : 'Remote Control (claude rc) projeleri'}
      actions={<IconButton icon="refresh" label="Yenile" onClick={load} />}
    />
  );

  if (!info.claude.installed)
    return (
      <>
        {header}
        <div className="content">
          <Empty icon="message" title="Claude Code kurulu değil">
            {info.claude.npm
              ? 'Eski bir npm kurulumu bulundu. Kurulum sayfasındaki adım, taşıma (migrate.sh) komutlarını gösterir.'
              : "Claude Code doğrudan Termux'a kurulur (claude-code-android). Kurulum sayfasından tek dokunuşla kurabilirsin."}
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
            Her projenin <code>claude rc</code>'si panelden bağımsız, sürekli çalışan bir servis olarak kurulur. Bunun için <code>termux-services</code> paketi
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
  const openNew = () => setForm({ mode: 'new', name: '', path: '~/', start: true, pathTouched: false });
  const openExisting = () => setForm({ mode: 'existing', name: '', path: '~/', start: true, pathTouched: false });

  const submit = async () => {
    if (!form) return;
    const ok = await act(
      'form',
      () => post('/api/claude/projects', { name: form.name, path: form.path, create: form.mode === 'new', start: form.start }),
      form.start ? 'Proje eklendi, claude rc başlatıldı' : 'Proje eklendi',
    );
    if (ok) setForm(null);
  };

  const svc = (p: Project, a: string, ok?: string) => act(p.id, () => post(`/api/claude/projects/${p.id}/${a}`), ok);

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

        {!info.claude.loggedIn && (
          <div className="callout">
            <Icon name="info" />
            <span>
              Henüz Claude'a giriş yapılmamış görünüyor. Projeleri başlatmadan önce terminalde bir kez <code>claude</code> çalıştırıp giriş yap.{' '}
              <button className="btn btn-sm" onClick={() => navigate('terminal', { cmd: 'claude' })}>
                <Icon name="terminal" size={16} /> Terminalde aç
              </button>
            </span>
          </div>
        )}

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
                    act('legacy', () => del('/api/claude/legacy'), 'Eski servis kaldırıldı');
                }}
              >
                <Icon name="trash" size={16} /> Kaldır
              </button>
            </span>
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-primary" onClick={openNew}>
            <Icon name="folder-plus" size={18} /> Yeni proje
          </button>
          <button className="btn" onClick={openExisting}>
            <Icon name="folder" size={18} /> Var olan klasör
          </button>
        </div>

        {info.projects.length === 0 ? (
          <Empty icon="folder" title="Henüz proje yok">
            Her proje Termux'ta bir klasör ve ona bağlı ayrı bir <code>claude rc</code> oturumudur. Claude yalnızca o klasörde çalışır; diğer projelerini görmez.
            Dosyalar sayfasında bir klasörün menüsündeki <b>Claude projesi yap</b> ile de ekleyebilirsin.
          </Empty>
        ) : (
          info.projects.map((p) => {
            const st = p.status;
            const up = st?.state === 'run';
            const loading = busy === p.id;
            return (
              <div key={p.id} className="card">
                <div className="row">
                  <span className={`badge ${up ? 'badge-good' : ''}`}>
                    <Icon name={up ? 'play' : 'stop'} size={11} />
                    {up ? 'Çalışıyor' : st?.state === 'down' || !st ? 'Durdu' : st.state}
                  </span>
                  <div className="list-main">
                    <div className="list-title">{p.name}</div>
                    <div className="list-sub mono" style={{ fontSize: 12 }}>
                      {tilde(p.path)}
                      {up && st?.seconds != null ? ` · ${fmtDuration(st.seconds)}` : ''}
                    </div>
                  </div>
                  {loading && <div className="spinner" />}
                  <IconButton icon="more" label="Seçenekler" onClick={() => setMenu(p)} />
                </div>
                {!p.exists && (
                  <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                    Klasör bulunamadı. Silinmiş ya da taşınmış olabilir.
                  </div>
                )}
                {p.url && (
                  <a className="btn btn-primary" href={p.url} target="_blank" rel="noreferrer" style={{ justifyContent: 'flex-start', overflow: 'hidden', marginTop: 10, width: '100%' }}>
                    <Icon name="link" size={16} />
                    <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                      {p.url}
                    </span>
                  </a>
                )}
                <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  {st && (
                    <Switch
                      checked={st.enabled}
                      onChange={(v) => act(p.id, () => post(`/api/services/${p.service}/${v ? 'enable' : 'disable'}`))}
                      label="Termux açılınca başlat"
                      disabled={busy !== null}
                    />
                  )}
                  <span className="spacer" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setLogOf(p)}>
                    <Icon name="list" size={16} /> Log
                  </button>
                  {up ? (
                    <button className="btn btn-sm" disabled={busy !== null} onClick={() => svc(p, 'down')}>
                      <Icon name="stop" size={16} /> Durdur
                    </button>
                  ) : (
                    <button className="btn btn-sm btn-primary" disabled={busy !== null || !p.exists} onClick={() => svc(p, 'up')}>
                      <Icon name="play" size={16} /> Başlat
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Proje ekle */}
      <Sheet
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.mode === 'new' ? 'Yeni proje' : 'Var olan klasörü ekle'}
        footer={
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy !== null || !form?.path.trim() || (form.mode === 'new' && !form.name.trim())} onClick={submit}>
            <Icon name="plus" size={18} /> {form?.mode === 'new' ? 'Oluştur' : 'Ekle'}
          </button>
        }
      >
        {form && (
          <div className="stack">
            <div>
              <label className="field-label">Proje adı</label>
              <input
                className="input"
                value={form.name}
                autoFocus
                placeholder="ör. blog"
                onChange={(e) => {
                  const name = e.target.value;
                  // Yeni projede klasör, elle değiştirilmediyse addan türetilir
                  setForm({ ...form, name, path: form.mode === 'new' && !form.pathTouched ? `~/${slugify(name)}` : form.path });
                }}
              />
            </div>
            <div>
              <label className="field-label">{form.mode === 'new' ? 'Oluşturulacak klasör' : 'Klasör'}</label>
              <input
                className="input mono"
                value={form.path}
                placeholder="~/proje"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setForm({ ...form, path: e.target.value, pathTouched: true })}
              />
              <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                Claude yalnızca bu klasörde çalışır. Home klasörünün kendisi proje olamaz. Klasöre güven onayı otomatik verilir.
              </div>
            </div>
            <Switch checked={form.start} onChange={(v) => setForm({ ...form, start: v })} label="claude rc'yi hemen başlat (Termux açılınca da başlar)" />
          </div>
        )}
      </Sheet>

      {/* Proje menüsü */}
      <Sheet open={menu !== null} onClose={() => setMenu(null)} title={menu?.name}>
        {menu && (
          <div className="action-list">
            {menu.status?.state === 'run' && (
              <button onClick={() => (setMenu(null), svc(menu, 'restart', 'Yeniden başlatıldı'))}>
                <Icon name="restart" /> Yeniden başlat
              </button>
            )}
            <button onClick={() => (setMenu(null), navigate('terminal', { cmd: `cd ${shq(menu.path)} && claude` }))}>
              <Icon name="terminal" /> Terminalde claude aç
            </button>
            <button onClick={() => (setMenu(null), navigate('terminal', { cwd: menu.path }))}>
              <Icon name="terminal" /> Burada terminal aç
            </button>
            <button onClick={() => (setMenu(null), navigate('files', { path: menu.path }))}>
              <Icon name="folder" /> Dosyalarda aç
            </button>
            <button onClick={() => (setMenu(null), setEdit(menu))}>
              <Icon name="edit" /> Ayarlar
            </button>
            {!menu.trusted && (
              <button onClick={() => (setMenu(null), svc(menu, 'trust', 'Klasöre güven onayı verildi'))}>
                <Icon name="check" /> Klasöre güven
              </button>
            )}
            <button
              className="danger"
              onClick={async () => {
                const p = menu;
                setMenu(null);
                if (
                  await confirm({
                    title: `${p.name} kaldırılsın mı?`,
                    message: `claude rc durdurulur ve proje listeden çıkar. ${tilde(p.path)} klasörüne dokunulmaz.`,
                    confirm: 'Kaldır',
                    danger: true,
                  })
                )
                  act(p.id, () => del(`/api/claude/projects/${p.id}`), 'Proje kaldırıldı');
              }}
            >
              <Icon name="trash" /> Projeyi kaldır
            </button>
          </div>
        )}
      </Sheet>

      {edit && (
        <EditSheet
          project={edit}
          ttyAvailable={info.tty}
          busy={busy !== null}
          onClose={() => setEdit(null)}
          onSave={async (b) => {
            if (await act(edit.id, () => put(`/api/claude/projects/${edit.id}`, b), 'Kaydedildi')) setEdit(null);
          }}
        />
      )}
      {logOf && <LogSheet project={logOf} onClose={() => setLogOf(null)} />}
    </>
  );
}

function EditSheet({
  project,
  ttyAvailable,
  busy,
  onClose,
  onSave,
}: {
  project: Project;
  ttyAvailable: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (b: { name: string; command: string; tty: boolean }) => void;
}) {
  const [f, setF] = useState({ name: project.name, command: project.command, tty: project.tty });
  return (
    <Sheet
      open
      onClose={onClose}
      title={`${project.name} · ayarlar`}
      footer={
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !f.command.trim()} onClick={() => onSave(f)}>
          <Icon name="save" size={18} /> Kaydet{project.status?.state === 'run' ? ' ve yeniden başlat' : ''}
        </button>
      }
    >
      <div className="stack">
        <div>
          <label className="field-label">Proje adı</label>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div>
          <label className="field-label">Komut</label>
          <input className="input mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="claude rc" autoCapitalize="off" spellCheck={false} />
        </div>
        <Switch checked={f.tty} onChange={(v) => setF({ ...f, tty: v })} label="Sahte terminal (TTY) ver: claude etkileşimli terminal isterse açık kalsın" />
        {f.tty && !ttyAvailable && (
          <div className="faint" style={{ fontSize: 12.5 }}>
            TTY için <code>script</code> komutu gerekli: <code>pkg install util-linux</code>
          </div>
        )}
        <div className="faint mono" style={{ fontSize: 12 }}>
          {project.path} · servis: {project.service}
        </div>
      </div>
    </Sheet>
  );
}

function LogSheet({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast } = useApp();
  const [log, setLog] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const load = useCallback(
    () =>
      api<{ log: string }>(`/api/claude/projects/${project.id}/log`)
        .then((d) => setLog(d.log))
        .catch((e) => setLog(errMsg(e))),
    [project.id],
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
      title={`${project.name} · log`}
      footer={
        <button
          className="btn btn-ghost"
          onClick={() =>
            post(`/api/claude/projects/${project.id}/clear-log`)
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
