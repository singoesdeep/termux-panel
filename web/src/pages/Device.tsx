import { useEffect, useState } from 'react';
import { api, errMsg, post } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Header, Sheet, Spinner } from '../components/ui';
import { useApp, type JobMeta } from '../store';

export default function Device() {
  const { toast, prompt, runJob } = useApp();
  const [avail, setAvail] = useState<boolean | null>(null);
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; data: unknown } | null>(null);

  useEffect(() => {
    api<{ available: boolean }>('/api/device')
      .then((r) => setAvail(r.available))
      .catch(() => setAvail(false));
  }, []);

  const call = async (action: string, body: Record<string, unknown> = {}, show?: string) => {
    setBusy(action);
    try {
      const r = await post<{ result: unknown }>(`/api/device/${action}`, body);
      if (show) setResult({ title: show, data: r.result });
      else toast('Tamam', 'ok');
      return r.result;
    } catch (e) {
      toast(errMsg(e), 'err');
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  if (avail === null) return <Spinner />;

  const tiles: { id: string; icon: string; label: string; run: () => void; on?: boolean }[] = [
    { id: 'battery', icon: 'battery', label: 'Pil durumu', run: () => call('battery', {}, 'Pil') },
    { id: 'wifi', icon: 'wifi', label: 'Wi-Fi bilgisi', run: () => call('wifi', {}, 'Wi-Fi') },
    {
      id: 'torch',
      icon: 'flashlight',
      label: torch ? 'Feneri kapat' : 'Feneri aç',
      on: torch,
      run: async () => {
        if ((await call('torch', { on: !torch })) !== undefined) setTorch(!torch);
      },
    },
    { id: 'vibrate', icon: 'vibrate', label: 'Titret', run: () => call('vibrate', { ms: 400 }) },
    {
      id: 'toast',
      icon: 'message',
      label: 'Toast göster',
      run: async () => {
        const t = await prompt({ title: 'Toast mesajı', placeholder: 'Merhaba!' });
        if (t) call('toast', { text: t });
      },
    },
    {
      id: 'notify',
      icon: 'bell',
      label: 'Bildirim gönder',
      run: async () => {
        const t = await prompt({ title: 'Bildirim metni', placeholder: 'İşlem tamamlandı' });
        if (t) call('notify', { title: 'Termux Panel', text: t });
      },
    },
    {
      id: 'clipboard-get',
      icon: 'clipboard',
      label: 'Panoyu oku',
      run: () => call('clipboard-get', {}, 'Pano'),
    },
    {
      id: 'clipboard-set',
      icon: 'copy',
      label: 'Panoya yaz',
      run: async () => {
        const t = await prompt({ title: 'Panoya yazılacak metin', multiline: true });
        if (t) call('clipboard-set', { text: t });
      },
    },
    {
      id: 'tts',
      icon: 'speaker',
      label: 'Sesli oku',
      run: async () => {
        const t = await prompt({ title: 'Okunacak metin', placeholder: 'Merhaba dünya' });
        if (t) call('tts', { text: t });
      },
    },
    {
      id: 'brightness',
      icon: 'sun',
      label: 'Parlaklık',
      run: async () => {
        const t = await prompt({ title: 'Parlaklık (0-255)', value: '128' });
        if (t) call('brightness', { value: Number(t) });
      },
    },
    { id: 'location', icon: 'gauge', label: 'Konum', run: () => call('location', {}, 'Konum') },
    { id: 'wake-lock', icon: 'lock', label: 'Wake lock al', run: () => call('wake-lock') },
    { id: 'wake-unlock', icon: 'lock', label: 'Wake lock bırak', run: () => call('wake-unlock') },
  ];

  return (
    <>
      <Header title="Cihaz" subtitle="Termux:API" />
      <div className="content stack">
        {!avail ? (
          <Empty icon="phone" title="Termux:API kurulu değil">
            Bu özellikler için hem <code>termux-api</code> paketi hem de F-Droid/GitHub'dan <b>Termux:API</b> uygulaması gerekir (Termux ile aynı kaynaktan).
            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={() =>
                  runJob(post<JobMeta>('/api/pkg/install', { names: ['termux-api'] }), () =>
                    api<{ available: boolean }>('/api/device').then((r) => setAvail(r.available)),
                  )
                }
              >
                <Icon name="download" size={18} /> termux-api kur
              </button>
            </div>
          </Empty>
        ) : (
          <>
            <div className="callout">
              <Icon name="info" />
              <span>
                Komut takılırsa Termux:API uygulamasının kurulu olduğundan ve gerekli izinlerin verildiğinden emin ol. <b>Wake lock</b>, ekran kapalıyken
                Termux'un (ve panelin) uykuya geçmesini engeller.
              </span>
            </div>
            <div className="quick">
              {tiles.map((t) => (
                <button key={t.id} onClick={t.run} disabled={busy === t.id} style={t.on ? { borderColor: 'var(--accent)' } : undefined}>
                  {busy === t.id ? <div className="spinner" /> : <Icon name={t.icon} size={22} />}
                  {t.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <Sheet open={!!result} onClose={() => setResult(null)} title={result?.title}>
        {result && typeof result.data === 'object' && result.data !== null ? (
          <dl className="kv" style={{ margin: 0 }}>
            {Object.entries(result.data as Record<string, unknown>).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre className="job-output" style={{ minHeight: 0 }}>
            {String(result?.data ?? '')}
          </pre>
        )}
      </Sheet>
    </>
  );
}
