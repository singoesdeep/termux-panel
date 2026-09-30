import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, fmtBytes, fmtDate, post, put, q, shq } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, SearchInput, Sheet, Spinner, useLongPress } from '../components/ui';
import { locate, useEnvs } from '../envs';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

interface Entry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  mode: string;
  target?: string;
}
interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
}
type Sort = 'name' | 'mtime' | 'size';

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const VID = /\.(mp4|webm|mkv|mov)$/i;
const AUD = /\.(mp3|ogg|wav|m4a|flac|opus)$/i;
const BIN = /\.(zip|gz|tgz|xz|bz2|7z|rar|deb|apk|so|o|a|bin|exe|jar|class|pyc|pdf|iso|img|db|sqlite)$/i;
const CODE = /\.(js|ts|tsx|jsx|py|sh|bash|zsh|json|ya?ml|toml|ini|conf|cfg|md|txt|html?|css|c|h|cpp|rs|go|java|kt|rb|php|lua|sql|env|log|xml|csv)$/i;

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const load = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* yok */
  }
};

function iconFor(e: Entry) {
  if (e.type === 'dir') return 'folder';
  if (e.type === 'link') return 'link';
  if (IMG.test(e.name)) return 'image';
  if (CODE.test(e.name)) return 'file-code';
  return 'file';
}

export default function Files({ params }: { params: URLSearchParams }) {
  const { toast, confirm, prompt, runJob } = useApp();
  const path = params.get('path') || load('tp-files-path', '~');
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(load('tp-files-hidden', '0') === '1');
  const [sort, setSort] = useState<Sort>((load('tp-files-sort', 'name') as Sort) || 'name');
  const [filter, setFilter] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [clip, setClip] = useState<{ mode: 'copy' | 'move'; paths: string[] } | null>(null);
  const [menu, setMenu] = useState<Entry | null>(null);
  const [editor, setEditor] = useState<{ path: string; content: string; original: string } | null>(null);
  const [preview, setPreview] = useState<{ path: string; kind: 'img' | 'video' | 'audio' } | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [places, setPlaces] = useState(false);
  const { info: envInfo, distros } = useEnvs();

  const go = useCallback((p: string) => {
    setSelected(null);
    setFilter('');
    navigate('files', { path: p });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<Listing>(`/api/fs/list?${q({ path })}`);
      setData(d);
      setErr('');
      store('tp-files-path', d.path);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const entries = useMemo(() => {
    if (!data) return [];
    let list = data.entries.filter((e) => hidden || !e.name.startsWith('.'));
    if (filter) list = list.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()));
    const dirFirst = (a: Entry, b: Entry) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
    return [...list].sort(
      (a, b) =>
        dirFirst(a, b) ||
        (sort === 'mtime' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, 'tr', { numeric: true })),
    );
  }, [data, hidden, filter, sort]);

  const cwd = data?.path ?? path;
  const full = (e: Entry) => join(cwd, e.name);
  // Bu klasör bir distronun içindeyse komutlar o distroda, içerideki yolla çalışır
  const inDistro = locate(cwd, distros);
  const openTerminalAt = (dir: string) => {
    const loc = locate(dir, distros);
    navigate('terminal', loc ? { env: loc.env, cwd: loc.inner } : { cwd: dir });
  };

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      refresh();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const openFile = async (e: Entry) => {
    const p = full(e);
    if (IMG.test(e.name)) return setPreview({ path: p, kind: 'img' });
    if (VID.test(e.name)) return setPreview({ path: p, kind: 'video' });
    if (AUD.test(e.name)) return setPreview({ path: p, kind: 'audio' });
    if (BIN.test(e.name)) return setMenu(e);
    try {
      const r = await api<{ content: string }>(`/api/fs/read?${q({ path: p })}`);
      setEditor({ path: p, content: r.content, original: r.content });
    } catch (err) {
      toast(errMsg(err), 'err');
      setMenu(e);
    }
  };

  const tap = (e: Entry) => {
    if (selected) {
      const s = new Set(selected);
      if (s.has(e.name)) s.delete(e.name);
      else s.add(e.name);
      setSelected(s.size ? s : null);
      return;
    }
    if (e.type === 'dir') go(full(e));
    else openFile(e);
  };

  const rename = async (e: Entry) => {
    const name = await prompt({ title: 'Yeniden adlandır', value: e.name, confirm: 'Kaydet' });
    if (name && name !== e.name) act(() => post('/api/fs/rename', { from: full(e), to: join(cwd, name) }), 'Adlandırıldı');
  };

  const remove = async (names: string[]) => {
    const ok = await confirm({
      title: names.length > 1 ? `${names.length} öğe silinsin mi?` : `"${names[0]}" silinsin mi?`,
      message: 'Bu işlem geri alınamaz. Klasörler içerikleriyle birlikte silinir.',
      confirm: 'Sil',
      danger: true,
    });
    if (ok) act(() => post('/api/fs/delete', { paths: names.map((n) => join(cwd, n)) }), 'Silindi');
    setSelected(null);
  };

  const pasteHere = async () => {
    if (!clip) return;
    try {
      for (const src of clip.paths) {
        const name = src.split('/').pop()!;
        let dest = join(cwd, name);
        if (clip.mode === 'copy' && src === dest) dest = join(cwd, `${name} (kopya)`);
        await post(clip.mode === 'copy' ? '/api/fs/copy' : '/api/fs/rename', { from: src, to: dest });
      }
      toast(clip.mode === 'copy' ? 'Kopyalandı' : 'Taşındı', 'ok');
      setClip(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
    refresh();
  };

  const doUpload = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/fs/upload?${q({ dir: cwd })}`);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && setUpload(Math.round((ev.loaded / ev.total) * 100));
    xhr.onload = () => {
      setUpload(null);
      if (xhr.status >= 200 && xhr.status < 300) toast(`${list.length} dosya yüklendi`, 'ok');
      else toast(`Yükleme başarısız: ${xhr.responseText}`, 'err');
      refresh();
    };
    xhr.onerror = () => {
      setUpload(null);
      toast('Yükleme başarısız', 'err');
    };
    setUpload(0);
    xhr.send(fd);
  };

  const download = (p: string) => {
    const a = document.createElement('a');
    a.href = `/api/fs/download?${q({ path: p })}`;
    a.download = p.split('/').pop() ?? 'dosya';
    a.click();
  };

  const runScript = (e: Entry) => {
    const p = inDistro ? join(inDistro.inner, e.name) : full(e);
    const py = inDistro ? 'python3' : 'python';
    const cmd = e.name.endsWith('.py') ? `${py} ${shq(p)}` : e.name.endsWith('.js') ? `node ${shq(p)}` : `bash ${shq(p)}`;
    runJob(post<JobMeta>('/api/run', inDistro ? { command: cmd, cwd: inDistro.inner, env: inDistro.env } : { command: cmd, cwd }));
  };

  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    parts.forEach((p, i) => out.push({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }));
    // Home altındaysak kökten başlamak yerine ~ göster
    if (data?.home && cwd.startsWith(data.home)) {
      const depth = data.home.split('/').filter(Boolean).length;
      return [{ label: '~', path: data.home }, ...out.slice(depth + 1)];
    }
    return out;
  }, [cwd, data?.home]);

  return (
    <div
      className={drag ? 'drop-hint' : ''}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        doUpload(e.dataTransfer.files);
      }}
    >
      <Header
        title={selected ? `${selected.size} seçili` : 'Dosyalar'}
        subtitle={!selected && inDistro ? `${inDistro.env} içinde: ${inDistro.inner}` : undefined}
        back={selected ? () => setSelected(null) : undefined}
        actions={
          selected ? (
            <>
              <IconButton icon="check" label="Tümünü seç" onClick={() => setSelected(new Set(entries.map((e) => e.name)))} />
            </>
          ) : (
            <>
              <IconButton icon="search" label="Filtrele" active={showFilter} onClick={() => setShowFilter((v) => !v)} />
              <IconButton
                icon={hidden ? 'eye' : 'eye-off'}
                label={hidden ? 'Gizlileri sakla' : 'Gizlileri göster'}
                onClick={() => {
                  setHidden(!hidden);
                  store('tp-files-hidden', hidden ? '0' : '1');
                }}
              />
              <IconButton icon="refresh" label="Yenile" onClick={refresh} />
            </>
          )
        }
      />
      <div className="content">
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="row" style={{ gap: 2 }}>
              {i > 0 && <span className="sep">/</span>}
              <button
                onClick={async () => {
                  if (i === crumbs.length - 1) {
                    const p = await prompt({ title: 'Konuma git', value: cwd, confirm: 'Git' });
                    if (p) go(p);
                  } else go(c.path);
                }}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>

        <div className="toolbar">
          <IconButton icon="corner-left-up" label="Üst klasör" disabled={!data?.parent} onClick={() => data?.parent && go(data.parent)} />
          <IconButton icon="bookmark" label="Konumlar" onClick={() => setPlaces(true)} />
          <IconButton icon="terminal" label="Burada terminal aç" onClick={() => openTerminalAt(cwd)} />
          <span className="spacer" />
          <select
            className="select"
            style={{ width: 'auto', minHeight: 38, padding: '0 10px', fontSize: 13 }}
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              store('tp-files-sort', e.target.value);
            }}
            aria-label="Sıralama"
          >
            <option value="name">Ad</option>
            <option value="mtime">Tarih</option>
            <option value="size">Boyut</option>
          </select>
          <IconButton
            icon="folder-plus"
            label="Yeni klasör"
            onClick={async () => {
              const n = await prompt({ title: 'Yeni klasör', placeholder: 'klasor-adi', confirm: 'Oluştur' });
              if (n) act(() => post('/api/fs/mkdir', { path: join(cwd, n) }));
            }}
          />
          <IconButton
            icon="file-plus"
            label="Yeni dosya"
            onClick={async () => {
              const n = await prompt({ title: 'Yeni dosya', placeholder: 'dosya.txt', confirm: 'Oluştur' });
              if (!n) return;
              try {
                await put('/api/fs/write', { path: join(cwd, n), content: '', create: true });
                refresh();
                setEditor({ path: join(cwd, n), content: '', original: '' });
              } catch (e) {
                toast(errMsg(e), 'err');
              }
            }}
          />
          <IconButton icon="upload" label="Yükle" onClick={() => fileInput.current?.click()} />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && doUpload(e.target.files)} />
        </div>

        {showFilter && (
          <div style={{ marginBottom: 10 }}>
            <SearchInput value={filter} onChange={setFilter} placeholder="Bu klasörde ara…" autoFocus />
          </div>
        )}

        {upload !== null && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="row">
              <Icon name="upload" size={16} /> Yükleniyor… <span className="spacer" /> <span className="num">%{upload}</span>
            </div>
            <div className="meter">
              <div style={{ width: `${upload}%` }} />
            </div>
          </div>
        )}

        {err ? (
          <Empty icon="alert" title="Klasör açılamadı">
            {err}
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => go('~')}>
                Home'a dön
              </button>
            </div>
          </Empty>
        ) : !data && loading ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <Empty icon="folder" title={filter ? 'Eşleşen öğe yok' : 'Klasör boş'}>
            {!filter && 'Yeni dosya/klasör oluşturabilir ya da dosya yükleyebilirsin.'}
          </Empty>
        ) : (
          <div className="list" style={{ marginBottom: clip || selected ? 80 : 0 }}>
            {entries.map((e) => (
              <Row
                key={e.name}
                e={e}
                selected={selected?.has(e.name) ?? false}
                onTap={() => tap(e)}
                onLong={() => (selected ? tap(e) : setMenu(e))}
                onMenu={() => setMenu(e)}
              />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="select-bar">
          <span className="spacer" />
          <IconButton
            icon="copy"
            label="Kopyala"
            onClick={() => {
              setClip({ mode: 'copy', paths: [...selected].map((n) => join(cwd, n)) });
              setSelected(null);
            }}
          />
          <IconButton
            icon="move"
            label="Taşı"
            onClick={() => {
              setClip({ mode: 'move', paths: [...selected].map((n) => join(cwd, n)) });
              setSelected(null);
            }}
          />
          <IconButton icon="trash" label="Sil" onClick={() => remove([...selected])} />
        </div>
      )}

      {clip && !selected && (
        <div className="paste-bar">
          <div className="list-main">
            <div className="list-title" style={{ fontSize: 14 }}>
              {clip.paths.length} öğe {clip.mode === 'copy' ? 'kopyalanacak' : 'taşınacak'}
            </div>
            <div className="list-sub">Hedef klasöre gidip yapıştır</div>
          </div>
          <button className="btn btn-sm" onClick={() => setClip(null)}>
            İptal
          </button>
          <button className="btn btn-sm btn-primary" onClick={pasteHere}>
            Buraya yapıştır
          </button>
        </div>
      )}

      {/* Öğe menüsü */}
      <Sheet open={!!menu} onClose={() => setMenu(null)} title={<span className="ellipsis">{menu?.name}</span>}>
        {menu && (
          <>
            <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
              {menu.type === 'dir' ? 'Klasör' : fmtBytes(menu.size)} · {fmtDate(menu.mtime)} · <span className="mono">{menu.mode}</span>
              {menu.target && <div className="mono ellipsis">→ {menu.target}</div>}
            </div>
            <div className="action-list">
              {menu.type === 'dir' ? (
                <>
                  <button onClick={() => (setMenu(null), go(full(menu)))}>
                    <Icon name="folder" /> Aç
                  </button>
                  {!inDistro && (
                    <button onClick={() => (setMenu(null), navigate('claude', { add: full(menu) }))}>
                      <Icon name="message" /> Claude projesi yap
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button onClick={() => (setMenu(null), openFile(menu))}>
                    <Icon name="edit" /> Aç / düzenle
                  </button>
                  <button onClick={() => (setMenu(null), download(full(menu)))}>
                    <Icon name="download" /> İndir
                  </button>
                  {/\.(sh|py|js)$/.test(menu.name) && (
                    <button onClick={() => (setMenu(null), runScript(menu))}>
                      <Icon name="play" /> Çalıştır
                    </button>
                  )}
                </>
              )}
              <button
                onClick={() => {
                  setMenu(null);
                  openTerminalAt(menu.type === 'dir' ? full(menu) : cwd);
                }}
              >
                <Icon name="terminal" /> Burada terminal aç{inDistro && ` (${inDistro.env})`}
              </button>
              <button onClick={() => (setMenu(null), rename(menu))}>
                <Icon name="edit" /> Yeniden adlandır
              </button>
              <button onClick={() => (setMenu(null), setClip({ mode: 'copy', paths: [full(menu)] }))}>
                <Icon name="copy" /> Kopyala
              </button>
              <button onClick={() => (setMenu(null), setClip({ mode: 'move', paths: [full(menu)] }))}>
                <Icon name="move" /> Taşı
              </button>
              <button
                onClick={async () => {
                  setMenu(null);
                  const m = await prompt({ title: 'İzinler (chmod)', label: `Şu an: ${menu.mode}`, placeholder: '755', value: modeToOctal(menu.mode), confirm: 'Uygula' });
                  if (m) act(() => post('/api/fs/chmod', { path: full(menu), mode: m }), 'İzinler güncellendi');
                }}
              >
                <Icon name="lock" /> İzinler
              </button>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(full(menu)).then(() => toast('Yol kopyalandı', 'ok'));
                  setMenu(null);
                }}
              >
                <Icon name="clipboard" /> Yolu kopyala
              </button>
              <button onClick={() => (setMenu(null), setSelected(new Set([menu.name])))}>
                <Icon name="check" /> Seç
              </button>
              <button className="danger" onClick={() => (setMenu(null), remove([menu.name]))}>
                <Icon name="trash" /> Sil
              </button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={places} onClose={() => setPlaces(false)} title="Konumlar">
        <div className="action-list">
          {[
            { icon: 'home', label: 'Termux home', sub: data?.home ?? '~', path: '~' },
            { icon: 'phone', label: 'Dahili depolama', sub: '/storage/emulated/0', path: '/storage/emulated/0' },
            ...(envInfo?.binds ?? []).map((b) => ({ icon: 'folder', label: 'Ortak proje klasörü', sub: `${b.src} → distrolarda ${b.dst}`, path: b.src })),
            ...distros.flatMap((d) => [
              { icon: 'box', label: `${d.name}: /root`, sub: d.os ?? '', path: `${d.rootfs}/root` },
              { icon: 'box', label: `${d.name}: / (kök)`, sub: 'Distronun tüm dosya sistemi', path: d.rootfs },
            ]),
          ].map((pl) => (
            <button key={pl.path} onClick={() => (setPlaces(false), go(pl.path))}>
              <Icon name={pl.icon} />
              <div className="list-main">
                <div className="list-title">{pl.label}</div>
                <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                  {pl.sub}
                </div>
              </div>
            </button>
          ))}
        </div>
      </Sheet>

      {editor && <Editor editor={editor} setEditor={setEditor} onSaved={refresh} />}

      <Sheet
        open={!!preview}
        onClose={() => setPreview(null)}
        title={<span className="ellipsis">{preview?.path.split('/').pop()}</span>}
        footer={
          <button className="btn" onClick={() => preview && download(preview.path)}>
            <Icon name="download" size={18} /> İndir
          </button>
        }
      >
        {preview?.kind === 'img' && <img className="preview-img" src={`/api/fs/download?${q({ path: preview.path, inline: '1' })}`} alt="" />}
        {preview?.kind === 'video' && <video className="preview-img" controls src={`/api/fs/download?${q({ path: preview.path, inline: '1' })}`} />}
        {preview?.kind === 'audio' && <audio style={{ width: '100%' }} controls src={`/api/fs/download?${q({ path: preview.path, inline: '1' })}`} />}
      </Sheet>
    </div>
  );
}

function Row({ e, selected, onTap, onLong, onMenu }: { e: Entry; selected: boolean; onTap: () => void; onLong: () => void; onMenu: () => void }) {
  const { fired, handlers } = useLongPress(onLong);
  return (
    <div
      className={`list-item pressable ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      {...handlers}
      onClick={() => {
        if (!fired.current) onTap();
      }}
      onKeyDown={(ev) => ev.key === 'Enter' && onTap()}
    >
      <span className={`list-ico ${e.type === 'dir' ? 'folder' : ''}`}>
        <Icon name={selected ? 'check' : iconFor(e)} size={20} />
      </span>
      <div className="list-main">
        <div className="list-title">{e.name}</div>
        <div className="list-sub">
          {e.type === 'dir' ? fmtDate(e.mtime) : `${fmtBytes(e.size)} · ${fmtDate(e.mtime)}`}
          {e.target && ` → ${e.target}`}
        </div>
      </div>
      <button
        className="icon-btn"
        aria-label="Seçenekler"
        onClick={(ev) => {
          ev.stopPropagation();
          onMenu();
        }}
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        <Icon name="more" />
      </button>
    </div>
  );
}

function modeToOctal(mode: string) {
  let out = '';
  for (let i = 0; i < 9; i += 3) {
    const [r, w, x] = mode.slice(i, i + 3);
    out += String((r === 'r' ? 4 : 0) + (w === 'w' ? 2 : 0) + (x === 'x' ? 1 : 0));
  }
  return out;
}

function Editor({
  editor,
  setEditor,
  onSaved,
}: {
  editor: { path: string; content: string; original: string };
  setEditor: (e: { path: string; content: string; original: string } | null) => void;
  onSaved: () => void;
}) {
  const { toast, confirm } = useApp();
  const [saving, setSaving] = useState(false);
  const dirty = editor.content !== editor.original;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await put('/api/fs/write', { path: editor.path, content: editor.content });
      setEditor({ ...editor, original: editor.content });
      toast('Kaydedildi', 'ok');
      onSaved();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setSaving(false);
    }
  }, [editor, setEditor, toast, onSaved]);

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Kaydedilmemiş değişiklikler', message: 'Kaydetmeden kapatılsın mı?', confirm: 'Kapat', danger: true }))) return;
    setEditor(null);
  };

  return (
    <Sheet
      open
      full
      onClose={close}
      title={
        <div className="list-main">
          <div className="list-title">
            {editor.path.split('/').pop()}
            {dirty && ' •'}
          </div>
          <div className="list-sub mono" style={{ fontSize: 11.5 }}>
            {editor.path}
          </div>
        </div>
      }
      footer={
        <>
          <button className="btn" onClick={close}>
            Kapat
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            <Icon name="save" size={18} /> {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </>
      }
    >
      <textarea
        className="editor"
        value={editor.content}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => setEditor({ ...editor, content: e.target.value })}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (dirty) save();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: s, selectionEnd: en } = t;
            const v = t.value.slice(0, s) + '  ' + t.value.slice(en);
            setEditor({ ...editor, content: v });
            requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
          }
        }}
      />
    </Sheet>
  );
}
