import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, post } from '../api';
import { Icon } from '../components/Icon';
import { Header, IconButton, Spinner } from '../components/ui';
import { refreshEnvs } from '../envs';
import { useApp, type JobMeta } from '../store';

export interface SetupItem {
  id: string;
  group: 'termux' | 'ai' | 'linux';
  title: string;
  desc: string;
  status: 'ok' | 'missing' | 'warn' | 'blocked';
  detail?: string;
  actionLabel?: string;
  hasAction: boolean;
  inBulk?: boolean;
  help?: string;
}
export interface SetupInfo {
  isTermux: boolean;
  pdAvailable: boolean;
  items: SetupItem[];
}

const STATUS: Record<SetupItem['status'], { label: string; icon: string; cls: string }> = {
  ok: { label: 'Hazır', icon: 'check', cls: 'badge-good' },
  missing: { label: 'Eksik', icon: 'minus', cls: 'badge-bad' },
  warn: { label: 'Dikkat', icon: 'alert', cls: 'badge-warn' },
  blocked: { label: 'Sırada', icon: 'lock', cls: '' },
};

/** Toplu kurulumda yapılacak adımlar (sunucudaki mantıkla aynı) */
export const bulkTodo = (items: SetupItem[]) => items.filter((i) => i.inBulk && i.status !== 'ok' && i.hasAction);

export default function Setup() {
  const { runJob, confirm, toast } = useApp();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(
    () =>
      api<SetupInfo>('/api/setup')
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

  const afterJob = (j: JobMeta) => {
    if (j.status === 'failed') toast(`Kurulum başarısız (çıkış kodu ${j.code ?? '-'}). Ayrıntı için İşler sayfasındaki çıktıya bak.`, 'err');
    else if (j.status === 'killed') toast('Kurulum durduruldu', 'err');
    else toast('Kurulum tamamlandı', 'ok');
    load();
    refreshEnvs().catch(() => {});
  };

  if (err) return <div className="content">{err}</div>;
  if (!info) return <Spinner label="Kontrol ediliyor…" />;

  const todo = bulkTodo(info.items);
  const ready = info.items.filter((i) => i.status === 'ok').length;

  const section = (group: SetupItem['group'], title: string) => (
    <>
      <div className="section-title">{title}</div>
      <div className="stack">
        {info.items
          .filter((i) => i.group === group)
          .map((i) => {
            const st = STATUS[i.status];
            return (
              <div key={i.id} className="card">
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="list-main">
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 650 }}>{i.title}</span>
                      <span className={`badge ${st.cls}`}>
                        <Icon name={st.icon} size={12} /> {st.label}
                      </span>
                    </div>
                    <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
                      {i.desc}
                    </div>
                    {i.detail && (
                      <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
                        {i.detail}
                      </div>
                    )}
                    {i.help && (
                      <details style={{ marginTop: 8 }} open={i.status !== 'ok'}>
                        <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>Nasıl yapılır?</summary>
                        <pre className="job-output" style={{ marginTop: 8, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
                          {i.help}
                        </pre>
                      </details>
                    )}
                  </div>
                  {i.hasAction && i.status !== 'ok' && (
                    <button
                      className={`btn btn-sm ${i.status === 'blocked' ? '' : 'btn-primary'}`}
                      disabled={i.status === 'blocked' || !info.isTermux}
                      onClick={() => runJob(post<JobMeta>(`/api/setup/${i.id}`), afterJob)}
                    >
                      {i.actionLabel ?? 'Kur'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </>
  );

  return (
    <>
      <Header title="Kurulum" subtitle={`${ready}/${info.items.length} bileşen hazır`} actions={<IconButton icon="refresh" label="Yeniden kontrol et" onClick={load} />} />
      <div className="content">
        {!info.isTermux && (
          <div className="callout" style={{ marginBottom: 12 }}>
            <Icon name="alert" />
            <span>Panel şu an Termux'un kendisinde çalışmıyor (ör. bir proot içinde). Kurulum adımları yalnızca Termux'ta çalışırken yapılabilir.</span>
          </div>
        )}
        <div className="card">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="list-main">
              <div style={{ fontWeight: 650 }}>{todo.length ? `${todo.length} adım eksik` : 'Her şey hazır'}</div>
              <div className="muted" style={{ fontSize: 13.5 }}>
                {todo.length
                  ? todo.map((t) => t.title).join(' → ')
                  : 'Termux temel bileşenleri hazır.'}
              </div>
            </div>
            {todo.length > 0 && (
              <button
                className="btn btn-primary"
                disabled={!info.isTermux}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Eksikler kurulsun mu?',
                    message: `Sırayla: ${todo.map((t) => t.title).join(', ')}. İnternet hızına göre birkaç dakika sürebilir; ilerlemeyi canlı görebilirsin.`,
                    confirm: 'Kur',
                  });
                  if (ok) runJob(post<JobMeta>('/api/setup/all'), afterJob);
                }}
              >
                <Icon name="download" size={18} /> Eksikleri kur
              </button>
            )}
          </div>
        </div>
        {section('termux', 'Termux')}
        {section('ai', 'AI araçları (istediğini kur)')}
        {section('linux', 'Linux dağıtımları (isteğe bağlı)')}
        <div className="faint" style={{ fontSize: 12.5, margin: '16px 4px' }}>
          Depolama izni, node-pty ve otomatik başlatma toplu kuruluma dahil değildir: ilki telefonda onay ister, diğer ikisi paneli yeniden başlatmayı
          gerektirir. AI araçları (Claude Code, Antigravity) ve proot-distro isteğe bağlıdır; istediğini kendi düğmesiyle kur. Hepsi doğrudan Termux'ta
          çalışır.
        </div>
      </div>
    </>
  );
}
