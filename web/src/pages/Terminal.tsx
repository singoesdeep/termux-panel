import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, errMsg, post, wsUrl } from '../api';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/ui';
import { useEnvs } from '../envs';
import { navigate } from '../router';
import { useApp } from '../store';

interface SessionInfo {
  id: string;
  title: string;
  env?: string;
  pid: number;
  exited: boolean;
}

interface Live {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ws: WebSocket | null;
  closed: boolean;
  exited: boolean;
}

const THEME = {
  background: '#0d0d0c',
  foreground: '#e8e6df',
  cursor: '#3987e5',
  selectionBackground: '#3987e566',
  black: '#1a1a19',
  red: '#e66767',
  green: '#4cc24c',
  yellow: '#e5b33f',
  blue: '#3987e5',
  magenta: '#d55181',
  cyan: '#2bb58a',
  white: '#dcdad3',
  brightBlack: '#6e6d68',
  brightRed: '#ff8a8a',
  brightGreen: '#7ee07e',
  brightYellow: '#ffd36b',
  brightBlue: '#6aa8f0',
  brightMagenta: '#f08bb2',
  brightCyan: '#5fd9b0',
  brightWhite: '#ffffff',
};

/** xterm (~300 KB) yalnızca terminal ilk açıldığında yüklenir; ana ekran daha hızlı açılır. */
type XtermLib = {
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
};
let libPromise: Promise<XtermLib> | null = null;
function loadXterm() {
  libPromise ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
  ]).then(([x, f, w]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: w.WebLinksAddon }));
  return libPromise;
}

function loadFontSize() {
  try {
    return Number(localStorage.getItem('tp-term-font')) || (window.innerWidth < 600 ? 12 : 14);
  } catch {
    return 13;
  }
}

export default function TerminalPage({ active, params }: { active: boolean; params: URLSearchParams }) {
  const { toast } = useApp();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [lib, setLib] = useState<XtermLib | null>(null);
  useEffect(() => {
    if (active && !lib) loadXterm().then(setLib, (e) => toast(`Terminal yüklenemedi: ${errMsg(e)}`, 'err'));
  }, [active, lib, toast]);
  const host = useRef<HTMLDivElement>(null);
  const lives = useRef(new Map<string, Live>());
  const mods = useRef({ ctrl: false, alt: false });
  mods.current = { ctrl, alt };
  const currentRef = useRef(current);
  currentRef.current = current;
  const started = useRef(false);

  const send = useCallback((id: string, d: string) => {
    const l = lives.current.get(id);
    if (l?.ws?.readyState === WebSocket.OPEN) l.ws.send(JSON.stringify({ t: 'i', d }));
  }, []);

  const fitAndResize = useCallback((id: string | null) => {
    if (!id) return;
    const l = lives.current.get(id);
    if (!l || l.el.offsetParent === null) return;
    try {
      l.fit.fit();
    } catch {
      return;
    }
    if (l.ws?.readyState === WebSocket.OPEN) l.ws.send(JSON.stringify({ t: 'r', c: l.term.cols, r: l.term.rows }));
  }, []);

  const connect = useCallback(
    (id: string) => {
      const l = lives.current.get(id);
      if (!l || l.closed || l.exited) return;
      const ws = new WebSocket(wsUrl(`/ws/terminal/${id}`));
      l.ws = ws;
      ws.onopen = () => {
        l.term.reset(); // sunucu geçmişi yeniden gönderecek
        if (currentRef.current === id) setConnected(true);
        fitAndResize(id);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'o') l.term.write(m.d);
        else if (m.t === 'x') {
          l.exited = true;
          l.term.write(`\r\n\x1b[90m[oturum sona erdi${m.code ? `: ${m.code}` : ''}]\x1b[0m\r\n`);
          setSessions((s) => s.map((x) => (x.id === id ? { ...x, exited: true } : x)));
        } else if (m.t === 'e') {
          l.exited = true;
          l.term.write(`\r\n\x1b[31m${m.d}\x1b[0m\r\n`);
        }
      };
      ws.onclose = () => {
        if (currentRef.current === id) setConnected(false);
        // Mobilde sekme arka plana gidince bağlantı kopar → geri dönünce yeniden bağlan
        if (!l.closed && !l.exited) setTimeout(() => connect(id), 1500);
      };
    },
    [fitAndResize],
  );

  const ensureLive = useCallback(
    (id: string) => {
      if (lives.current.has(id) || !host.current || !lib) return;
      const { Terminal, FitAddon, WebLinksAddon } = lib;
      const el = document.createElement('div');
      el.style.height = '100%';
      el.style.display = 'none';
      host.current.appendChild(el);
      const term = new Terminal({
        fontFamily: "ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, 'DejaVu Sans Mono', monospace",
        fontSize,
        theme: THEME,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(el);
      term.onData((data) => {
        let d = data;
        const m = mods.current;
        if (m.ctrl && d.length === 1) {
          const c = d.toLowerCase().charCodeAt(0);
          if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
          else if (d === ' ' || d === '@') d = '\x00';
          else if (d === '[') d = '\x1b';
          else if (d === '\\') d = '\x1c';
          else if (d === ']') d = '\x1d';
          setCtrl(false);
        }
        if (m.alt) {
          d = '\x1b' + d;
          setAlt(false);
        }
        send(id, d);
      });
      lives.current.set(id, { term, fit, el, ws: null, closed: false, exited: false });
      connect(id);
    },
    [connect, send, fontSize, lib],
  );

  const createSession = useCallback(
    async (opts: { command?: string; env?: string; cwd?: string } = {}) => {
      try {
        const s = await post<SessionInfo>('/api/terminals', {
          cols: 80,
          rows: 24,
          ...(opts.command ? { command: opts.command } : {}),
          ...(opts.env && opts.env !== 'termux' ? { env: opts.env } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
        });
        setSessions((list) => [...list, s]);
        setCurrent(s.id);
      } catch (e) {
        toast(errMsg(e), 'err');
      }
    },
    [toast],
  );

  // İlk yükleme: mevcut oturumları al, yoksa bir tane aç
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    api<{ sessions: SessionInfo[] }>('/api/terminals')
      .then(({ sessions: list }) => {
        const alive = list.filter((s) => !s.exited);
        setSessions(alive);
        if (wantsNew(params)) return; // aşağıdaki effect oluşturacak
        if (alive.length) setCurrent(alive[alive.length - 1].id);
        else createSession();
      })
      .catch((e) => toast(errMsg(e), 'err'));
  }, [active, params, createSession, toast]);

  // #/terminal?new=1, ?cmd=..., ?env=debian, ?cwd=... ile gelindiğinde yeni oturum
  useEffect(() => {
    if (!active || !wantsNew(params)) return;
    navigate('terminal', undefined, true);
    createSession({ command: params.get('cmd') ?? undefined, env: params.get('env') ?? undefined, cwd: params.get('cwd') ?? undefined });
  }, [active, params, createSession]);

  // Distro varsa yeni oturumda ortam sorulur
  const { distros } = useEnvs();
  const [picking, setPicking] = useState(false);
  const newSession = () => (distros.length ? setPicking(true) : createSession());

  // Aktif oturumu göster
  useEffect(() => {
    if (!current || !lib) return;
    ensureLive(current);
    for (const [id, l] of lives.current) l.el.style.display = id === current ? 'block' : 'none';
    const l = lives.current.get(current);
    setConnected(l?.ws?.readyState === WebSocket.OPEN);
    requestAnimationFrame(() => {
      fitAndResize(current);
      if (active && window.innerWidth >= 900) l?.term.focus();
    });
  }, [current, active, ensureLive, fitAndResize, lib]);

  // Boyut değişince yeniden sığdır (klavye açılması dahil)
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(() => fitAndResize(currentRef.current));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [fitAndResize]);

  useEffect(() => {
    try {
      localStorage.setItem('tp-term-font', String(fontSize));
    } catch {
      /* yok */
    }
    for (const l of lives.current.values()) l.term.options.fontSize = fontSize;
    fitAndResize(currentRef.current);
  }, [fontSize, fitAndResize]);

  useEffect(
    () => () => {
      for (const l of lives.current.values()) {
        l.closed = true;
        l.ws?.close();
        l.term.dispose();
      }
      lives.current.clear();
    },
    [],
  );

  const closeSession = async (id: string) => {
    const l = lives.current.get(id);
    if (l) {
      l.closed = true;
      l.ws?.close();
      l.term.dispose();
      l.el.remove();
      lives.current.delete(id);
    }
    await del(`/api/terminals/${id}`).catch(() => {});
    const rest = sessions.filter((s) => s.id !== id);
    setSessions(rest);
    if (current === id) setCurrent(rest.length ? rest[rest.length - 1].id : null);
  };

  const key = (seq: string) => {
    if (!current) return;
    const l = lives.current.get(current);
    const app = l?.term.modes.applicationCursorKeysMode;
    const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };
    if (arrows[seq]) send(current, (app ? '\x1bO' : '\x1b[') + arrows[seq]);
    else send(current, alt ? '\x1b' + seq : seq);
    if (alt) setAlt(false);
    if (ctrl) setCtrl(false);
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && current) lives.current.get(current)?.term.paste(text);
    } catch {
      toast('Pano okunamadı (tarayıcı izni gerekli)', 'err');
    }
  };

  // Tuşa basınca terminal odağı (ve klavye) kaybolmasın
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="term-page">
      <div className="term-tabs">
        {sessions.map((s) => (
          <div key={s.id} className={`term-tab ${s.id === current ? 'on' : ''}`} onClick={() => setCurrent(s.id)} role="button">
            {s.env && s.env !== 'termux' && <Icon name="box" size={13} />}
            <span style={{ opacity: s.exited ? 0.5 : 1 }}>{s.title}</span>
            <span
              className="x"
              role="button"
              aria-label="Oturumu kapat"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              <Icon name="x" size={14} />
            </span>
          </div>
        ))}
        <button className="icon-btn" onClick={newSession} aria-label="Yeni oturum" style={{ width: 34, height: 34 }}>
          <Icon name="plus" size={18} />
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.max(8, f - 1))} aria-label="Yazıyı küçült" style={{ width: 34, height: 34 }}>
          <Icon name="minus" size={16} />
        </button>
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.min(24, f + 1))} aria-label="Yazıyı büyüt" style={{ width: 34, height: 34 }}>
          <Icon name="plus" size={16} />
        </button>
      </div>

      <div className="term-wrap" onClick={() => current && lives.current.get(current)?.term.focus()}>
        {current && !connected && (
          <span className="term-status badge badge-warn">
            <span className="dot-pulse" /> Bağlanıyor
          </span>
        )}
        <div ref={host} style={{ height: '100%' }} />
        {sessions.length === 0 && (
          <div className="empty" style={{ position: 'absolute', inset: 0, justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={newSession}>
              <Icon name="plus" size={18} /> Yeni oturum
            </button>
          </div>
        )}
      </div>

      <div className="keys" onMouseDown={keep}>
        <button onClick={() => key('\x1b')}>ESC</button>
        <button onClick={() => key('\t')}>TAB</button>
        <button className={ctrl ? 'on' : ''} onClick={() => setCtrl((v) => !v)}>
          CTRL
        </button>
        <button className={alt ? 'on' : ''} onClick={() => setAlt((v) => !v)}>
          ALT
        </button>
        <button onClick={() => key('left')} aria-label="Sol">←</button>
        <button onClick={() => key('up')} aria-label="Yukarı">↑</button>
        <button onClick={() => key('down')} aria-label="Aşağı">↓</button>
        <button onClick={() => key('right')} aria-label="Sağ">→</button>
        <button onClick={() => key('\x03')}>^C</button>
        <button onClick={() => key('\x04')}>^D</button>
        <button onClick={() => key('\x1b[H')}>HOME</button>
        <button onClick={() => key('\x1b[F')}>END</button>
        <button onClick={() => key('\x1b[5~')}>PGUP</button>
        <button onClick={() => key('\x1b[6~')}>PGDN</button>
        <button onClick={() => key('|')}>|</button>
        <button onClick={() => key('/')}>/</button>
        <button onClick={() => key('-')}>-</button>
        <button onClick={() => key('~')}>~</button>
        <button onClick={paste} aria-label="Yapıştır">
          <Icon name="clipboard" size={16} />
        </button>
      </div>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Yeni oturum">
        <div className="action-list">
          <button onClick={() => (setPicking(false), createSession())}>
            <Icon name="phone" /> Termux
          </button>
          {distros.map((d) => (
            <button key={d.name} onClick={() => (setPicking(false), createSession({ env: d.name }))}>
              <Icon name="box" />
              <span>
                {d.name} <span className="faint" style={{ fontSize: 13 }}>{d.os}</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

const wantsNew = (p: URLSearchParams) => Boolean(p.get('new') || p.get('cmd') || p.get('env') || p.get('cwd'));
