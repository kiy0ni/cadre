// Panneau Propriétés (façon « Effect Controls ») : réglages de l'élément sélectionné, en groupes repliables.
// Sans sélection : réglages du projet (style, consignes pour l'IA, personnes, mixage, glossaire).
import { useState } from 'react';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import { Icon } from '../lib/icons';
import { getFrame, uid, useStore } from '../lib/store';
import { BigText, Group, Prop, Row, Seg, TimeInput } from '../lib/ui';
import { pathOf, previewPath, thumbUrl } from '../lib/previews';
import type { Caption, CardItem, ClipItem, ColorAdj, FreezeItem, Fx, Item, Look, MediaItem, OClip, OText, Project, Target, TextStyle, TransitionKind } from '../types';
import { BLENDS, COLOR_PRESETS, cssPreview } from '../remotion/look';
import { srcToFrame } from '../remotion/resolve';
import { clipAt, useComp } from './comp';
import { deleteSelection, duplicateSelection, savePreset } from './actions';
import { FX_CATS, FX_DEFS, fxDef, newFx } from '../remotion/effects';
import type { VFx } from '../types';
import { Dropdown } from '../lib/ui';
import { tx } from '../lib/i18n';
import { FONTS } from '../remotion/fonts';

export type Ref = { kind: 'item'; id: string } | { kind: 'clip'; id: string };
type Patch = (fn: (t: Item | OClip) => void, merge?: string) => void;

export function findRef(p: Project, ref: Ref): Item | OClip | null {
  if (ref.kind === 'item') return p.timeline.find((x) => x.id === ref.id) || null;
  for (const tr of p.tracks || []) { const c = tr.clips.find((x) => x.id === ref.id); if (c) return c; }
  return null;
}

export function usePatch(ref: Ref | null): Patch {
  const update = useStore((s) => s.update);
  return (fn, merge) => { if (ref) update((p) => { const t = findRef(p, ref); if (t) fn(t); }, merge ? `${ref.id}:${merge}` : undefined); };
}

export const FONTS_LIST = Object.keys(FONTS);
export const TRANSITIONS: [TransitionKind | 'none', string][] = [['none', tx('Aucune')], ['fade', tx('Fondu au noir')], ['flash', tx('Flash blanc')], ['zoom', tx('Zoom')], ['whip', tx('Filé')], ['glitch', tx('Glitch')], ['blur', tx('Flou')]];
const FX_LABEL: Record<Fx['kind'], string> = { zoom: tx('Zoom'), shake: tx('Secousse'), tint: tx('Teinte'), sfx: tx('Son'), text: tx('Texte'), cut: tx('Coupe'), keep: tx('Garder'), speed: tx('Vitesse'), censor: tx('Bip') };

export function PropsPanel() {
  const { props } = useComp();
  const sel = useStore((s) => s.sel);
  const p = props.project;
  if (sel.musicId) { const m = p.music.find((x) => x.id === sel.musicId); if (m) return <MusicProps id={m.id} />; }
  if (sel.clipId) {
    for (const tr of p.tracks || []) {
      const c = tr.clips.find((x) => x.id === sel.clipId);
      if (c) return <ClipProps clip={c} trackName={tr.name} />;
    }
  }
  const it = sel.itemId ? p.timeline.find((x) => x.id === sel.itemId) : undefined;
  if (it) return <ItemProps item={it} />;
  return <ProjectProps />;
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="toolbar" style={{ gap: 6 }}>
      <b className="ellipsis grow" style={{ paddingLeft: 4 }}>{title}{sub ? <span className="dim" style={{ fontWeight: 400 }}> · {sub}</span> : null}</b>
      <button className="btn icon sm ghost" onClick={duplicateSelection} title={tx('Dupliquer (⌘D)')}><Icon name="copy" size={13} /></button>
      <button className="btn icon sm ghost" onClick={deleteSelection} title={tx('Supprimer (Suppr)')}><Icon name="trash" size={13} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- groupes communs
export function MotionGroups({ id, look, patch, crop = true, chroma = false }: { id: string; look: Look; patch: Patch; crop?: boolean; chroma?: boolean }) {
  const L = (fn: (l: Look) => void, f: string) => patch((t) => { const tt = t as { look?: Look }; tt.look = tt.look || {}; fn(tt.look); }, `look:${f}`);
  const c = look.crop || { l: 0, t: 0, r: 0, b: 0 };
  return (
    <>
      <Group title={tx('Mouvement')} right={<button className="btn sm ghost reset" onClick={() => L((l) => { delete l.x; delete l.y; delete l.scale; delete l.rotation; delete l.flipH; delete l.flipV; }, 'reset')} title={tx('Réinitialiser')}><Icon name="undo" size={11} /></button>}>
        <Prop label={tx('Position X')} value={look.x || 0} min={-100} max={100} step={0.5} unit="%" onChange={(v) => L((l) => { l.x = v; }, 'x')} />
        <Prop label={tx('Position Y')} value={look.y || 0} min={-100} max={100} step={0.5} unit="%" onChange={(v) => L((l) => { l.y = v; }, 'y')} />
        <Prop label={tx('Échelle')} value={Math.round((look.scale ?? 1) * 100)} min={10} max={400} def={100} unit="%" onChange={(v) => L((l) => { l.scale = v / 100; }, 'scale')} />
        <Prop label={tx('Rotation')} value={look.rotation || 0} min={-180} max={180} unit="°" onChange={(v) => L((l) => { l.rotation = v; }, 'rot')} />
        <Row label={tx('Miroir')}>
          <button className={`btn sm ${look.flipH ? 'on' : ''}`} onClick={() => L((l) => { l.flipH = !l.flipH; }, 'fh')}>{tx('Horizontal')}</button>
          <button className={`btn sm ${look.flipV ? 'on' : ''}`} onClick={() => L((l) => { l.flipV = !l.flipV; }, 'fv')}>{tx('Vertical')}</button>
        </Row>
      </Group>
      <Group title={tx('Opacité')}>
        <Prop label={tx('Opacité')} value={Math.round((look.opacity ?? 1) * 100)} min={0} max={100} def={100} unit="%" onChange={(v) => L((l) => { l.opacity = v / 100; }, 'op')} />
        <Row label={tx('Fusion')}>
          <select className="input" value={look.blend || 'normal'} onChange={(e) => L((l) => { l.blend = e.target.value; }, 'blend')}>
            {BLENDS.map(([v, n]) => <option key={v} value={v}>{tx(n)}</option>)}
          </select>
        </Row>
      </Group>
      {chroma ? (
        <Group title={tx('Incrustation (fond vert)')} closed={!look.chroma} right={<input type="checkbox" checked={!!look.chroma} onChange={(e) => L((l) => { l.chroma = e.target.checked ? '#00ff00' : null; }, 'chroma')} />}>
          <Row label={tx('Couleur clé')}>
            <Seg value={look.chroma === '#0000ff' ? 'b' : 'g'} options={[['g', tx('Vert')], ['b', tx('Bleu')]]} onChange={(v) => L((l) => { l.chroma = v === 'b' ? '#0000ff' : '#00ff00'; }, 'chromac')} />
          </Row>
        </Group>
      ) : null}
      {crop ? (
        <Group title={tx('Recadrage')} closed>
          {(['l', 't', 'r', 'b'] as const).map((k) => (
            <Prop key={k} label={{ l: tx('Gauche'), t: tx('Haut'), r: tx('Droite'), b: tx('Bas') }[k]} value={c[k]} min={0} max={50} step={0.5} unit="%"
              onChange={(v) => L((l) => { l.crop = { ...(l.crop || { l: 0, t: 0, r: 0, b: 0 }), [k]: v }; }, `crop${k}`)} />
          ))}
        </Group>
      ) : null}
    </>
  );
}

export const COLOR_SLIDERS: [keyof ColorAdj, string, number, number][] = [
  ['exposure', tx('Exposition'), -100, 100], ['contrast', tx('Contraste'), -100, 100], ['highlights', tx('Hautes lumières'), -100, 100], ['shadows', tx('Ombres'), -100, 100],
  ['temperature', tx('Température'), -100, 100], ['tint', tx('Teinte'), -100, 100], ['saturation', tx('Saturation'), -100, 100], ['vignette', tx('Vignettage'), 0, 100],
];

export function ColorControls({ look, patch, thumb, closed }: { look: Look; patch: Patch; thumb: string; closed?: boolean }) {
  const c = look.color || {};
  const C = (fn: (c: ColorAdj) => void, f: string) => patch((t) => { const tt = t as { look?: Look }; tt.look = tt.look || {}; tt.look.color = { ...(tt.look.color || {}) }; fn(tt.look.color); }, `color:${f}`);
  return (
    <>
      <Group title={tx('Correction de base')} closed={closed} right={<button className="btn sm ghost reset" onClick={() => C((cc) => { for (const [k] of COLOR_SLIDERS) delete cc[k]; }, 'reset')} title={tx('Réinitialiser')}><Icon name="undo" size={11} /></button>}>
        {COLOR_SLIDERS.map(([k, label, min, max]) => (
          <Prop key={k} label={label} value={(c[k] as number) || 0} min={min} max={max} onChange={(v) => C((cc) => { (cc as Record<string, number>)[k] = v; }, k)} />
        ))}
      </Group>
      <Group title={tx('Look')} closed={closed}>
        <div className="preset-grid">
          {Object.entries(COLOR_PRESETS).map(([k, v]) => (
            <div key={k} className={`preset ${(c.preset || 'none') === k ? 'on' : ''}`} onClick={() => C((cc) => { cc.preset = k === 'none' ? undefined : k; }, 'preset')}>
              <div className="thumb" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: cssPreview(v.adj) }} />
              {tx(v.label)}
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- élément du montage principal (V1)
function ItemProps({ item }: { item: Item }) {
  const { props, r } = useComp();
  const frame = useStore((s) => s.frame);
  const patch = usePatch({ kind: 'item', id: item.id });
  const look = ('look' in item && item.look) || {};
  const src = item.type === 'clip' || item.type === 'freeze' ? props.project.sources.find((s) => s.id === item.src) : undefined;
  const at = clipAt(r, props.project.timeline, frame);
  const t = item.type === 'freeze' ? item.t : item.type === 'clip' ? (at && at.clip.id === item.id ? at.t : item.in) : 0;
  const thumb = src ? thumbUrl(previewPath(src), t, 200) : item.type === 'media' ? thumbUrl(item.path, 0, 200) : '';
  const i = props.project.timeline.findIndex((x) => x.id === item.id);
  const names = { clip: tx('Plan'), card: tx('Carton'), freeze: tx('Arrêt sur image'), media: tx('Média') };
  return (
    <>
      <Head title={`${names[item.type]} ${i + 1}`} sub={src?.name} />
      <div className="pbody">
        {item.type === 'clip' ? <ClipGroups clip={item} /> : item.type === 'card' ? <CardGroup card={item} /> : item.type === 'freeze' ? <FreezeGroup fz={item} /> : <MediaGroup m={item} />}
        {item.type !== 'card' ? (
          <>
            <MotionGroups id={item.id} look={look} patch={patch} />
            <EffectsGroup look={look} patch={patch} />
            <ColorControls look={look} patch={patch} thumb={thumb} closed />
            <Group title={tx('Transition d\'entrée')} closed={!item.transition}>
              <Row label={tx('Type')}>
                <select className="input" value={item.transition?.kind || 'none'} onChange={(e) => patch((x) => { const it = x as Item; if (it.type === 'card') return; it.transition = e.target.value === 'none' ? null : { kind: e.target.value as TransitionKind, dur: it.transition?.dur || 0.4 }; })}>
                  {TRANSITIONS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </select>
              </Row>
              {item.transition ? <Prop label={tx('Durée')} value={item.transition.dur} min={0.1} max={2} step={0.05} def={0.4} unit=" s" onChange={(v) => patch((x) => { const it = x as Item; if (it.type !== 'card' && it.transition) it.transition.dur = v; }, 'trdur')} /> : null}
            </Group>
          </>
        ) : null}
        {item.type === 'clip' ? (
          <>
            <Group title={tx('Audio')}>
              <Prop label={tx('Volume')} value={item.volumeDb || 0} min={-40} max={12} step={0.5} unit=" dB" onChange={(v) => patch((x) => { (x as ClipItem).volumeDb = v; }, 'vol')} />
              <Prop label={tx('Fondu entrée')} value={item.fadeIn || 0} min={0} max={3} step={0.05} unit=" s" onChange={(v) => patch((x) => { (x as ClipItem).fadeIn = v; }, 'fin')} />
              <Prop label={tx('Fondu sortie')} value={item.fadeOut || 0} min={0} max={3} step={0.05} unit=" s" onChange={(v) => patch((x) => { (x as ClipItem).fadeOut = v; }, 'fout')} />
            </Group>
            <FxGroup clip={item} />
            <CaptionsGroup clip={item} />
          </>
        ) : null}
      </div>
    </>
  );
}

function ClipGroups({ clip }: { clip: ClipItem }) {
  const { props, r, style } = useComp();
  const frame = useStore((s) => s.frame);
  const patch = usePatch({ kind: 'item', id: clip.id });
  const P = (fn: (c: ClipItem) => void, m?: string) => patch((x) => fn(x as ClipItem), m);
  const src = props.project.sources.find((s) => s.id === clip.src);
  const at = clipAt(r, props.project.timeline, frame);
  const here = at && at.clip.id === clip.id ? at.t : null;
  const jump = clip.jump ?? style.jumpCuts.enabled;
  return (
    <Group title={tx('Plan')}>
      <Row label={tx('Chapitre')}><input className="input" value={clip.label || ''} placeholder={tx('Aucun')} onChange={(e) => P((c) => { c.label = e.target.value; }, 'label')} /></Row>
      <Row label={tx('Entrée / sortie')}>
        <TimeInput value={clip.in} onChange={(v) => P((c) => { c.in = Math.max(0, Math.min(v, c.out - 0.2)); })} />
        <TimeInput value={clip.out} onChange={(v) => P((c) => { c.out = Math.min(src?.duration ?? v, Math.max(v, c.in + 0.2)); })} />
      </Row>
      <Row label="">
        <button className="btn sm" disabled={here === null} onClick={() => here !== null && P((c) => { c.in = here; })} title={tx('Le plan commence à la tête de lecture')}>{tx('Entrée ici')}</button>
        <button className="btn sm" disabled={here === null} onClick={() => here !== null && P((c) => { c.out = here; })} title={tx('Le plan s\'arrête à la tête de lecture')}>{tx('Sortie ici')}</button>
      </Row>
      <Prop label={tx('Vitesse')} value={clip.speed ?? 1} min={0.25} max={4} step={0.05} def={1} unit="×" onChange={(v) => P((c) => { c.speed = v; }, 'speed')} />
      <Row label={tx('Silences')}>
        <label className="check"><input type="checkbox" checked={jump} onChange={(e) => P((c) => { c.jump = e.target.checked; })} /> {tx('couper')}</label>
      </Row>
      {jump ? <Prop label={tx('Silence max')} value={clip.gap ?? style.jumpCuts.gap} min={0.05} max={2} step={0.05} def={style.jumpCuts.gap} unit=" s" onChange={(v) => P((c) => { c.gap = v; }, 'gap')} /> : null}
      {r.height > r.width ? <Prop label={tx('Cadrage horiz.')} value={Math.round((clip.cropX ?? 0.5) * 100)} min={0} max={100} def={50} unit="%" onChange={(v) => P((c) => { c.cropX = v / 100; }, 'cropx')} /> : null}
      <span className="tiny dim">{fmt(clip.out - clip.in, 1)} dans la source{src ? ` · ${src.name}` : ''}</span>
    </Group>
  );
}

function FxGroup({ clip }: { clip: ClipItem }) {
  const { props, r, style } = useComp();
  const frame = useStore((s) => s.frame);
  const library = useStore((s) => s.library);
  const seek = useStore((s) => s.seek);
  const patch = usePatch({ kind: 'item', id: clip.id });
  const P = (fn: (c: ClipItem) => void, m?: string) => patch((x) => fn(x as ClipItem), m);
  const at = clipAt(r, props.project.timeline, frame);
  const here = at && at.clip.id === clip.id ? at.t : null;
  const sfxNames = Object.values(library?.sfx || {});
  const add = (f: Partial<Fx> & { kind: Fx['kind'] }) => {
    const t = here ?? clip.in;
    const full = ({ zoom: { t0: t, t1: t + 1.2, target: 'face', scale: style.zoom.face }, shake: { t0: t, t1: t + 0.4, amp: 14 },
      tint: { t0: t, t1: t + 1.5, mode: 'bw' }, sfx: { t, name: sfxNames[0]?.name || '', db: 0 }, text: { t, dur: 1.4, text: 'TEXTE', style: 'big' },
      cut: { t0: t, t1: t + 1 }, keep: { t0: t, t1: t + 1 }, speed: { t0: t, t1: t + 3, rate: 2 }, censor: { t0: t, t1: t + 0.4 } } as Record<string, object>)[f.kind];
    P((c) => { c.fx.push({ id: uid('f'), ...full, ...f } as Fx); c.fx.sort((a, b) => ('t' in a ? a.t : a.t0) - ('t' in b ? b.t : b.t0)); });
  };
  const goSrc = (t: number) => { const f = srcToFrame(r, clip.id, t); if (f !== null) seek(f); };
  return (
    <Group title={`Accentuations${clip.fx.length ? ` (${clip.fx.length})` : ''}`} closed={!clip.fx.length}>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => add({ kind: 'zoom', target: 'face', scale: style.zoom.face })}>{tx('Zoom visage')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'zoom', target: 'center', scale: style.zoom.center })}>{tx('Zoom centre')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'shake' })}>{tx('Secousse')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'tint', mode: 'bw' })}>N&B</button>
        <button className="btn sm" onClick={() => add({ kind: 'text' })}>{tx('Texte')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'speed' })}>{tx('Accéléré')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'cut' })}>{tx('Couper')}</button>
        <button className="btn sm" onClick={() => add({ kind: 'censor' })}>{tx('Bip')}</button>
        {sfxNames.length ? <button className="btn sm" onClick={() => add({ kind: 'sfx' })}>{tx('Son')}</button> : null}
      </div>
      {here === null ? <span className="tiny dim">{tx('Les accentuations se posent à la tête de lecture : place-la dans ce plan.')}</span> : null}
      {clip.fx.map((f) => <FxRow key={f.id} f={f} clipId={clip.id} onGo={goSrc} />)}
    </Group>
  );
}

function FxRow({ f, clipId, onGo }: { f: Fx; clipId: string; onGo: (t: number) => void }) {
  const library = useStore((s) => s.library);
  const patch = usePatch({ kind: 'item', id: clipId });
  const P = (fn: (x: Fx) => void, m?: string) => patch((c) => { const x = (c as ClipItem).fx.find((y) => y.id === f.id); if (x) fn(x); }, m ? `fx:${f.id}:${m}` : undefined);
  const del = () => patch((c) => { (c as ClipItem).fx = (c as ClipItem).fx.filter((y) => y.id !== f.id); });
  const t = 't' in f ? f.t : f.t0;
  const num = (v: number, set: (n: number) => void, step: number, w = 54, title?: string) => (
    <input className="input" type="number" step={step} style={{ width: w }} value={v} title={title} onChange={(e) => set(Number(e.target.value))} />
  );
  return (
    <div className="col" style={{ gap: 4, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 6 }}>
        <b className="small" style={{ cursor: 'pointer', minWidth: 62 }} onClick={() => onGo(t)} title={tx('Aller à cet effet')}>{FX_LABEL[f.kind]}</b>
        {'t0' in f ? <><TimeInput width={70} value={f.t0} onChange={(v) => P((x) => { if ('t0' in x) x.t0 = v; })} /><TimeInput width={70} value={f.t1} onChange={(v) => P((x) => { if ('t1' in x) x.t1 = v; })} /></>
          : <TimeInput width={70} value={f.t} onChange={(v) => P((x) => { if ('t' in x) x.t = v; })} />}
        <span className="spacer" />
        <button className="btn icon sm ghost" onClick={del} title={tx('Retirer')}><Icon name="x" size={11} /></button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {f.kind === 'zoom' ? (
          <>
            <select className="input" style={{ width: 84 }} value={Array.isArray(f.target) ? 'xy' : f.target} onChange={(e) => P((x) => { if (x.kind === 'zoom') x.target = e.target.value === 'xy' ? [0.5, 0.5] : (e.target.value as Target); })}>
              <option value="face">{tx('visage')}</option><option value="center">{tx('centre')}</option><option value="xy">{tx('point')}</option>
            </select>
            {Array.isArray(f.target) ? <>{num(f.target[0], (v) => P((x) => { if (x.kind === 'zoom' && Array.isArray(x.target)) x.target = [v, x.target[1]]; }, 'tx'), 0.02)}{num(f.target[1], (v) => P((x) => { if (x.kind === 'zoom' && Array.isArray(x.target)) x.target = [x.target[0], v]; }, 'ty'), 0.02)}</> : null}
            <span className="small dim">{tx('×')}</span>{num(f.scale, (v) => P((x) => { if (x.kind === 'zoom') x.scale = v; }, 'sc'), 0.05)}
          </>
        ) : f.kind === 'shake' ? <><span className="small dim">{tx('force')}</span>{num(f.amp, (v) => P((x) => { if (x.kind === 'shake') x.amp = v; }, 'amp'), 1)}</>
          : f.kind === 'tint' ? (
            <select className="input" style={{ width: 100 }} value={f.mode} onChange={(e) => P((x) => { if (x.kind === 'tint') x.mode = e.target.value as 'bw'; })}>
              <option value="bw">{tx('Noir et blanc')}</option><option value="flash">{tx('Flash')}</option>{f.mode === 'red' ? <option value="red">{tx('Rouge')}</option> : null}
            </select>
          ) : f.kind === 'sfx' ? (
            <>
              <select className="input grow" style={{ minWidth: 0 }} value={f.name} onChange={(e) => P((x) => { if (x.kind === 'sfx') x.name = e.target.value; })}>
                {Object.values(library?.sfx || {}).map((s) => <option key={s.name} value={s.name}>{(s as { label?: string }).label || s.name}</option>)}
              </select>
              {num(f.db, (v) => P((x) => { if (x.kind === 'sfx') x.db = v; }, 'db'), 1, 50, 'dB')}
            </>
          ) : f.kind === 'text' ? (
            <>
              <input className="input grow" value={f.text} onChange={(e) => P((x) => { if (x.kind === 'text') x.text = e.target.value; }, 'txt')} />
              <select className="input" style={{ width: 70 }} value={f.style} onChange={(e) => P((x) => { if (x.kind === 'text') x.style = e.target.value as 'big'; })}>
                <option value="big">{tx('gros')}</option><option value="note">{tx('note')}</option>{f.style === 'rip' ? <option value="rip">RIP</option> : null}
              </select>
            </>
          ) : f.kind === 'speed' ? <><span className="small dim">{tx('×')}</span>{num(f.rate, (v) => P((x) => { if (x.kind === 'speed') x.rate = v || 1; }, 'rate'), 0.25)}</> : null}
      </div>
    </div>
  );
}

function CaptionsGroup({ clip }: { clip: ClipItem }) {
  const { props, r } = useComp();
  const sel = useStore((s) => s.sel);
  const select = useStore((s) => s.select);
  const seek = useStore((s) => s.seek);
  const frame = useStore((s) => s.frame);
  const speakers = useStore((s) => s.speakers);
  const notify = useStore((s) => s.notify);
  const patch = usePatch({ kind: 'item', id: clip.id });
  const P = (fn: (c: ClipItem) => void, m?: string) => patch((x) => fn(x as ClipItem), m);
  const at = clipAt(r, props.project.timeline, frame);
  const here = at && at.clip.id === clip.id ? at.t : null;
  const projSpeakers = speakers.filter((s) => props.project.speakers.includes(s.id));
  const regen = async () => {
    const caps = await api.autoCaptions(props.project.id, { src: clip.src, in: clip.in, out: clip.out });
    P((c) => { c.captions = caps; });
    notify(`${caps.length} sous-titres recréés`);
  };
  const addCap = () => {
    const t = here ?? clip.in;
    const c: Caption = { id: uid('c'), t0: t, t1: t + 1.2, text: 'texte', speaker: null, style: 'normal' };
    P((x) => { x.captions.push(c); x.captions.sort((a, b) => a.t0 - b.t0); });
    select({ itemId: clip.id, capId: c.id });
  };
  const goSrc = (t: number) => { const f = srcToFrame(r, clip.id, t); if (f !== null) seek(f); };
  const C = (id: string, fn: (k: Caption) => void, m?: string) => P((x) => { const k = x.captions.find((y) => y.id === id); if (k) fn(k); }, m ? `cap:${id}:${m}` : undefined);
  return (
    <Group title={tx('Sous-titres ({0})', clip.captions.length)} closed={!sel.capId}
      right={<><button className="btn sm ghost" onClick={addCap} title={tx('Ajouter à la tête de lecture')}><Icon name="plus" size={11} /></button><button className="btn sm ghost" onClick={regen} title={tx('Recréer depuis la transcription')}>{tx('Recréer')}</button></>}>
      {clip.captions.map((c) => (
        <div key={c.id} className="col" style={{ gap: 4, padding: '3px 0' }} onClick={() => select({ itemId: clip.id, capId: c.id })}>
          <div className="row" style={{ gap: 6 }}>
            <span className="mono small" style={{ cursor: 'pointer', color: 'var(--accent-hi)', width: 42 }} onClick={() => goSrc(c.t0)}>{fmt(c.t0, 1)}</span>
            <input className="input grow" style={{ color: (c.speaker && speakers.find((s) => s.id === c.speaker)?.color) || undefined }} value={c.text}
              onChange={(e) => C(c.id, (k) => { k.text = e.target.value; }, 'text')} />
            <button className="btn icon sm ghost" onClick={(e) => { e.stopPropagation(); P((x) => { x.captions = x.captions.filter((y) => y.id !== c.id); }); }}><Icon name="x" size={11} /></button>
          </div>
          {sel.capId === c.id ? (
            <div className="row wrap" style={{ gap: 4, paddingLeft: 48 }}>
              <select className="input" style={{ width: 110 }} value={c.speaker || ''} onChange={(e) => C(c.id, (k) => { k.speaker = e.target.value || null; })}>
                <option value="">{speakers.find((s) => s.id === props.project.defaultSpeaker)?.name || tx('Principale')}</option>
                {projSpeakers.filter((s) => s.id !== props.project.defaultSpeaker).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select className="input" style={{ width: 86 }} value={c.style} onChange={(e) => C(c.id, (k) => { k.style = e.target.value as Caption['style']; })}>
                <option value="normal">{tx('Normal')}</option><option value="hype">{tx('Appuyé')}</option><option value="shout">{tx('Cri')}</option>
              </select>
              <TimeInput width={66} value={c.t0} onChange={(v) => C(c.id, (k) => { k.t0 = v; })} />
              <TimeInput width={66} value={c.t1} onChange={(v) => C(c.id, (k) => { k.t1 = v; })} />
            </div>
          ) : null}
        </div>
      ))}
    </Group>
  );
}

function CardGroup({ card }: { card: CardItem }) {
  const library = useStore((s) => s.library);
  const patch = usePatch({ kind: 'item', id: card.id });
  const P = (fn: (c: CardItem) => void, m?: string) => patch((x) => fn(x as CardItem), m);
  return (
    <Group title={tx('Carton')}>
      <Row label={tx('Style')}>
        <select className="input" value={card.style} onChange={(e) => P((c) => { c.style = e.target.value as CardItem['style']; })}>
          <option value="title">{tx('Titre')}</option><option value="chapter">{tx('Chapitre')}</option><option value="narr">{tx('Texte')}</option>
          {card.style === 'logo' || card.style === 'twitch' ? <option value={card.style}>{tx('Ancien style')}</option> : null}
        </select>
      </Row>
      <BigText title={tx('Texte du carton')} value={card.text} onChange={(v) => P((c) => { c.text = v; }, 'text')} placeholder={tx('Texte (*mot* en couleur)')} />
      <Row label={tx('Sous-texte')}><input className="input" value={card.sub || ''} onChange={(e) => P((c) => { c.sub = e.target.value; }, 'sub')} /></Row>
      <Row label={tx('Fond')}><input type="color" value={card.bg || '#000000'} onChange={(e) => P((c) => { c.bg = e.target.value; }, 'bg')} /></Row>
      <Row label={tx('Texte')}><input type="color" value={card.color || '#ffffff'} onChange={(e) => P((c) => { c.color = e.target.value; }, 'color')} /></Row>
      {card.style === 'title' ? (
        <Row label={tx('Bandeau')}>
          <div className="row" style={{ gap: 6 }}>
            <label className="check"><input type="checkbox" checked={card.band !== ''} onChange={(e) => P((c) => { c.band = e.target.checked ? '#E8232A' : ''; })} /></label>
            {card.band !== '' ? <input type="color" value={card.band || '#E8232A'} onChange={(e) => P((c) => { c.band = e.target.value; }, 'band')} /> : null}
          </div>
        </Row>
      ) : null}
      <Prop label={tx('Durée')} value={card.dur} min={0.2} max={10} step={0.1} def={2} unit=" s" onChange={(v) => P((c) => { c.dur = v; }, 'dur')} />
      <Row label={tx('Sons du style')}><label className="check"><input type="checkbox" checked={card.autoSfx !== false} onChange={(e) => P((c) => { c.autoSfx = e.target.checked; })} /> {tx('automatiques')}</label></Row>
      {(card.sounds || []).map((so) => (
        <div key={so.id} className="row" style={{ gap: 6 }}>
          <select className="input grow" style={{ minWidth: 0 }} value={so.name} onChange={(e) => P((c) => { const x = (c.sounds || []).find((y) => y.id === so.id); if (x) x.name = e.target.value; })}>
            {!library?.sfx[so.name] ? <option value={so.name}>{so.name}</option> : null}
            {Object.values(library?.sfx || {}).map((x) => <option key={x.name} value={x.name}>{(x as { label?: string }).label || x.name}</option>)}
          </select>
          <input className="input mono" type="number" step={0.05} style={{ width: 70 }} value={so.at} title={tx('Décalage (s)')} onChange={(e) => P((c) => { const x = (c.sounds || []).find((y) => y.id === so.id); if (x) x.at = Number(e.target.value); }, `snd:${so.id}:at`)} />
          <input className="input mono" type="number" step={1} style={{ width: 60 }} value={so.db} title={tx('Volume (dB)')} onChange={(e) => P((c) => { const x = (c.sounds || []).find((y) => y.id === so.id); if (x) x.db = Number(e.target.value); }, `snd:${so.id}:db`)} />
          <button className="btn icon sm ghost" onClick={() => P((c) => { c.sounds = (c.sounds || []).filter((y) => y.id !== so.id); })}><Icon name="x" size={11} /></button>
        </div>
      ))}
      {library && Object.keys(library.sfx).length ? <button className="btn sm" style={{ width: 'fit-content' }} onClick={() => P((c) => { (c.sounds ||= []).push({ id: uid('s'), name: Object.keys(library.sfx)[0], at: 0, db: 0 }); })}><Icon name="plus" size={11} /> {tx('Son')}</button> : null}
    </Group>
  );
}

function FreezeGroup({ fz }: { fz: FreezeItem }) {
  const library = useStore((s) => s.library);
  const patch = usePatch({ kind: 'item', id: fz.id });
  const P = (fn: (c: FreezeItem) => void, m?: string) => patch((x) => fn(x as FreezeItem), m);
  return (
    <Group title={tx('Arrêt sur image')}>
      <Row label={tx('Image à')}><TimeInput value={fz.t} onChange={(v) => P((c) => { c.t = v; })} /></Row>
      <Prop label={tx('Durée')} value={fz.dur} min={0.2} max={10} step={0.1} def={1.5} unit=" s" onChange={(v) => P((c) => { c.dur = v; }, 'dur')} />
      <Prop label={tx('Zoom')} value={fz.scale} min={1} max={4} step={0.05} def={1.6} unit="×" onChange={(v) => P((c) => { c.scale = v; }, 'scale')} />
      <Row label={tx('Cible')}>
        <select className="input" value={Array.isArray(fz.target) ? 'xy' : fz.target} onChange={(e) => P((c) => { c.target = e.target.value === 'xy' ? [0.5, 0.5] : (e.target.value as Target); })}>
          <option value="face">{tx('Visage')}</option><option value="center">{tx('Centre')}</option><option value="xy">{tx('Point')}</option>
        </select>
      </Row>
      <Row label={tx('Son')}>
        <select className="input" value={fz.sfx || ''} onChange={(e) => P((c) => { c.sfx = e.target.value || null; })}>
          <option value="">{tx('Aucun')}</option>
          {Object.values(library?.sfx || {}).map((s) => <option key={s.name} value={s.name}>{(s as { label?: string }).label || s.name}</option>)}
        </select>
      </Row>
    </Group>
  );
}

function MediaGroup({ m }: { m: MediaItem }) {
  const patch = usePatch({ kind: 'item', id: m.id });
  const P = (fn: (c: MediaItem) => void, k?: string) => patch((x) => fn(x as MediaItem), k);
  return (
    <Group title={tx('Média')}>
      <span className="tiny dim ellipsis" title={m.path}>{m.path.split(/[\\/]/).pop()}</span>
      <Prop label={tx('Durée')} value={m.dur} min={0.2} max={60} step={0.1} def={3} unit=" s" onChange={(v) => P((c) => { c.dur = v; }, 'dur')} />
      {m.kind !== 'image' ? <Prop label={tx('Volume')} value={m.volumeDb || 0} min={-40} max={12} step={0.5} unit=" dB" onChange={(v) => P((c) => { c.volumeDb = v; }, 'vol')} /> : null}
    </Group>
  );
}

// ---------------------------------------------------------------- clip de piste libre
function ClipProps({ clip, trackName }: { clip: OClip; trackName: string }) {
  const { props } = useComp();
  const patch = usePatch({ kind: 'clip', id: clip.id });
  const P = (fn: (c: OClip) => void, m?: string) => patch((t) => fn(t as OClip), m);
  const project = props.project;
  const path = clip.type === 'video' ? (clip.src ? previewPath(project.sources.find((s) => s.id === clip.src)) : pathOf(clip.url) || clip.path) : null;
  const title = clip.type === 'text' ? clip.text.split('\n')[0] : clip.name || (path || '').split(/[\\/]/).pop() || tx('Clip');
  return (
    <>
      <Head title={title} sub={trackName} />
      <div className="pbody">
        <Group title={tx('Placement')}>
          <Row label={tx('Début / durée')}>
            <TimeInput value={clip.start} onChange={(v) => P((c) => { c.start = Math.max(0, v); })} />
            <TimeInput value={clip.dur} onChange={(v) => P((c) => { c.dur = Math.max(0.1, v); })} />
          </Row>
          {clip.type !== 'text' ? <Row label={tx('Départ fichier')}><TimeInput value={clip.in || 0} onChange={(v) => P((c) => { if (c.type !== 'text') c.in = Math.max(0, v); })} /></Row> : null}
          <Prop label={tx('Fondu entrée')} value={clip.fadeIn || 0} min={0} max={3} step={0.05} unit=" s" onChange={(v) => P((c) => { c.fadeIn = v; }, 'fin')} />
          <Prop label={tx('Fondu sortie')} value={clip.fadeOut || 0} min={0} max={3} step={0.05} unit=" s" onChange={(v) => P((c) => { c.fadeOut = v; }, 'fout')} />
          {clip.type === 'video' && clip.kind === 'video' ? <Prop label={tx('Vitesse')} value={clip.speed || 1} min={0.25} max={4} step={0.05} def={1} unit="×" onChange={(v) => P((c) => { if (c.type === 'video') c.speed = v; }, 'speed')} /> : null}
        </Group>
        {clip.type === 'text' ? <TextGroups clip={clip} /> : null}
        {clip.type === 'video' ? (
          <>
            <MotionGroups id={clip.id} look={clip.look || {}} patch={patch} chroma />
            <EffectsGroup look={clip.look || {}} patch={patch} />
            <ColorControls look={clip.look || {}} patch={patch} thumb={thumbUrl(path, clip.in || 0, 200)} closed />
          </>
        ) : null}
        {clip.type !== 'text' ? (
          <Group title={tx('Audio')}>
            <Prop label={tx('Volume')} value={clip.volumeDb || 0} min={-40} max={12} step={0.5} unit=" dB" onChange={(v) => P((c) => { if (c.type !== 'text') c.volumeDb = v; }, 'vol')} />
            {clip.type === 'video' ? <Row label={tx('Son')}><label className="check"><input type="checkbox" checked={!!clip.muted} onChange={(e) => P((c) => { if (c.type === 'video') c.muted = e.target.checked; })} /> {tx('couper')}</label></Row> : null}
            {clip.type === 'audio' ? <Row label={tx('Sous la voix')}><label className="check"><input type="checkbox" checked={!!clip.duck} onChange={(e) => P((c) => { if (c.type === 'audio') c.duck = e.target.checked; })} /> {tx('baisser automatiquement')}</label></Row> : null}
          </Group>
        ) : null}
      </div>
    </>
  );
}

function TextGroups({ clip }: { clip: OText }) {
  const patch = usePatch({ kind: 'clip', id: clip.id });
  const S = (fn: (s: TextStyle) => void, f: string) => patch((t) => fn((t as OText).style), `txt:${f}`);
  const st = clip.style;
  return (
    <>
      <Group title={tx('Texte')}>
        <BigText title={tx('Texte')} value={clip.text} onChange={(v) => patch((t) => { (t as OText).text = v; }, 'text')} />
        <Row label={tx('Police')}>
          <select className="input" value={st.font} onChange={(e) => S((s) => { s.font = e.target.value; }, 'font')}>{FONTS_LIST.map((f) => <option key={f}>{f}</option>)}</select>
        </Row>
        <Prop label={tx('Taille')} value={st.size} min={16} max={320} onChange={(v) => S((s) => { s.size = v; }, 'size')} />
        <Prop label={tx('Graisse')} value={st.weight} min={400} max={900} step={100} def={800} onChange={(v) => S((s) => { s.weight = v; }, 'w')} />
        <Row label={tx('Couleur')}>
          <input type="color" value={st.color} onChange={(e) => S((s) => { s.color = e.target.value; }, 'color')} />
          <button className={`btn sm ${st.uppercase ? 'on' : ''}`} onClick={() => S((s) => { s.uppercase = !s.uppercase; }, 'up')} title={tx('Majuscules')}>AA</button>
          <button className={`btn sm ${st.italic ? 'on' : ''}`} onClick={() => S((s) => { s.italic = !s.italic; }, 'it')} title={tx('Italique')}><i>I</i></button>
          <button className={`btn sm ${st.shadow ? 'on' : ''}`} onClick={() => S((s) => { s.shadow = !s.shadow; }, 'sh')}>{tx('Ombre')}</button>
        </Row>
        <Prop label={tx('Contour')} value={st.stroke} min={0} max={30} step={0.5} onChange={(v) => S((s) => { s.stroke = v; }, 'stroke')} />
        <Row label={tx('Couleur contour')}><input type="color" value={st.strokeColor} onChange={(e) => S((s) => { s.strokeColor = e.target.value; }, 'sc')} /></Row>
        <Row label={tx('Fond')}>
          <input type="checkbox" checked={!!st.bg} onChange={(e) => S((s) => { s.bg = e.target.checked ? '#000000' : null; }, 'bgon')} />
          {st.bg ? <input type="color" value={st.bg.startsWith('#') ? st.bg : '#000000'} onChange={(e) => S((s) => { s.bg = e.target.value; }, 'bg')} /> : null}
        </Row>
      </Group>
      <Group title={tx('Position et animation')}>
        <Prop label={tx('Position X')} value={Math.round(st.x * 100)} min={0} max={100} def={50} unit="%" onChange={(v) => S((s) => { s.x = v / 100; }, 'x')} />
        <Prop label={tx('Position Y')} value={Math.round(st.y * 100)} min={0} max={100} def={50} unit="%" onChange={(v) => S((s) => { s.y = v / 100; }, 'y')} />
        <Prop label={tx('Rotation')} value={st.rotation || 0} min={-45} max={45} unit="°" onChange={(v) => S((s) => { s.rotation = v; }, 'rot')} />
        <Row label={tx('Alignement')}><Seg value={st.align} options={[['left', tx('Gauche')], ['center', tx('Centre')], ['right', tx('Droite')]]} onChange={(v) => S((s) => { s.align = v; }, 'al')} /></Row>
        <Row label={tx('Animation')}>
          <select className="input" value={st.anim} onChange={(e) => S((s) => { s.anim = e.target.value as TextStyle['anim']; }, 'anim')}>
            <option value="pop">{tx('Pop')}</option><option value="fade">{tx('Fondu')}</option><option value="slide">{tx('Glissé')}</option><option value="type">{tx('Machine à écrire')}</option><option value="none">{tx('Aucune')}</option>
          </select>
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- musique de fond
function MusicProps({ id }: { id: string }) {
  const { props } = useComp();
  const update = useStore((s) => s.update);
  const library = useStore((s) => s.library);
  const m = props.project.music.find((x) => x.id === id)!;
  const P = (fn: (c: typeof m) => void, merge?: string) => update((p) => { const x = p.music.find((y) => y.id === id); if (x) fn(x); }, merge ? `music:${id}:${merge}` : undefined);
  const items = props.project.timeline;
  const name = (it: Item, i: number) => `${i + 1}. ${it.type === 'clip' ? it.label || fmt(it.in, 0) : it.type === 'card' ? it.text.split('\n')[0] : it.type}`;
  return (
    <>
      <Head title={tx('Musique')} sub={m.name} />
      <div className="pbody">
        <Group title={tx('Morceau')}>
          <select className="input" value={m.name} onChange={(e) => { const t = library?.music.find((x) => x.name === e.target.value); if (t) P((c) => { c.name = t.name; c.url = t.url; c.gainDb = t.gainDb; }); }}>
            {!library?.music.find((t) => t.name === m.name) ? <option value={m.name}>{m.name}</option> : null}
            {(library?.music || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
          <Prop label={tx('Volume')} value={m.db} min={-40} max={6} step={0.5} unit=" dB" onChange={(v) => P((c) => { c.db = v; }, 'db')} />
          <Prop label={tx('Départ morceau')} value={m.offset || 0} min={0} max={300} step={0.5} unit=" s" onChange={(v) => P((c) => { c.offset = v; }, 'off')} />
        </Group>
        <Group title={tx('Étendue')}>
          <Row label={tx('De')}><select className="input" value={m.fromItem} onChange={(e) => P((c) => { c.fromItem = e.target.value; })}>{items.map((it, i) => <option key={it.id} value={it.id}>{name(it, i)}</option>)}</select></Row>
          <Row label={tx('À')}><select className="input" value={m.toItem} onChange={(e) => P((c) => { c.toItem = e.target.value; })}>{items.map((it, i) => <option key={it.id} value={it.id}>{name(it, i)}</option>)}</select></Row>
        </Group>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- projet (rien de sélectionné)
const SEQ_FORMATS: [string, string][] = [
  ['1920x1080', '16:9 · 1920×1080'], ['3840x2160', '16:9 · 3840×2160'], ['1280x720', '16:9 · 1280×720'], ['1080x1920', '9:16 · 1080×1920'],
  ['1080x1080', '1:1 · 1080×1080'], ['1080x1350', '4:5 · 1080×1350'], ['1440x1080', '4:3 · 1440×1080'], ['2048x858', '2.39:1 · 2048×858'],
];

function ProjectProps() {
  const { props, r } = useComp();
  const p = props.project;
  const update = useStore((s) => s.update);
  const packs = useStore((s) => s.packs);
  const speakers = useStore((s) => s.speakers);
  const [gloss, setGloss] = useState(Object.entries(p.glossary || {}).map(([k, v]) => `${k} = ${v}`).join('\n'));
  const mix = p.mix || {};
  const M = (k: 'voiceDb' | 'musicDb' | 'sfxDb', v: number) => update((x) => { x.mix = { ...(x.mix || {}), [k]: v }; }, `mix:${k}`);
  const setPack = (id: string) => {
    const pk = packs.find((x) => x.id === id);
    if (!pk) return;
    const change = (pk.format.width !== p.format.width || pk.format.height !== p.format.height) && confirm(tx('Le style « {0} » est en {1}×{2}. Changer aussi le format du projet ?', pk.name, pk.format.width, pk.format.height));
    update((x) => { x.packId = id; if (change) x.format = { ...pk.format }; });
  };
  const fmtKey = `${p.format.width}x${p.format.height}`;
  const custom = !SEQ_FORMATS.some(([v]) => v === fmtKey);
  return (
    <>
      <div className="toolbar"><b style={{ paddingLeft: 4 }}>{tx('Projet')}</b><span className="spacer" /><span className="small dim">{p.format.width}×{p.format.height} · {p.format.fps} i/s · {fmt(r.duration / r.fps, 0)}</span></div>
      <div className="pbody">
        <Group title={tx('Général')}>
          <Row label={tx('Nom')}><input className="input" value={p.name} onChange={(e) => update((x) => { x.name = e.target.value; }, 'name')} /></Row>
          <Row label={tx('Titre vidéo')}><input className="input" value={p.title} placeholder={tx('Fil rouge pour l\'IA')} onChange={(e) => update((x) => { x.title = e.target.value; }, 'title')} /></Row>
          <Row label={tx('Style')}>
            <select className="input" value={p.packId} onChange={(e) => setPack(e.target.value)}>{packs.map((pk) => <option key={pk.id} value={pk.id}>{pk.name}</option>)}</select>
          </Row>
        </Group>
        <Group title={tx('Séquence')}>
          <Row label={tx('Format')}>
            <select className="input" value={custom ? 'custom' : fmtKey} onChange={(e) => { if (e.target.value === 'custom') return; const [w, h] = e.target.value.split('x').map(Number); update((x) => { x.format = { ...x.format, width: w, height: h }; }); }}>
              {SEQ_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="custom">{custom ? tx('Personnalisé · {0}×{1}', p.format.width, p.format.height) : tx('Personnalisé…')}</option>
            </select>
          </Row>
          <Row label={tx('Taille')}>
            <div className="row" style={{ gap: 4 }}>
              <input className="input" type="number" min={16} step={2} style={{ width: 70 }} value={p.format.width} onChange={(e) => { const v = Math.round(Number(e.target.value) / 2) * 2; if (v >= 16) update((x) => { x.format = { ...x.format, width: v }; }, 'fmt:w'); }} />
              <span className="dim">×</span>
              <input className="input" type="number" min={16} step={2} style={{ width: 70 }} value={p.format.height} onChange={(e) => { const v = Math.round(Number(e.target.value) / 2) * 2; if (v >= 16) update((x) => { x.format = { ...x.format, height: v }; }, 'fmt:h'); }} />
            </div>
          </Row>
          <Row label={tx('Images / s')}>
            <select className="input" value={p.format.fps} onChange={(e) => update((x) => { x.format = { ...x.format, fps: Number(e.target.value) }; })}>
              {[...new Set([24, 25, 30, 50, 60, p.format.fps])].sort((a, b) => a - b).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Row>
        </Group>
        <Group title={tx('Consignes pour l\'assistant')}>
          <BigText title={tx('Consignes pour l\'assistant')} minHeight={90} value={p.preferences} onChange={(v) => update((x) => { x.preferences = v; }, 'prefs')}
            placeholder={tx('ex. 8 minutes max ; garder l\'intro en entier ; ton calme')} />
        </Group>
        <Group title={tx('Mixage')}>
          <Prop label={tx('Voix')} value={mix.voiceDb || 0} min={-30} max={12} step={0.5} unit=" dB" onChange={(v) => M('voiceDb', v)} />
          <Prop label={tx('Musique')} value={mix.musicDb || 0} min={-30} max={12} step={0.5} unit=" dB" onChange={(v) => M('musicDb', v)} />
          <Prop label={tx('Bruitages')} value={mix.sfxDb || 0} min={-30} max={12} step={0.5} unit=" dB" onChange={(v) => M('sfxDb', v)} />
        </Group>
        <Group title={tx('Personnes')} closed={!speakers.length}>
          {speakers.length === 0 ? <a className="small" href="#/personnes">{tx('Ajouter des personnes')}</a> : (
            <>
              <div className="row wrap" style={{ gap: 10 }}>
                {speakers.map((s) => (
                  <label key={s.id} className="check">
                    <input type="checkbox" checked={p.speakers.includes(s.id)} onChange={(e) => update((x) => { x.speakers = e.target.checked ? [...x.speakers, s.id] : x.speakers.filter((y) => y !== s.id); })} />
                    <span className="dot" style={{ background: s.color }} />{s.name}
                  </label>
                ))}
              </div>
              <Row label={tx('Principale')}>
                <select className="input" value={p.defaultSpeaker || ''} onChange={(e) => update((x) => { x.defaultSpeaker = e.target.value || null; })}>
                  <option value="">{tx('Aucune')}</option>
                  {p.speakers.map((id) => <option key={id} value={id}>{speakers.find((s) => s.id === id)?.name || id}</option>)}
                </select>
              </Row>
            </>
          )}
        </Group>
        <Group title={tx('Glossaire de transcription')} closed>
          <textarea className="input mono" value={gloss} onChange={(e) => setGloss(e.target.value)} placeholder={tx('mot mal entendu = bonne orthographe')}
            onBlur={() => update((x) => { x.glossary = Object.fromEntries(gloss.split('\n').map((l) => l.split('=').map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1])); })} />
        </Group>
      </div>
    </>
  );
}

/** cible des réglages de couleur : sélection, sinon plan sous la tête de lecture */
export function colorTarget(p: Project, sel: { itemId?: string; clipId?: string }, r: ReturnType<typeof useComp>['r']): Ref | null {
  if (sel.clipId) return { kind: 'clip', id: sel.clipId };
  if (sel.itemId) return { kind: 'item', id: sel.itemId };
  const at = clipAt(r, p.timeline, getFrame());
  return at ? { kind: 'item', id: at.clip.id } : null;
}

// ---------------------------------------------------------------- effets d'image empilés
export function EffectsGroup({ look, patch }: { look: Look; patch: Patch }) {
  const list = look.effects || [];
  const E = (fn: (fx: VFx[]) => void, merge?: string) => patch((t) => { const tt = t as { look?: Look }; tt.look = tt.look || {}; tt.look.effects = [...(tt.look.effects || [])]; fn(tt.look.effects); }, merge);
  const P = (id: string, fn: (e: VFx) => void, merge?: string) => E((fx) => { const i = fx.findIndex((e) => e.id === id); if (i >= 0) { fx[i] = { ...fx[i], p: { ...fx[i].p } }; fn(fx[i]); } }, merge ? `vfx:${id}:${merge}` : undefined);
  const move = (id: string, d: number) => E((fx) => { const i = fx.findIndex((e) => e.id === id); const j = i + d; if (i < 0 || j < 0 || j >= fx.length) return; [fx[i], fx[j]] = [fx[j], fx[i]]; });
  return (
    <Group title={`Effets${list.length ? ` (${list.length})` : ''}`}
      right={<>
        <Dropdown align="right" width={230} button={(_, t) => <button className="btn sm ghost" onClick={t} title={tx('Ajouter un effet')}><Icon name="plus" size={12} /> {tx('Ajouter')}</button>}>
          {(close) => FX_CATS.map(([cat, label]) => (
            <div key={cat} className="col" style={{ gap: 0 }}>
              <div className="label">{tx(label)}</div>
              {FX_DEFS.filter((d) => d.cat === cat).map((d) => <button key={d.kind} onClick={() => { close(); E((fx) => { fx.push(newFx(d.kind)); }); }}><Icon name={d.icon} size={13} /> {tx(d.label)}</button>)}
            </div>
          ))}
        </Dropdown>
        <button className="btn icon sm ghost" title={tx('Enregistrer ces réglages dans Mes effets')} onClick={() => savePreset(look)}><Icon name="download" size={12} /></button>
      </>}>
      {list.length === 0 ? <span className="small dim">{tx('Aucun effet. « Ajouter », ou glisse un effet depuis le panneau Effets.')}</span> : null}
      {list.map((e, i) => {
        const d = FX_DEFS.find((x) => x.kind === e.kind);
        if (!d) return null;
        return (
          <div key={e.id} className="fx-item">
            <div className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={e.on !== false} onChange={(ev) => P(e.id, (x) => { x.on = ev.target.checked; })} title={tx('Activer / désactiver')} />
              <b className="grow ellipsis" style={{ opacity: e.on === false ? 0.5 : 1 }}>{tx(d.label)}</b>
              <button className="btn icon sm ghost" disabled={i === 0} onClick={() => move(e.id, -1)} title={tx('Monter')}><Icon name="chev" size={11} style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="btn icon sm ghost" disabled={i === list.length - 1} onClick={() => move(e.id, 1)} title={tx('Descendre')}><Icon name="chev" size={11} /></button>
              <button className="btn icon sm ghost" onClick={() => P(e.id, (x) => { x.p = { ...Object.fromEntries(fxDef(x.kind).params.map((q) => [q.key, q.def])) }; })} title={tx('Valeurs par défaut')}><Icon name="undo" size={11} /></button>
              <button className="btn icon sm ghost" onClick={() => E((fx) => { fx.splice(fx.findIndex((x) => x.id === e.id), 1); })} title={tx('Retirer')}><Icon name="x" size={11} /></button>
            </div>
            {e.on === false ? null : d.params.map((q) => q.options ? (
              <Row key={q.key} label={tx(q.label)}>
                <select className="input" value={String(e.p[q.key] ?? q.def)} onChange={(ev) => P(e.id, (x) => { x.p[q.key] = ev.target.value; })}>
                  {q.options.map(([v, l]) => <option key={v} value={v}>{tx(l)}</option>)}
                </select>
              </Row>
            ) : q.color ? (
              <Row key={q.key} label={tx(q.label)}><input type="color" value={String(e.p[q.key] ?? q.def)} onChange={(ev) => P(e.id, (x) => { x.p[q.key] = ev.target.value; }, q.key)} /></Row>
            ) : (
              <Prop key={q.key} label={tx(q.label)} value={Number(e.p[q.key] ?? q.def)} min={q.min ?? 0} max={q.max ?? 100} step={q.step ?? 1} def={Number(q.def)} unit={q.unit || ''}
                onChange={(v) => P(e.id, (x) => { x.p[q.key] = v; }, q.key)} />
            ))}
          </div>
        );
      })}
    </Group>
  );
}
