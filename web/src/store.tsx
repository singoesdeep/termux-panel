import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errMsg, wsUrl } from './api';
import { Icon } from './components/Icon';
import { Sheet } from './components/ui';

// ---------------- Toast ----------------
type ToastKind = 'ok' | 'err' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

// ---------------- Dialog ----------------
interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirm?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirm?: string;
  multiline?: boolean;
}
type DialogState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | null;

// ---------------- Jobs ----------------
export interface JobMeta {
  id: string;
  title: string;
  command: string;
  status: 'running' | 'done' | 'failed' | 'killed';
  code: number | null;
  startedAt: number;
  endedAt: number | null;
}

interface Ctx {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
  jobs: JobMeta[];
  outputs: React.MutableRefObject<Map<string, string>>;
  outputTick: number;
  openJob: (id: string | null) => void;
  /** Bir iş başlatan istek; dönen işin logunu açar. */
  runJob: (p: Promise<JobMeta>, onDone?: (j: JobMeta) => void) => Promise<void>;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [jobs, setJobs] = useState<JobMeta[]>([]);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [outputTick, setOutputTick] = useState(0);
  const outputs = useRef(new Map<string, string>());
  const doneCallbacks = useRef(new Map<string, (j: JobMeta) => void>());

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 5000 : 2800);
  }, []);

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', opts, resolve })), []);
  const prompt = useCallback((opts: PromptOpts) => new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', opts, resolve })), []);

  // İş olaylarını WebSocket ile dinle (koparsa yeniden bağlan)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: number | undefined;
    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/jobs'));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'list') setJobs(msg.jobs);
        else if (msg.type === 'job') {
          const j: JobMeta = msg.job;
          setJobs((list) => [j, ...list.filter((x) => x.id !== j.id)].sort((a, b) => b.startedAt - a.startedAt));
          if (j.status !== 'running') {
            const cb = doneCallbacks.current.get(j.id);
            if (cb) {
              doneCallbacks.current.delete(j.id);
              cb(j);
            }
          }
        } else if (msg.type === 'out') {
          const prev = outputs.current.get(msg.id);
          if (prev !== undefined) {
            outputs.current.set(msg.id, prev + msg.data);
            setOutputTick((t) => t + 1);
          }
        } else if (msg.type === 'removed') setJobs((list) => list.filter((x) => x.id !== msg.id));
      };
      ws.onclose = () => {
        if (!stopped) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const openJob = useCallback((id: string | null) => {
    setOpenJobId(id);
    if (id) {
      // Geçmiş çıktıyı çek; sonrasında WS ile gelenler eklenir
      outputs.current.set(id, outputs.current.get(id) ?? '');
      api<{ output: string }>(`/api/jobs/${id}`)
        .then((j) => {
          outputs.current.set(id, j.output);
          setOutputTick((t) => t + 1);
        })
        .catch(() => {});
    }
  }, []);

  const runJob = useCallback(
    async (p: Promise<JobMeta>, onDone?: (j: JobMeta) => void) => {
      try {
        const j = await p;
        outputs.current.set(j.id, '');
        if (onDone) doneCallbacks.current.set(j.id, onDone);
        openJob(j.id);
      } catch (e) {
        toast(errMsg(e), 'err');
      }
    },
    [openJob, toast],
  );

  const value = useMemo(
    () => ({ toast, confirm, prompt, jobs, outputs, outputTick, openJob, runJob }),
    [toast, confirm, prompt, jobs, outputTick, openJob, runJob],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon name={t.kind === 'err' ? 'alert' : t.kind === 'ok' ? 'check' : 'info'} size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <DialogView state={dialog} close={() => setDialog(null)} />
      {openJobId && <JobSheet id={openJobId} onClose={() => setOpenJobId(null)} />}
    </AppCtx.Provider>
  );
}

function DialogView({ state, close }: { state: DialogState; close: () => void }) {
  const [val, setVal] = useState('');
  useEffect(() => {
    if (state?.kind === 'prompt') setVal(state.opts.value ?? '');
  }, [state]);
  if (!state) return null;
  const cancel = () => {
    if (state.kind === 'confirm') state.resolve(false);
    else state.resolve(null);
    close();
  };
  const ok = () => {
    if (state.kind === 'confirm') state.resolve(true);
    else state.resolve(val);
    close();
  };
  const o = state.opts;
  return (
    <Sheet
      open
      onClose={cancel}
      title={o.title}
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Vazgeç
          </button>
          <button
            className={`btn ${state.kind === 'confirm' && state.opts.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={ok}
            disabled={state.kind === 'prompt' && !val.trim()}
          >
            {o.confirm ?? 'Tamam'}
          </button>
        </>
      }
    >
      {state.kind === 'confirm' ? (
        <div className="dialog-msg">{state.opts.message}</div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (val.trim()) ok();
          }}
        >
          {state.opts.label && <label className="field-label">{state.opts.label}</label>}
          {state.opts.multiline ? (
            <textarea className="input mono" rows={4} value={val} onChange={(e) => setVal(e.target.value)} placeholder={state.opts.placeholder} autoFocus />
          ) : (
            <input
              className="input"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder={state.opts.placeholder}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onFocus={(e) => {
                // Dosya adında uzantıyı hariç tutarak seç
                const dot = e.target.value.lastIndexOf('.');
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
            />
          )}
        </form>
      )}
    </Sheet>
  );
}

/** ANSI renk kodlarını temizler, \r ile yazılan ilerleme çubuklarında son hali bırakır. */
function cleanOutput(s: string) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

const STATUS_LABEL: Record<JobMeta['status'], string> = {
  running: 'Çalışıyor',
  done: 'Tamamlandı',
  failed: 'Hata',
  killed: 'Durduruldu',
};

export function JobStatus({ status }: { status: JobMeta['status'] }) {
  const icon = status === 'running' ? null : status === 'done' ? 'check' : status === 'failed' ? 'alert' : 'stop';
  return (
    <span className={`badge badge-${status}`}>
      {icon ? <Icon name={icon} size={13} /> : <span className="dot-pulse" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function JobSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { jobs, outputs, outputTick, toast } = useApp();
  const job = jobs.find((j) => j.id === id);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const text = cleanOutput(outputs.current.get(id) ?? '');

  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [outputTick, text]);

  return (
    <Sheet
      open
      full
      onClose={onClose}
      title={
        <div className="job-title">
          <span className="ellipsis">{job?.title ?? 'İş'}</span>
          {job && <JobStatus status={job.status} />}
        </div>
      }
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(() => toast('Çıktı kopyalandı', 'ok'));
            }}
          >
            <Icon name="copy" size={18} /> Kopyala
          </button>
          {job?.status === 'running' ? (
            <button className="btn btn-danger" onClick={() => api(`/api/jobs/${id}/kill`, { method: 'POST' }).catch(() => {})}>
              <Icon name="stop" size={18} /> Durdur
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onClose}>
              Kapat
            </button>
          )}
        </>
      }
    >
      <pre
        ref={pre}
        className="job-output"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {text || 'Bekleniyor…'}
      </pre>
    </Sheet>
  );
}
