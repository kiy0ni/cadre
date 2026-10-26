// Shared controls: property row (slider + value), collapsible group, time input, modal, menu.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt, parseTime } from './format';
import { Icon } from './icons';
import { tx } from './i18n';

/** "Effect Controls" row: label, slider, value. Drag the value to adjust it (⇧: ×10, ⌥: fine),
 *  click to type it; double-click the label: default value; ↑ ↓ on the keyboard. */
export function Prop({ label, value, min, max, step = 1, def = 0, unit = '', onChange, disabled }: {
  label: string; value: number; min: number; max: number; step?: number; def?: number; unit?: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const shown = Math.round(value * 100) / 100;
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  const scrub = (e: React.PointerEvent<HTMLInputElement>) => {
    if (txt !== null || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, v0 = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      document.body.style.cursor = 'ew-resize';
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const range = (max - min) || 1;
      const per = range / 250;                          // ~250 px for the full range
      onChange(clamp(v0 + (dx * per * k)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      if (!moved) { const el = ref.current; if (el) { el.focus(); } }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="prop" style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <span className="ellipsis" onDoubleClick={() => onChange(def)} title={`${label} — ${tx('double-clic : valeur par défaut ({0})', `${def}${unit}`)}`}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(def)} />
      <input ref={ref} className="num" value={txt ?? `${shown}${unit}`} title={tx('Glisser pour régler · clic pour taper')}
        onPointerDown={scrub}
        onFocus={(e) => { setTxt(String(shown)); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => { const v = Number((txt || '').replace(',', '.').replace(/[^\d.+-]/g, '')); if (txt !== null && txt.trim() && !isNaN(v)) onChange(Math.max(min, Math.min(max, v))); setTxt(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setTxt(null); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const v = Math.max(min, Math.min(max, value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1))); onChange(v); setTxt(String(Math.round(v * 100) / 100)); }
        }} />
    </div>
  );
}

/** text area that grows with its content, with a button to open it full size */
export function BigText({ value, onChange, placeholder, title = tx('Texte'), mono, minHeight }: {
  value: string; onChange: (v: string) => void; placeholder?: string; title?: string; mono?: boolean; minHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bigtext">
      <textarea className={`input ${mono ? 'mono' : ''}`} style={minHeight ? { minHeight } : undefined} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button className="btn icon sm ghost expand" onClick={() => setOpen(true)} title={tx('Agrandir')}><Icon name="full" size={12} /></button>
      {open ? (
        <Modal title={title} onClose={() => setOpen(false)} huge foot={<button className="btn primary" onClick={() => setOpen(false)}>{tx('Terminé')}</button>}>
          <textarea className={`input ${mono ? 'mono' : ''}`} autoFocus value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        </Modal>
      ) : null}
    </div>
  );
}

/** UI scale (desktop app: window zoom; browser: CSS zoom) */
export function applyUiScale(f?: number) {
  let v = f;
  if (v === undefined) { try { v = Number(localStorage.getItem('cadre-ui-scale')) || 1; } catch { v = 1; } }
  try { localStorage.setItem('cadre-ui-scale', String(v)); } catch { /* storage unavailable */ }
  const d = (window as unknown as { cadre?: { setZoom?: (z: number) => void } }).cadre;
  if (d?.setZoom) d.setZoom(v);
  else (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = v === 1 ? '' : String(v);
  return v;
}

/** free-form row: label + control */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="prop"><span className="ellipsis">{label}</span><div className="row" style={{ gridColumn: 'span 2', gap: 6, minWidth: 0 }}>{children}</div></div>;
}

/** collapsible group (state remembered per title) */
export function Group({ title, children, right, closed: closedDefault = false }: { title: string; children: ReactNode; right?: ReactNode; closed?: boolean }) {
  const key = `cadre-grp-${title}`;
  const [closed, setClosed] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? closedDefault : v === '1'; } catch { return closedDefault; } });
  const toggle = () => { setClosed(!closed); try { localStorage.setItem(key, closed ? '0' : '1'); } catch { /* storage unavailable */ } };
  return (
    <div className="prop-group">
      <div className={`prop-head ${closed ? 'closed' : ''}`} onClick={toggle}>
        <span className="chev"><Icon name="chev" size={12} /></span>
        <span className="grow">{title}</span>
        {right ? <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>{right}</span> : null}
      </div>
      {closed ? null : <div className="prop-body">{children}</div>}
    </div>
  );
}

/** "m:ss.cc" time input */
export function TimeInput({ value, onChange, width = 84 }: { value: number; onChange: (v: number) => void; width?: number }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <input className="input mono" style={{ width }} value={txt ?? fmt(value, 2)} onFocus={() => setTxt(fmt(value, 2))}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => { const v = txt !== null ? parseTime(txt) : null; if (v !== null) onChange(v); setTxt(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function Modal({ title, onClose, children, foot, wide, huge }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean; huge?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${huge ? 'huge' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><h2 className="grow">{title}</h2><button className="btn icon ghost" onClick={onClose} aria-label={tx('Fermer')}><Icon name="x" size={14} /></button></div>
        <div className="modal-body">{children}</div>
        {foot ? <div className="modal-foot">{foot}</div> : null}
      </div>
    </div>
  );
}

/** dropdown menu anchored to a button; closes on outside click */
export function Dropdown({ button, children, align = 'left', width }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', on);
    return () => window.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} className="nd">
      {button(open, () => setOpen(!open))}
      {open ? <div className="menu" style={{ [align]: 0, top: 'calc(100% + 4px)', width }}>{children(() => setOpen(false))}</div> : null}
    </div>
  );
}

/** resizable panel width / height, remembered */
export function useSize(key: string, def: number, min: number, max: () => number) {
  const [v, setV] = useState(() => { try { return Number(localStorage.getItem(`cadre-size-${key}`)) || def; } catch { return def; } });
  const start = (e: React.PointerEvent, axis: 'x' | 'y', sign: 1 | -1) => {
    e.preventDefault();
    const p0 = axis === 'x' ? e.clientX : e.clientY;
    const v0 = v;
    let last = v0;
    const move = (ev: PointerEvent) => { last = Math.max(min, Math.min(max(), v0 + sign * ((axis === 'x' ? ev.clientX : ev.clientY) - p0))); setV(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      try { localStorage.setItem(`cadre-size-${key}`, String(Math.round(last))); } catch { /* storage unavailable */ }
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return [v, start] as const;
}

export function useIsMobile() {
  const q = '(max-width: 860px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// ---------------------------------------------------------------- context menu (right click)
export type MenuItem = { label: string; icon?: string; keys?: string; onClick: () => void; disabled?: boolean; danger?: boolean } | 'sep';
let openFn: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;

/** opens a context menu at the mouse position */
export function contextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  openFn?.({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  openFn = setM;
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setM(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setM(null); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('wheel', close, true); window.removeEventListener('keydown', esc); };
  }, [m]);
  if (!m) return null;
  const h = m.items.length * 30 + 10;
  const x = Math.min(m.x, window.innerWidth - 290), y = Math.min(m.y, window.innerHeight - h - 8);
  return (
    <div ref={ref} className="menu ctx" style={{ position: 'fixed', left: x, top: y, width: 280 }}>
      {m.items.map((it, i) => it === 'sep' ? <hr key={i} /> : (
        <button key={i} disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { setM(null); it.onClick(); }}>
          {it.icon ? <Icon name={it.icon} size={13} /> : <span style={{ width: 13 }} />}
          <span className="grow">{it.label}</span>
          {it.keys ? <span className="dim tiny" style={{ flex: 'none', marginLeft: 12 }}>{it.keys}</span> : null}
        </button>
      ))}
    </div>
  );
}
