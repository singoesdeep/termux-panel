import { useEffect, useState } from 'react';
import { api, errMsg, post, put } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, IconButton, Sheet, Spinner } from '../components/ui';
import { EnvPicker, useEnvs } from '../envs';
import { navigate } from '../router';
import { useApp, type JobMeta } from '../store';

interface Snippet {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: string;
}

export default function Shortcuts() {
  const { runJob, toast, confirm } = useApp();
  const [list, setList] = useState<Snippet[] | null>(null);
  const [edit, setEdit] = useState<Snippet | null>(null);
  const [quick, setQuick] = useState('');
  const [quickEnv, setQuickEnv] = useState('termux');
  const { distros } = useEnvs();

  useEffect(() => {
    api<{ snippets: Snippet[] }>('/api/snippets')
      .then((r) => setList(r.snippets))
      .catch((e) => toast(errMsg(e), 'err'));
  }, [toast]);

  const saveAll = async (next: Snippet[]) => {
    try {
      const r = await put<{ snippets: Snippet[] }>('/api/snippets', { snippets: next });
      setList(r.snippets);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const move = (i: number, d: number) => {
    if (!list) return;
    const next = [...list];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it);
    saveAll(next);
  };

  return (
    <>
      <Header
        title="Kısayollar"
        subtitle="Sık kullandığın komutlar"
        actions={<IconButton icon="plus" label="Yeni kısayol" onClick={() => setEdit({ id: '', name: '', command: '' })} />}
      />
      <div className="content stack">
        <EnvPicker value={quickEnv} onChange={setQuickEnv} />
        <form
          className="card row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!quick.trim()) return;
            runJob(post<JobMeta>('/api/run', { command: quick, ...(quickEnv !== 'termux' ? { env: quickEnv } : {}) }));
          }}
        >
          <input
            className="input mono"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Tek seferlik komut çalıştır…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={!quick.trim()} aria-label="Çalıştır">
            <Icon name="play" size={18} />
          </button>
        </form>

        {!list && <Spinner />}
        {list?.length === 0 && <Empty icon="zap" title="Henüz kısayol yok">Sağ üstteki + ile ekle.</Empty>}
        {list && list.length > 0 && (
          <div className="list">
            {list.map((s, i) => (
              <div key={s.id} className="list-item">
                <button className="list-ico folder" style={{ border: 0 }} onClick={() => runJob(post<JobMeta>(`/api/snippets/${s.id}/run`))} aria-label={`${s.name} çalıştır`}>
                  <Icon name="play" size={18} />
                </button>
                <button className="list-main" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left' }} onClick={() => setEdit(s)}>
                  <div className="list-title">
                    {s.name}
                    {s.env && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        <Icon name="box" size={11} /> {s.env}
                      </span>
                    )}
                  </div>
                  <div className="list-sub mono" style={{ fontSize: 11.5 }}>
                    {s.command}
                  </div>
                </button>
                <IconButton
                  icon="terminal"
                  label="Terminalde çalıştır"
                  onClick={() =>
                    navigate('terminal', {
                      // Komut bitince kabuk açık kalsın
                      cmd: `${s.command}; exec "\${SHELL:-/bin/sh}" -l`,
                      ...(s.cwd ? { cwd: s.cwd } : {}),
                      ...(s.env ? { env: s.env } : {}),
                    })
                  }
                />
                <div className="stack" style={{ gap: 0 }}>
                  <button className="icon-btn" style={{ height: 22 }} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Yukarı taşı">
                    <Icon name="chevron-up" size={16} />
                  </button>
                  <button className="icon-btn" style={{ height: 22 }} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Aşağı taşı">
                    <Icon name="chevron-down" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Sheet
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Kısayolu düzenle' : 'Yeni kısayol'}
        footer={
          <>
            {edit?.id && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (!list || !edit) return;
                  if (await confirm({ title: `"${edit.name}" silinsin mi?`, confirm: 'Sil', danger: true })) {
                    saveAll(list.filter((x) => x.id !== edit.id));
                    setEdit(null);
                  }
                }}
              >
                <Icon name="trash" size={18} />
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={!edit?.command.trim()}
              onClick={() => {
                if (!edit || !list) return;
                const next = edit.id ? list.map((x) => (x.id === edit.id ? edit : x)) : [...list, edit];
                saveAll(next);
                setEdit(null);
              }}
            >
              Kaydet
            </button>
          </>
        }
      >
        {edit && (
          <div className="stack">
            <div>
              <label className="field-label">Ad</label>
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Botu başlat" />
            </div>
            <div>
              <label className="field-label">Komut</label>
              <textarea
                className="input mono"
                rows={4}
                value={edit.command}
                onChange={(e) => setEdit({ ...edit, command: e.target.value })}
                placeholder="cd ~/bot && python bot.py"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {distros.length > 0 && (
              <div>
                <label className="field-label">Ortam</label>
                <EnvPicker value={edit.env ?? 'termux'} onChange={(v) => setEdit({ ...edit, env: v === 'termux' ? undefined : v })} />
              </div>
            )}
            <div>
              <label className="field-label">Çalışma klasörü (isteğe bağlı{edit.env ? `, ${edit.env} içindeki yol` : ''})</label>
              <input
                className="input mono"
                value={edit.cwd ?? ''}
                onChange={(e) => setEdit({ ...edit, cwd: e.target.value || undefined })}
                placeholder="~/projem"
                autoCapitalize="off"
              />
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
