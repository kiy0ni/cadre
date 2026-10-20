// Actions d'édition partagées par la timeline, les moniteurs, les raccourcis clavier et le menu de l'appli de bureau.
import { api } from '../lib/api';
import { getFrame, getPlayer, uid, useStore } from '../lib/store';
import type { ClipItem, CompositionProps, EffectPreset, Item, Look, OClip, Project, Track, VFxKind } from '../types';
import { fxDef, newFx } from '../remotion/effects';
import { tx } from '../lib/i18n';
import { frameToSrc, resolve } from '../remotion/resolve';
import { clipAt } from './comp';

export function currentResolved() {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return null;
  const pack = st.packs.find((x) => x.id === p.packId);
  return resolve({
    project: p, words: st.words, pack: { id: p.packId, style: pack?.style || ({} as CompositionProps['pack']['style']) },
    speakers: Object.fromEntries(st.speakers.map((s) => [s.id, { name: s.name, color: s.color }])), sfx: st.library?.sfx || {}, mode: 'preview',
  });
}

export function removeItems(p: Project, ids: string[]) {
  p.timeline = p.timeline.filter((x) => !ids.includes(x.id));
  const left = new Set(p.timeline.map((x) => x.id));
  p.music = p.music.filter((m) => left.has(m.fromItem) && left.has(m.toItem));
}

/** coupe à l'image f : le clip de piste sélectionné s'il est sous la tête, sinon le plan V1 */
export function splitAt(f: number): boolean {
  const st = useStore.getState();
  const p = st.project;
  const r = currentResolved();
  if (!p || !r) return false;
  const t = f / r.fps;
  for (const tr of p.tracks || []) {
    for (const c of tr.clips) {
      if (tr.locked || t <= c.start + 0.05 || t >= c.start + c.dur - 0.05) continue;
      if (st.sel.clipId && st.sel.clipId !== c.id) continue;
      st.update((pp) => {
        const T = (pp.tracks || []).find((x) => x.id === tr.id)!;
        const a = T.clips.find((x) => x.id === c.id)!;
        const b = { ...structuredClone(a), id: uid('o') };
        const d = t - a.start;
        a.dur = d;
        b.start = t;
        b.dur = c.dur - d;
        if (b.type !== 'text') b.in = (b.in || 0) + d * (b.type === 'video' && b.speed ? b.speed : 1);
        T.clips.push(b);
      }, undefined, tx('Coupe'));
      return true;
    }
  }
  const hit = frameToSrc(r, f);
  if (!hit || hit.t === null) return false;
  const it = p.timeline.find((x) => x.id === hit.itemId);
  if (!it || it.type !== 'clip') return false;
  const at = hit.t;
  if (at <= it.in + 0.05 || at >= it.out - 0.05) return false;
  st.update((pp) => {
    const i = pp.timeline.findIndex((k) => k.id === it.id);
    const a = pp.timeline[i] as ClipItem;
    const b: ClipItem = { ...structuredClone(a), id: uid('i'), in: at, label: '', transition: null };
    b.captions = a.captions.filter((c) => c.t0 >= at).map((c) => ({ ...c, id: uid('c') }));
    b.fx = a.fx.filter((fx) => ('t' in fx ? fx.t : fx.t0) >= at).map((fx) => ({ ...fx, id: uid('f') }));
    a.out = at;
    a.captions = a.captions.filter((c) => c.t0 < at);
    a.fx = a.fx.filter((fx) => ('t' in fx ? fx.t : fx.t0) < at);
    pp.timeline.splice(i + 1, 0, b);
  }, undefined, tx('Coupe'));
  return true;
}

/** supprime ce qui est sélectionné (clip de piste, sous-titre, musique, élément du montage) */
export function deleteSelection() {
  const st = useStore.getState();
  const s = st.sel;
  if (s.clipId) {
    st.update((p) => { for (const tr of p.tracks || []) tr.clips = tr.clips.filter((c) => c.id !== s.clipId); }, undefined, tx('Suppression'));
  } else if (s.capId && s.itemId) {
    st.update((x) => { const c = x.timeline.find((i) => i.id === s.itemId) as ClipItem | undefined; if (c) c.captions = c.captions.filter((k) => k.id !== s.capId); }, undefined, tx('Suppression'));
    st.select({ itemId: s.itemId });
    return;
  } else if (s.musicId) {
    st.update((x) => { x.music = x.music.filter((m) => m.id !== s.musicId); }, undefined, tx('Suppression'));
  } else if (s.itemId) {
    const id = s.itemId;
    st.update((x) => removeItems(x, [id]));
  } else return;
  st.select({});
}

/** colle un clip dupliqué juste après lui-même */
export function duplicateSelection() {
  const st = useStore.getState();
  const s = st.sel;
  if (s.clipId) {
    st.update((p) => {
      for (const tr of p.tracks || []) {
        const c = tr.clips.find((x) => x.id === s.clipId);
        if (c) tr.clips.push({ ...structuredClone(c), id: uid('o'), start: c.start + c.dur });
      }
    }, undefined, tx('Duplication'));
  } else if (s.itemId) {
    st.update((p) => {
      const j = p.timeline.findIndex((x) => x.id === s.itemId);
      if (j < 0) return;
      const c = structuredClone(p.timeline[j]);
      c.id = uid('i');
      if (c.type === 'clip') { c.captions.forEach((x) => { x.id = uid('c'); }); c.fx.forEach((x) => { x.id = uid('f'); }); }
      p.timeline.splice(j + 1, 0, c);
    }, undefined, tx('Duplication'));
  }
}

export function addMarker() {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return;
  st.update((x) => { (x.markers ||= []).push({ id: uid('k'), t: getFrame() / p.format.fps, label: '' }); }, undefined, tx('Marqueur'));
}

/** zoom sec sur le visage à la tête de lecture */
export function zoomHere() {
  const st = useStore.getState();
  const p = st.project;
  const r = currentResolved();
  const at = p && r ? clipAt(r, p.timeline, getFrame()) : null;
  if (!p || !at) { st.notify(tx('Place la tête de lecture dans un plan.')); return; }
  const pk = st.packs.find((x) => x.id === p.packId);
  st.update((x) => { const c = x.timeline.find((i) => i.id === at.clip.id) as ClipItem; c.fx.push({ id: uid('f'), kind: 'zoom', t0: at.t, t1: at.t + 1.2, target: 'face', scale: pk?.style?.zoom?.face || 1.6 }); }, undefined, tx('Zoom'));
  st.notify(tx('Zoom posé'));
}

/** coupe précédente / suivante */
export function jumpEdit(d: 1 | -1) {
  const st = useStore.getState();
  const r = currentResolved();
  if (!r) return;
  const f = getFrame();
  const edges = [...new Set([0, ...r.items.map((i) => i.from), ...(st.project?.tracks || []).flatMap((t) => t.clips.flatMap((c) => [Math.round(c.start * r.fps), Math.round((c.start + c.dur) * r.fps)])), r.duration - 1])].sort((a, b) => a - b);
  const t = d > 0 ? edges.find((x) => x > f + 1) : [...edges].reverse().find((x) => x < f - 1);
  if (t !== undefined) st.seek(t);
}

/** plan V1 depuis une source [a, b] : inséré à la tête de lecture ou ajouté à la fin */
export function insertSource(srcId: string, a: number, b: number, where: 'playhead' | 'end' = 'playhead') {
  const st = useStore.getState();
  const p = st.project;
  const r = currentResolved();
  const src = p?.sources.find((s) => s.id === srcId);
  if (!p || !r || !src) return;
  const f = getFrame();
  let idx = p.timeline.length;
  if (where === 'playhead') {
    const k = r.items.findIndex((it) => f < it.from + it.dur / 2);
    if (k >= 0) idx = p.timeline.findIndex((x) => x.id === r.items[k].id);
  }
  const clip: ClipItem = { id: uid('i'), type: 'clip', src: src.id, in: a, out: b, label: '', jump: null, speed: 1, captions: [], fx: [] };
  st.update((pp) => { pp.timeline.splice(idx < 0 ? pp.timeline.length : idx, 0, clip); }, undefined, tx('Insertion'));
  st.select({ itemId: clip.id });
  api.autoCaptions(p.id, { src: src.id, in: a, out: b }).then((caps) => {
    if (caps.length) useStore.getState().update((pp) => { const c = pp.timeline.find((x) => x.id === clip.id) as ClipItem | undefined; if (c) c.captions = caps; }, 'caps:auto');
  }).catch(() => undefined);
}

/** piste d'une ligne A1 Voix / A2 Musique / A3 Bruitages (créée au besoin) */
export function roleTrack(p: Project, role: NonNullable<Track['role']>): Track {
  const list = p.tracks || (p.tracks = []);
  let tr = list.find((x) => x.role === role);
  if (!tr) {
    tr = { id: uid('t'), kind: 'audio', role, name: role === 'voice' ? tx('Voix') : role === 'music' ? tx('Musique') : tx('Bruitages'), clips: [] };
    list.push(tr);
  }
  return tr;
}

/** clip sur une piste libre (incrustation / titre / audio) ; crée la piste au besoin. role : ligne Voix / Musique / Bruitages */
export function addToTrack(kind: Track['kind'], clip: OClip, trackId?: string | null, role?: Track['role']) {
  const st = useStore.getState();
  let tid = '';
  st.update((p) => {
    const list = p.tracks || (p.tracks = []);
    let tr = role ? roleTrack(p, role) : trackId ? list.find((x) => x.id === trackId) : list.find((x) => x.kind === kind && !x.locked && !x.role);
    if (!tr) {
      const n = list.filter((x) => x.kind === kind && !x.role).length + 1;
      tr = { id: uid('t'), kind, name: kind === 'video' ? `${tx('Vidéo')} ${n + 1}` : kind === 'text' ? `${tx('Titres')} ${n}` : `${tx('Audio')} ${n + 3}`, clips: [] };
      if (kind === 'audio') list.push(tr); else list.unshift(tr);
    }
    tid = tr.id;
    tr.clips.push(clip);
  }, undefined, tx('Ajout sur une piste'));
  st.select({ clipId: clip.id, trackId: tid });
}

/** source en incrustation (ou piste audio) à la tête de lecture */
export function overlaySource(srcId: string, a: number, b: number) {
  const st = useStore.getState();
  const p = st.project;
  const s = p?.sources.find((x) => x.id === srcId);
  if (!p || !s) return;
  const t = getFrame() / p.format.fps;
  if (s.kind === 'audio') addToTrack('audio', { id: uid('o'), type: 'audio', src: s.id, start: t, dur: Math.max(0.2, b - a), in: a, volumeDb: 0, name: s.name });
  else addToTrack('video', { id: uid('o'), type: 'video', src: s.id, kind: s.kind === 'image' ? 'image' : 'video', start: t, dur: s.kind === 'image' ? 3 : Math.max(0.2, b - a), in: a, name: s.name, look: {} });
}

export async function startExport(preset: string) {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return;
  try {
    await api.saveProject(p);
    const { job } = await api.render(p.id, preset);
    st.watchJob(job);
    st.notify(tx('Export lancé'));
  } catch (e) { st.notify(tx('Export impossible : {0}', (e as Error).message)); }
}

export const togglePlay = () => getPlayer()?.toggle();

// ---------------------------------------------------------------- effets d'image
export type TargetRef = { kind: 'item'; id: string } | { kind: 'clip'; id: string };

/** cible des effets : sélection, sinon élément du montage sous la tête de lecture */
export function effectTarget(): TargetRef | null {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return null;
  if (st.sel.clipId) return { kind: 'clip', id: st.sel.clipId };
  if (st.sel.itemId) return { kind: 'item', id: st.sel.itemId };
  const r = currentResolved();
  const f = getFrame();
  const it = r?.items.find((x) => f >= x.from && f < x.from + x.dur);
  return it ? { kind: 'item', id: it.id } : null;
}

function findTarget(p: Project, ref: TargetRef): Item | OClip | null {
  if (ref.kind === 'item') return p.timeline.find((x) => x.id === ref.id) || null;
  for (const tr of p.tracks || []) { const c = tr.clips.find((x) => x.id === ref.id); if (c) return c; }
  return null;
}

function canLook(t: Item | OClip | null): t is Item & { look?: Look } | OClip & { look?: Look } {
  return !!t && t.type !== 'card' && t.type !== 'text' && t.type !== 'audio';
}

export function applyEffect(kind: VFxKind, ref: TargetRef | null = effectTarget()) {
  const st = useStore.getState();
  if (!ref) { st.notify(tx('Sélectionne un plan ou un clip')); return; }
  const t = st.project ? findTarget(st.project, ref) : null;
  if (!canLook(t)) { st.notify(tx('Cet élément ne prend pas d’effets d’image')); return; }
  st.update((p) => { const x = findTarget(p, ref) as { look?: Look }; x.look = x.look || {}; (x.look.effects ||= []).push(newFx(kind)); }, undefined, fxDef(kind).label);
  st.select(ref.kind === 'item' ? { itemId: ref.id } : { clipId: ref.id });
  st.setUi({ upperTab: 'props' });
}

export function applyPreset(pr: EffectPreset, ref: TargetRef | null = effectTarget()) {
  const st = useStore.getState();
  if (!ref) { st.notify(tx('Sélectionne un plan ou un clip')); return; }
  const t = st.project ? findTarget(st.project, ref) : null;
  if (!canLook(t)) { st.notify(tx('Cet élément ne prend pas d’effets d’image')); return; }
  st.update((p) => {
    const x = findTarget(p, ref) as { look?: Look };
    const l = structuredClone(pr.look);
    x.look = { ...(x.look || {}), ...l, effects: [...(x.look?.effects || []), ...(l.effects || []).map((e) => ({ ...e, id: newFx(e.kind).id }))] };
  }, undefined, pr.name);
  st.select(ref.kind === 'item' ? { itemId: ref.id } : { clipId: ref.id });
}

/** enregistre les réglages d'image d'un élément comme « mon effet » */
export async function savePreset(look: Look) {
  const st = useStore.getState();
  const name = prompt(tx('Nom de l’effet'));
  if (!name) return;
  const keep: Look = {};
  if (look.effects?.length) keep.effects = look.effects;
  if (look.color) keep.color = look.color;
  if (look.opacity !== undefined) keep.opacity = look.opacity;
  if (look.blend) keep.blend = look.blend;
  if (look.chroma) keep.chroma = look.chroma;
  if (!Object.keys(keep).length) { st.notify(tx('Rien à enregistrer : ajoute des effets ou une correction de couleur')); return; }
  try {
    await api.savePreset(name, keep);
    useStore.setState({ presets: await api.presets() });
    st.notify(tx('« {0} » ajouté à Mes effets', name));
  } catch (e) { st.notify((e as Error).message); }
}

// ---------------------------------------------------------------- presse-papiers (⌘C / ⌘X / ⌘V)
let clipboard: { kind: 'clip'; clip: OClip; trackKind: Track['kind']; role?: Track['role'] } | { kind: 'item'; item: Item } | null = null;

export function copySelection(cut = false) {
  const st = useStore.getState();
  const p = st.project;
  if (!p) return false;
  if (st.sel.clipId) {
    for (const tr of p.tracks || []) {
      const c = tr.clips.find((x) => x.id === st.sel.clipId);
      if (c) { clipboard = { kind: 'clip', clip: structuredClone(c), trackKind: tr.kind, role: tr.role }; break; }
    }
  } else if (st.sel.itemId) {
    const it = p.timeline.find((x) => x.id === st.sel.itemId);
    if (it) clipboard = { kind: 'item', item: structuredClone(it) };
  } else return false;
  if (cut) deleteSelection();
  st.notify(cut ? tx('Coupé') : tx('Copié'));
  return true;
}

/** colle à la tête de lecture : clip de piste à cet instant (même piste), élément du montage à cet endroit */
export function pasteAtPlayhead() {
  const st = useStore.getState();
  const p = st.project;
  const r = currentResolved();
  if (!p || !r || !clipboard) return false;
  const f = getFrame();
  if (clipboard.kind === 'clip') {
    const c = { ...structuredClone(clipboard.clip), id: uid('o'), start: f / r.fps };
    const sel = (p.tracks || []).find((x) => x.clips.some((y) => y.id === st.sel.clipId) && clipboard?.kind === 'clip' && x.kind === clipboard.trackKind);
    addToTrack(clipboard.trackKind, c, sel?.id, sel ? undefined : clipboard.role);
  } else {
    const it = structuredClone(clipboard.item);
    it.id = uid('i');
    if (it.type === 'clip') { it.captions.forEach((x) => { x.id = uid('c'); }); it.fx.forEach((x) => { x.id = uid('f'); }); }
    const k = r.items.findIndex((x) => f < x.from + x.dur / 2);
    st.update((pp) => {
      const idx = k >= 0 ? pp.timeline.findIndex((x) => x.id === r.items[k].id) : pp.timeline.length;
      pp.timeline.splice(idx < 0 ? pp.timeline.length : idx, 0, it);
    }, undefined, tx('Coller'));
    st.select({ itemId: it.id });
  }
  return true;
}
export const hasClipboard = () => !!clipboard;
