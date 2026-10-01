import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, post } from '../api';
import { useApp } from '../store';
import { Icon } from './Icon';
import { Sheet, Spinner } from './ui';

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; type: 'dir' | 'file' | 'link' | 'other' }[];
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/**
 * Dosya yöneticisi gibi klasör seçici: klasörler arasında gezin, gerekirse yeni klasör
 * oluştur, bulunduğun klasörü seç. `reject` seçilemeyecek klasörler için bir neden döndürür.
 */
export function FolderPicker({
  open,
  start = '~',
  title = 'Klasör seç',
  confirmLabel = 'Bu klasörü seç',
  reject,
  onPick,
  onClose,
}: {
  open: boolean;
  start?: string;
  title?: string;
  confirmLabel?: string;
  reject?: (path: string, home: string) => string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { toast, prompt } = useApp();
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);

  const go = useCallback(
    (p: string) => {
      setLoading(true);
      api<Listing>(`/api/fs/list?path=${encodeURIComponent(p)}`)
        .then(setData)
        .catch((e) => toast(errMsg(e), 'err'))
        .finally(() => setLoading(false));
    },
    [toast],
  );

  useEffect(() => {
    if (open) go(start);
  }, [open, start, go]);

  const newFolder = async () => {
    if (!data) return;
    const name = (await prompt({ title: 'Yeni klasör', label: `${tilde(data.path, data.home)} içinde`, placeholder: 'ör. blog', confirm: 'Oluştur' }))?.trim();
    if (!name) return;
    if (name.includes('/') || name === '.' || name === '..') return toast('Klasör adı / içeremez', 'err');
    const p = join(data.path, name);
    try {
      await post('/api/fs/mkdir', { path: p });
      go(p);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const why = data && reject ? reject(data.path, data.home) : null;
  // Gizli klasörler ve dosyalar listelenmez; bağlantılar (ör. ~/storage/shared) klasör olabilir
  const dirs = (data?.entries ?? []).filter((e) => (e.type === 'dir' || e.type === 'link') && !e.name.startsWith('.'));

  return (
    <Sheet
      open={open}
      full
      onClose={onClose}
      title={title}
      footer={
        <div className="stack" style={{ width: '100%', gap: 6 }}>
          {why && (
            <div className="faint" style={{ fontSize: 12.5 }}>
              {why}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={newFolder} disabled={!data}>
              <Icon name="folder-plus" size={18} /> Yeni klasör
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={!data || Boolean(why)} onClick={() => data && onPick(data.path)}>
              <Icon name="check" size={18} /> {confirmLabel}
            </button>
          </div>
        </div>
      }
    >
      {!data ? (
        <Spinner />
      ) : (
        <>
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            <button className="icon-btn" aria-label="Üst klasör" disabled={!data.parent || loading} onClick={() => data.parent && go(data.parent)}>
              <Icon name="arrow-up" />
            </button>
            <button className="icon-btn" aria-label="Ana klasör" disabled={loading} onClick={() => go('~')}>
              <Icon name="home" />
            </button>
            <div className="list-main mono" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
              {tilde(data.path, data.home)}
            </div>
            {loading && <div className="spinner" />}
          </div>
          <div className="list">
            {dirs.length === 0 && (
              <div className="faint" style={{ padding: 16, fontSize: 13.5 }}>
                Bu klasörde alt klasör yok. Burayı seçebilir ya da <b>Yeni klasör</b> oluşturabilirsin.
              </div>
            )}
            {dirs.map((e) => (
              <div key={e.name} className="list-item pressable" role="button" tabIndex={0} onClick={() => go(join(data.path, e.name))} onKeyDown={(ev) => ev.key === 'Enter' && go(join(data.path, e.name))}>
                <span className="list-ico folder">
                  <Icon name="folder" size={20} />
                </span>
                <div className="list-main">
                  <div className="list-title">{e.name}</div>
                </div>
                <Icon name="chevron-right" size={16} />
              </div>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

export const tilde = (p: string, home: string) => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
