import { useRef, useState } from 'react';
import { Icon } from './Icon';

/** Doluluk oranına göre seviye: normal / uyarı / kritik (renk tek başına anlam taşımaz, etiket de gösterilir) */
export function level(pct: number | null | undefined, warn = 75, crit = 90) {
  if (pct == null) return 'ok';
  return pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok';
}

export function Meter({ pct, warn, crit, label }: { pct: number | null | undefined; warn?: number; crit?: number; label?: string }) {
  const lv = level(pct, warn, crit);
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div
      className={`meter ${lv === 'ok' ? '' : lv}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
    >
      <div style={{ width: `${v}%` }} />
    </div>
  );
}

export function LevelTag({ pct, warn, crit }: { pct: number | null | undefined; warn?: number; crit?: number }) {
  const lv = level(pct, warn, crit);
  if (lv === 'ok') return null;
  return (
    <span className={`level ${lv}`}>
      <Icon name="alert" size={12} />
      {lv === 'crit' ? 'Kritik' : 'Yüksek'}
    </span>
  );
}

/**
 * Küçük trend çizgisi: geçmiş soluk renkte, son nokta vurgu renginde.
 * Dokun/üzerine gel → o anki değer gösterilir.
 */
export function Sparkline({ values, max = 100, format }: { values: number[]; max?: number; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = 200;
  const H = 40;
  const n = Math.max(values.length, 2);
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - 2 - (Math.min(v, max) / max) * (H - 4);
  if (values.length < 2) return <div className="spark" />;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const hi = hover ?? last;

  const pick = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(values.length - 1, i)));
  };

  return (
    <div
      className="spark"
      ref={ref}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Son değer ${format(values[last])}`}>
        <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={d} fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <line x1={x(hi)} x2={x(hi)} y1="0" y2={H} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* Nokta HTML ile: SVG ölçeklenince daire bozulmasın */}
      <span
        style={{
          position: 'absolute',
          left: `${(x(hi) / W) * 100}%`,
          top: `${(y(values[hi]) / H) * 100}%`,
          width: 8,
          height: 8,
          marginLeft: -4,
          marginTop: -4,
          borderRadius: '50%',
          background: 'var(--accent)',
          boxShadow: '0 0 0 2px var(--surface)',
        }}
      />
      {hover != null && (
        <div className="spark-tip" style={{ left: `${Math.max(12, Math.min(88, (x(hi) / W) * 100))}%` }}>
          {format(values[hi])} · {Math.round(((last - hi) * 3))} sn önce
        </div>
      )}
    </div>
  );
}
