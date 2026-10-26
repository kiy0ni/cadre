// Multitrack timeline: video / title tracks above the V1 edit, subtitles, effects, audio lanes A1 Voice /
// A2 Music / A3 Sound effects (which also accept audio clips), free audio tracks. Select / razor tools,
// snapping, drag and drop from the panels, wheel zoom, right-click menus.
// Dragging: 4 px threshold before moving (a click moves nothing), pointer capture, one update per frame,
// Esc cancels, ⌥ duplicates. V1 shots can be placed freely (empty gap before), ⌘ = insert between two shots
// (yellow marker), dragged onto a video track they become overlays (and vice versa).
// The playhead is moved directly in the DOM (no React render on every frame).
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getFrame, onFrame, uid, useStore } from '../lib/store';
import { ruler, tc } from '../lib/format';
import { Icon } from '../lib/icons';
import { contextMenu, Dropdown, type MenuItem } from '../lib/ui';
import { tx } from '../lib/i18n';
import { pathOf, previewPath, spriteCell, usePeaks, usePeaksMany, useSpritesMany, type Peaks } from '../lib/previews';
import type { Caption, ClipItem, Fx, Item, OClip, Project, TextStyle, Track, TransitionKind } from '../types';
import { frameToSrc, srcToFrame, type Resolved } from '../remotion/resolve';
import { api } from '../lib/api';
import { useComp } from './comp';
import { addMarker, applyEffect, applyPreset, copySelection, deleteSelection, duplicateSelection, hasClipboard, isUnlinked, pasteAtPlayhead, relinkAudio, roleTrack, splitAt, unlinkAudio, type TargetRef } from './actions';
import { focusAssistant, timelineCtl } from './shortcuts';
import { getPrefs, usePrefs } from '../lib/prefs';

type RoleKind = 'voice' | 'music' | 'sfx';
type Row =
  | { key: string; kind: 'track'; tr: Track; h: number; tid: string }
  | { key: string; kind: 'v1' | 'captions' | 'fx'; h: number; tid: string }
  | { key: string; kind: RoleKind; h: number; tid: string; tr?: Track };

type Drag =
  | { mode: 'scrub' }
  | { mode: 'clip'; sid: string; op: 'move' | 'trimL' | 'trimR'; clipId: string; trackId: string; x0: number; y0: number; start0: number; dur0: number; in0: number; active: boolean; alt: boolean;
      toV1?: number | null }
  | { mode: 'trim'; sid: string; id: string; side: 'in' | 'out' | 'dur'; x0: number; v0: number; rate: number; active: boolean }
  // V1 shot: free placement (gap before the shot), ⌘ or left of the previous shot = insert elsewhere, onto a video track = overlay
  | { mode: 'reorder'; sid: string; id: string; x0: number; y0: number; active: boolean; idx: number | null; seekT: number; start0: number; dur: number;
      before0: number; nextId: string | null; nextBefore0: number; changed: boolean; toTrack: string | null }
  // shot effect or subtitle: time in source seconds (t0..t1), a0 / b0 = their output times
  | { mode: 'mark'; sid: string; op: 'move' | 'trimL' | 'trimR'; itemId: string; fxId?: string; capId?: string; x0: number; active: boolean;
      t0: number; t1: number; a0: number; b0: number; point: boolean; dur0: number; seekF: number };
type MarkRef = { itemId: string; fxId?: string; capId?: string; from: number };

export const DND = 'application/x-cadre';
const TRACK_DND = 'application/x-cadre-track';
const RULER = 26;
const THRESHOLD = 4;
const isRole = (k: Row['kind']): k is RoleKind => k === 'voice' || k === 'music' || k === 'sfx';

export function Timeline({ compact = false }: { compact?: boolean }) {
  const { r, props } = useComp();
  const project = props.project;
  const sel = useStore((s) => s.sel);
  const select = useStore((s) => s.select);
  const seek = useStore((s) => s.seek);
  const update = useStore((s) => s.update);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const tool = useStore((s) => s.tool);
  const snap = useStore((s) => s.snap);
  const setUi = useStore((s) => s.setUi);
  const speakers = useStore((s) => s.speakers);
  const notify = useStore((s) => s.notify);
  const playing = useStore((s) => s.playing);
  const prefs = usePrefs();
  const [pps, setPps] = useState(() => { try { return Number(localStorage.getItem('cadre-pps')) || 30; } catch { return 30; } });
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [overId, setOverId] = useState<string | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [insertX, setInsertX] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ key: string; left: number; width: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [trackOver, setTrackOver] = useState<string | null>(null);
  const ghostRef = useRef<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const fps = r.fps;
  const total = r.duration / fps;
  const width = Math.max(view.width, total * pps + 400);
  const X = (sec: number) => sec * pps;
  const tracks = project.tracks || [];
  const mix = project.mix || {};

  const rows: Row[] = useMemo(() => {
    const vis = tracks.filter((tr) => tr.kind !== 'audio');
    let nv = vis.filter((tr) => tr.kind === 'video').length + 1;
    let nt = vis.filter((tr) => tr.kind === 'text').length;
    const aud = tracks.filter((tr) => tr.kind === 'audio' && !tr.role);
    const role = (k: RoleKind) => tracks.find((tr) => tr.role === k);
    return [
      ...vis.map((tr) => ({ key: tr.id, kind: 'track' as const, tr, h: compact ? 30 : 40, tid: tr.kind === 'video' ? `V${nv--}` : `T${nt--}` })),
      { key: 'v1', kind: 'v1' as const, h: compact ? 40 : 56, tid: 'V1' },
      { key: 'captions', kind: 'captions' as const, h: 20, tid: 'ST' },
      { key: 'fx', kind: 'fx' as const, h: 20, tid: 'FX' },
      { key: 'voice', kind: 'voice' as const, h: compact ? 30 : 42, tid: 'A1', tr: role('voice') },
      { key: 'music', kind: 'music' as const, h: compact ? 28 : 34, tid: 'A2', tr: role('music') },
      { key: 'sfx', kind: 'sfx' as const, h: compact ? 24 : 28, tid: 'A3', tr: role('sfx') },
      ...aud.map((tr, i) => ({ key: tr.id, kind: 'track' as const, tr, h: compact ? 28 : 36, tid: `A${i + 4}` })),
    ];
  }, [tracks, compact]);

  useEffect(() => { try { localStorage.setItem('cadre-pps', String(pps)); } catch { /* storage unavailable */ } }, [pps]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const on = () => {
      setView({ left: el.scrollLeft, width: el.clientWidth });
      if (heads.current) heads.current.scrollTop = el.scrollTop;
    };
    on();
    el.addEventListener('scroll', on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', on); ro.disconnect(); };
  }, []);

  // playhead + timecode: directly in the DOM; auto-scroll during playback
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  useEffect(() => onFrame((f) => {
    const px = (f / fps) * ppsRef.current;
    if (head.current) head.current.style.transform = `translateX(${px}px)`;
    if (tcRef.current) tcRef.current.textContent = tc(f, fps);
    const el = scroll.current;
    if (el && !drag.current && getPrefs().followPlayhead && (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 30)) el.scrollLeft = Math.max(0, px - el.clientWidth * 0.2);
  }), [fps]);
  useEffect(() => { const f = getFrame(); if (head.current) head.current.style.transform = `translateX(${(f / fps) * pps}px)`; }, [pps, fps]);

  // zoom: wheel + ⌥ / ⌘ / pinch, around the mouse; shortcuts + / −
  const zoomBy = (k: number, anchorX?: number) => {
    const el = scroll.current;
    if (!el) return;
    const ax = anchorX ?? ((getFrame() / fps) * pps - el.scrollLeft);
    const tt = (el.scrollLeft + ax) / pps;
    const np = Math.max(1, Math.min(600, pps * k));
    setPps(np);
    requestAnimationFrame(() => { el.scrollLeft = Math.max(0, tt * np - ax); });
  };
  const fit = () => { const el = scroll.current; if (el) { setPps(Math.max(1, (el.clientWidth - 40) / Math.max(1, total))); el.scrollLeft = 0; } };
  timelineCtl.zoom = zoomBy;
  timelineCtl.fit = fit;
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (!(e.altKey || e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? 0.87 : 1.15, e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  });

  const timeAt = (clientX: number) => {
    const el = scroll.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / pps);
  };
  const snapPoints = (exceptId?: string) => {
    const pts = [getFrame() / fps, 0, total];
    for (const it of r.items) if (it.id !== exceptId) pts.push(it.from / fps, (it.from + it.dur) / fps);
    for (const tr of tracks) for (const c of tr.clips) if (c.id !== exceptId) pts.push(c.start, c.start + c.dur);
    for (const m of project.markers || []) pts.push(m.t);
    return pts;
  };
  const snapT = (tt: number, exceptId?: string, show = true): number => {
    if (!snap) return tt;
    const thr = 8 / pps;
    let best = tt;
    let d = thr;
    for (const p of snapPoints(exceptId)) if (Math.abs(p - tt) < d) { d = Math.abs(p - tt); best = p; }
    if (show) setSnapAt(best !== tt ? best : null);
    return best;
  };

  const rowTops = useMemo(() => {
    let y = RULER;
    return rows.map((rw) => { const top = y; y += rw.h; return top; });
  }, [rows]);
  const rowAtY = (clientY: number): Row | null => {
    const el = scroll.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    const i = rowTops.findIndex((top, k) => y >= top && y < top + rows[k].h);
    return rows[i] || null;
  };

  // ---------- dragging (a single loop for everything: playhead scrubbing, clips, V1 shots)
  const pending = useRef<PointerEvent | null>(null);
  const raf = useRef(0);
  const process = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'scrub') { seek(timeAt(e.clientX) * fps); return; }
    const dxPx = e.clientX - d.x0;
    if (!d.active) {
      const dy = 'y0' in d ? e.clientY - d.y0 : 0;
      if (Math.abs(dxPx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      d.active = true;
      if (d.mode === 'clip') {
        setDragging(d.clipId);
        document.body.style.cursor = d.op === 'move' ? 'grabbing' : 'ew-resize';
        if (d.alt && d.op === 'move') {                          // ⌥: drag a copy, the original stays
          const nid = uid('o');
          update((p) => {
            const tr = (p.tracks || []).find((x) => x.id === d.trackId);
            const c = tr?.clips.find((x) => x.id === d.clipId);
            if (tr && c) tr.clips.push({ ...structuredClone(c), id: nid });
          }, `drag:${d.sid}`, tx('Duplication'));
          d.clipId = nid;
          select({ clipId: nid, trackId: d.trackId });
        }
      } else {
        document.body.style.cursor = d.mode === 'trim' || (d.mode === 'mark' && d.op !== 'move') ? 'ew-resize' : 'grabbing';
        if (d.mode === 'reorder') setDragging(d.id);
      }
    }
    const dx = dxPx / pps;
    if (d.mode === 'reorder') {
      const setGap = (before: number, nextBefore: number) => {
        const it = project.timeline.find((i) => i.id === d.id);
        const nx = d.nextId ? project.timeline.find((i) => i.id === d.nextId) : null;
        if (Math.abs((it?.before || 0) - before) < 1e-4 && Math.abs((nx?.before || 0) - nextBefore) < 1e-4) return;
        d.changed = true;
        update((p) => {
          const a = p.timeline.find((i) => i.id === d.id);
          const b = d.nextId ? p.timeline.find((i) => i.id === d.nextId) : null;
          if (a) { if (before > 1e-3) a.before = Math.round(before * 1000) / 1000; else delete a.before; }
          if (b) { if (nextBefore > 1e-3) b.before = Math.round(nextBefore * 1000) / 1000; else delete b.before; }
        }, `drag:${d.sid}`, tx('Déplacement'));
      };
      const it0 = project.timeline.find((i) => i.id === d.id);
      const rowT = rowAtY(e.clientY);
      const canOverlay = it0 && (it0.type === 'clip' || (it0.type === 'media' && it0.kind !== 'audio'));
      if (rowT?.kind === 'track' && rowT.tr.kind === 'video' && !rowT.tr.locked && canOverlay) {
        // onto a video track: will become an overlay at the same time
        d.toTrack = rowT.tr.id; d.idx = null; setInsertX(null);
        setGap(d.before0, d.nextBefore0);
        ghostRef.current = snapT(Math.max(0, d.start0 + dx), d.id);
        setGhost({ key: rowT.key, left: X(ghostRef.current), width: Math.max(4, X(d.dur)) });
        setHint(tx('Relâche : incrustation sur {0}', rowT.tr.name));
        return;
      }
      d.toTrack = null; setGhost(null);
      let st = Math.max(0, d.start0 + dx);
      const s1 = snapT(st, d.id);
      const s2 = snapT(st + d.dur, d.id, false) - d.dur;
      st = Math.abs(s1 - st) <= Math.abs(s2 - st) ? s1 : s2;
      const minStart = d.start0 - d.before0;
      if (e.metaKey || e.ctrlKey || st < minStart - 8 / pps) {
        // insertion between two shots (as before): yellow insertion point
        const tt = timeAt(e.clientX) * fps;
        let k = r.items.findIndex((x) => x.id !== d.id && tt < x.from + x.dur / 2);
        if (k < 0) k = r.items.length;
        const cur = r.items.findIndex((x) => x.id === d.id);
        d.idx = k === cur || k === cur + 1 ? null : k;
        if (d.idx === null) {
          // same place: snapped to the previous shot, the following ones don't move
          setGap(0, d.nextBefore0 + d.before0);
          setInsertX(null);
          setHint(tx('⌘ pour insérer ailleurs · vers une piste vidéo : incrustation'));
          return;
        }
        setGap(d.before0, d.nextBefore0);
        setInsertX(X((k < r.items.length ? r.items[k].from : r.duration) / fps));
        setHint(tx('Relâche : insérer ici'));
        return;
      }
      d.idx = null; setInsertX(null);
      // free placement: the gap before the shot grows / shrinks, the next shot stays put as long as there is room
      const nb = Math.max(0, d.before0 + (st - d.start0));
      const delta = nb - d.before0;
      setGap(nb, Math.max(0, d.nextBefore0 - delta));
      setHint(nb > 0 ? tx('Espace avant : {0} s · ⌘ pour insérer ailleurs', nb.toFixed(2)) : tx('⌘ pour insérer ailleurs · vers une piste vidéo : incrustation'));
      return;
    }
    if (d.mode === 'mark') {
      update((p) => {
        const it = p.timeline.find((i) => i.id === d.itemId);
        if (!it || it.type !== 'clip') return;
        const x = (d.capId ? it.captions.find((c) => c.id === d.capId) : it.fx.find((f) => f.id === d.fxId)) as (Partial<Caption> & Partial<Extract<Fx, { kind: 'text' }>> & { t0?: number; t1?: number }) | undefined;
        if (!x) return;
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        const at = (sec: number) => srcAt(d.itemId, d.op === 'move' ? snapT(sec, undefined) : sec);
        if (d.point) {
          if (d.op === 'move') x.t = r3(Math.max(it.in, Math.min(it.out, at(d.a0 + dx))));
          else if (d.op === 'trimR' && x.dur !== undefined) x.dur = r3(Math.max(0.2, d.dur0 + dx));
        } else if (d.op === 'move') {
          const len = d.t1 - d.t0;
          const t0 = Math.max(it.in, Math.min(it.out - len, at(d.a0 + dx)));
          x.t0 = r3(t0); x.t1 = r3(t0 + len);
        } else if (d.op === 'trimL') x.t0 = r3(Math.max(it.in, Math.min(d.t1 - 0.05, at(d.a0 + dx))));
        else x.t1 = r3(Math.min(it.out, Math.max(d.t0 + 0.05, at(d.b0 + dx))));
        if (d.capId) it.captions.sort((a, b) => a.t0 - b.t0);
        else it.fx.sort((a, b) => ('t' in a ? a.t : a.t0) - ('t' in b ? b.t : b.t0));
      }, `mark:${d.sid}`, d.op === 'move' ? tx('Déplacement') : tx('Rognage'));
      return;
    }
    if (d.mode === 'trim') {
      update((p) => {
        const el = p.timeline.find((i) => i.id === d.id);
        if (el && el.type !== 'clip') { el.dur = Math.round(Math.max(0.2, d.v0 + dx) * 1000) / 1000; return; }
        const it = el as ClipItem | undefined;
        if (!it) return;
        const src = p.sources.find((s) => s.id === it.src);
        if (d.side === 'in') it.in = Math.max(0, Math.min(it.out - 0.2, d.v0 + dx * d.rate));
        else it.out = Math.min(src?.duration ?? Infinity, Math.max(it.in + 0.2, d.v0 + dx * d.rate));
      }, `trim:${d.sid}`, tx('Rognage'));
      return;
    }
    const target = d.op === 'move' ? rowAtY(e.clientY) : null;
    update((p) => {
      const tr = (p.tracks || []).find((x) => x.id === d.trackId);
      const c = tr?.clips.find((x) => x.id === d.clipId);
      if (!tr || !c) return;
      if (d.op === 'move') {
        let st = Math.max(0, d.start0 + dx);
        const s1 = snapT(st, c.id);
        const s2 = snapT(st + c.dur, c.id, false) - c.dur;
        st = Math.abs(s1 - st) <= Math.abs(s2 - st) ? s1 : s2;
        c.start = Math.max(0, Math.round(st * 1000) / 1000);
        // video overlay dragged onto V1: it will be inserted into the edit
        if (target?.kind === 'v1' && c.type === 'video') {
          const tt = c.start * fps;
          let k = r.items.findIndex((x) => tt < x.from + x.dur / 2);
          if (k < 0) k = r.items.length;
          d.toV1 = k;
          setInsertX(X((k < r.items.length ? r.items[k].from : r.duration) / fps));
          setHint(tx('Relâche : insérer dans le montage'));
        } else if (d.toV1 != null) { d.toV1 = null; setInsertX(null); setHint(null); }
        // track change (same type): free tracks or Voice / Music / Sound effects lanes for audio
        let dst: Track | null = null;
        if (target?.kind === 'track' && target.tr.kind === tr.kind && !target.tr.locked) dst = (p.tracks || []).find((x) => x.id === target.tr.id) || null;
        else if (target && isRole(target.kind) && tr.kind === 'audio') dst = roleTrack(p, target.kind);
        if (dst && dst.id !== tr.id) {
          tr.clips = tr.clips.filter((x) => x.id !== c.id);
          if (c.type === 'audio') c.duck = dst.role === 'music' ? true : c.duck;
          dst.clips.push(c);
          d.trackId = dst.id;
        }
      } else if (d.op === 'trimL') {
        const st = Math.min(d.start0 + d.dur0 - 0.1, Math.max(0, snapT(d.start0 + dx, c.id)));
        const delta = st - d.start0;
        c.start = st;
        c.dur = d.dur0 - delta;
        if (c.type !== 'text') c.in = Math.max(0, d.in0 + delta * ('speed' in c && c.speed ? c.speed : 1));
      } else {
        const end = Math.max(d.start0 + 0.1, snapT(d.start0 + d.dur0 + dx, c.id));
        c.dur = end - d.start0;
      }
    }, `drag:${d.sid}`, d.op === 'move' ? tx('Déplacement') : tx('Rognage'));
  };
  const end = (cancel = false) => {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    pending.current = null;
    setSnapAt(null); setInsertX(null); setDragging(null); setGhost(null); setHint(null);
    document.body.style.cursor = '';
    if (!d) return;
    if (cancel && d.mode !== 'scrub' && d.active && (d.mode !== 'reorder' || d.changed)) { undo(); return; }
    if (cancel) return;
    if (d.mode === 'clip' && d.active && d.toV1 != null) {
      const idx = d.toV1;
      const target = r.items[idx]?.id;
      let newId = '';
      update((p) => {
        const tr = (p.tracks || []).find((x) => x.id === d.trackId);
        const c = tr?.clips.find((x) => x.id === d.clipId);
        if (!tr || !c || c.type !== 'video') return;
        tr.clips = tr.clips.filter((x) => x.id !== c.id);
        const item: Item = c.src && p.sources.some((s) => s.id === c.src)
          ? { id: uid('i'), type: 'clip', src: c.src, in: c.in, out: c.in + c.dur * (c.speed || 1), speed: c.speed || 1, jump: false, captions: [], fx: [], look: c.look, label: c.name || '' }
          : { id: uid('i'), type: 'media', path: c.path || pathOf(c.url) || '', url: c.url || '', kind: c.kind, dur: c.dur, look: c.look, volumeDb: c.volumeDb };
        newId = item.id;
        const to = target ? p.timeline.findIndex((i) => i.id === target) : p.timeline.length;
        p.timeline.splice(to < 0 ? p.timeline.length : to, 0, item);
      }, `drag:${d.sid}`, tx('Insertion dans le montage'));
      if (newId) select({ itemId: newId });
      return;
    }
    if (d.mode === 'reorder') {
      if (d.active && d.toTrack) {
        // V1 shot -> overlay(s) at the same time (one clip per kept piece), the rest of the edit doesn't move
        const ri = r.items.find((x) => x.id === d.id);
        const shift = (ghostLeftSec(d) - d.start0);
        let first = '';
        update((p) => {
          const k = p.timeline.findIndex((i) => i.id === d.id);
          const tr = (p.tracks || []).find((x) => x.id === d.toTrack);
          if (k < 0 || !tr || !ri) return;
          const it = p.timeline[k];
          const out: OClip[] = [];
          if (it.type === 'clip') {
            for (const sg of ri.segs) out.push({ id: uid('o'), type: 'video', src: it.src, kind: 'video', in: sg.a, speed: sg.rate, start: sg.from / fps + shift, dur: sg.dur / fps,
              look: it.look, volumeDb: it.volumeDb, name: it.label || undefined });
          } else if (it.type === 'media' && it.kind !== 'audio') {
            out.push({ id: uid('o'), type: 'video', path: it.path, url: it.url, kind: it.kind, in: 0, start: ri.from / fps + shift, dur: ri.dur / fps, look: it.look, volumeDb: it.volumeDb });
          }
          if (!out.length) return;
          first = out[0].id;
          tr.clips.push(...out);
          const next = p.timeline[k + 1];
          if (next) next.before = Math.round(((next.before || 0) + (it.before || 0) + ri.dur / fps) * 1000) / 1000;
          p.timeline.splice(k, 1);
        }, `drag:${d.sid}`, tx('Vers une piste vidéo'));
        if (first) select({ clipId: first, trackId: d.toTrack });
      } else if (d.active && d.idx !== null) {
        const idx = d.idx;
        update((p) => {
          const from = p.timeline.findIndex((i) => i.id === d.id);
          if (from < 0) return;
          const target = r.items[idx]?.id;
          const [it] = p.timeline.splice(from, 1);
          delete it.before;
          const to = target ? p.timeline.findIndex((i) => i.id === target) : p.timeline.length;
          p.timeline.splice(to < 0 ? p.timeline.length : to, 0, it);
        }, `drag:${d.sid}`, tx('Déplacement'));
      } else if (!d.active && !playing) seek(d.seekT * fps);
    }
    if (d.mode === 'mark' && !d.active && !playing) seek(d.seekF);
  };
  const ghostLeftSec = (d: Extract<Drag, { mode: 'reorder' }>) => (ghostRef.current ?? d.start0);
  /** output time -> source time in this shot (shot edges beyond it, next piece inside a cut) */
  const srcAt = (itemId: string, sec: number): number => {
    const ri = r.items.find((x) => x.id === itemId);
    const segs = ri?.segs || [];
    if (!segs.length) return 0;
    const f = sec * fps;
    const hit = frameToSrc(r, f);
    if (hit && hit.itemId === itemId && hit.t !== null) return hit.t;
    for (const sg of segs) if (f < sg.from) return sg.a;
    return segs[segs.length - 1].b;
  };
  const markDown = (e: React.PointerEvent, m: MarkRef, op: 'move' | 'trimL' | 'trimR' = 'move') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (tool === 'razor') { razorAt(e.clientX); return; }
    select({ itemId: m.itemId, fxId: m.fxId, capId: m.capId });
    const it = project.timeline.find((i) => i.id === m.itemId);
    if (!it || it.type !== 'clip') { seek(m.from); return; }
    const x = (m.capId ? it.captions.find((c) => c.id === m.capId) : it.fx.find((f) => f.id === m.fxId)) as { t?: number; t0?: number; t1?: number; dur?: number } | undefined;
    if (!x) { seek(m.from); return; }
    const point = x.t !== undefined;
    const t0 = point ? x.t! : x.t0!, t1 = point ? x.t! : x.t1!;
    const outSec = (t: number) => (srcToFrame(r, m.itemId, t) ?? m.from) / fps;
    if (op !== 'move') e.preventDefault();
    capture(e);
    drag.current = { mode: 'mark', sid: uid('d'), op, itemId: m.itemId, fxId: m.fxId, capId: m.capId, x0: e.clientX, active: false,
      t0, t1, a0: outSec(t0), b0: outSec(t1), point, dur0: x.dur ?? 0, seekF: m.from };
  };
  /** trim handles of a mark (effects with a duration) */
  const markHandles = (m: MarkRef, w: number, point = false) => w < 10 ? null : (
    <>
      {point ? null : <span className="hdl" style={{ left: 0, width: 4 }} onPointerDown={(e) => markDown(e, m, 'trimL')} />}
      <span className="hdl" style={{ right: 0, width: 4 }} onPointerDown={(e) => markDown(e, m, 'trimR')} />
    </>
  );
  const selShadow = (on: boolean) => (on ? '0 0 0 2px #fff inset' : undefined);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      pending.current = e;
      if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; const ev = pending.current; pending.current = null; if (ev) process(ev); });
    };
    const up = (e: PointerEvent) => { if (drag.current) { if (pending.current) process(pending.current); process(e); end(); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current) { e.stopPropagation(); end(true); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('keydown', key, true); };
  });
  const capture = (e: React.PointerEvent) => { try { scroll.current?.setPointerCapture(e.pointerId); } catch { /* already released */ } };

  const patchTrack = (id: string, fn: (tr: Track) => void) => update((p) => { const tr = (p.tracks || []).find((x) => x.id === id); if (tr) fn(tr); });
  const addTrack = (kind: Track['kind']) => update((p) => {
    const list = p.tracks || (p.tracks = []);
    const n = list.filter((x) => x.kind === kind && !x.role).length + 1;
    const tr: Track = { id: uid('t'), kind, name: kind === 'video' ? `${tx('Vidéo')} ${n + 1}` : kind === 'text' ? `${tx('Titres')} ${n}` : `${tx('Audio')} ${n + 3}`, clips: [] };
    if (kind === 'audio') list.push(tr); else list.unshift(tr);
  }, undefined, tx('Nouvelle piste'));
  /** stacking order (like V2 / V3 in other editors): a track higher in the list is drawn above the ones below it.
   *  Video and title tracks move among themselves, free audio tracks among themselves. */
  const sameGroup = (a: Track, b: Track) => (a.kind === 'audio') === (b.kind === 'audio') && !a.role && !b.role;
  const moveTrack = (id: string, to: number | 'up' | 'down') => update((p) => {
    const list = p.tracks || [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const peers = list.map((t, k) => [t, k] as const).filter(([t]) => sameGroup(t, list[i])).map(([, k]) => k);
    const pos = peers.indexOf(i);
    const target = to === 'up' ? peers[pos - 1] : to === 'down' ? peers[pos + 1] : to;
    if (target === undefined || target === i || !sameGroup(list[target], list[i])) return;
    const [tr] = list.splice(i, 1);
    list.splice(target, 0, tr);
  }, undefined, tx('Ordre des pistes'));
  const canMove = (tr: Track, dir: -1 | 1) => {
    const peers = tracks.filter((t) => sameGroup(t, tr));
    const k = peers.findIndex((t) => t.id === tr.id) + dir;
    return k >= 0 && k < peers.length;
  };
  const addTrackNear = (tr: Track, above: boolean) => update((p) => {
    const list = p.tracks || (p.tracks = []);
    const n = list.filter((x) => x.kind === tr.kind && !x.role).length + 1;
    const nt: Track = { id: uid('t'), kind: tr.kind, name: tr.kind === 'video' ? `${tx('Vidéo')} ${n + 1}` : tr.kind === 'text' ? `${tx('Titres')} ${n}` : `${tx('Audio')} ${n + 3}`, clips: [] };
    const i = list.findIndex((x) => x.id === tr.id);
    list.splice(above ? i : i + 1, 0, nt);
  }, undefined, tx('Nouvelle piste'));
  const setMix = (k: keyof NonNullable<Project['mix']>, v: boolean) => update((p) => { p.mix = { ...(p.mix || {}), [k]: v }; });

  // ---------- drop from the panels (media, library, titles, transitions, effects)
  const accepts = (rw: Row | null, types: readonly string[]) => types.includes(DND) && (!rw || rw.kind !== 'captions');
  const onDrop = (e: React.DragEvent, rw: Row | null) => {
    e.preventDefault();
    setOverId(null);
    const raw = e.dataTransfer.getData(DND);
    if (!raw) return;
    const tt = snap ? snapT(timeAt(e.clientX)) : timeAt(e.clientX);
    setSnapAt(null);
    dropData(JSON.parse(raw), rw, tt);
  };
  const dropData = (data: DropData, rw: Row | null, tt: number) => {
    if (data.type === 'effect' || data.type === 'preset') {
      let ref: TargetRef | null = null;
      const trk = rw && 'tr' in rw ? rw.tr : undefined;
      if (trk) { const c = trk.clips.find((x) => tt >= x.start && tt < x.start + x.dur); if (c) ref = { kind: 'clip', id: c.id }; }
      if (!ref) { const hit = r.items.find((it) => tt * fps >= it.from && tt * fps < it.from + it.dur); if (hit) ref = { kind: 'item', id: hit.id }; }
      if (!ref) { notify(tx('Dépose l’effet sur un clip')); return; }
      if (data.type === 'effect') applyEffect(data.kind, ref);
      else { const pr = useStore.getState().presets.find((x) => x.id === data.id); if (pr) applyPreset(pr, ref); }
      return;
    }
    if (data.type === 'transition') {
      const hit = r.items.find((it) => tt * fps >= it.from && tt * fps < it.from + it.dur);
      if (!hit) return;
      update((p) => { const it = p.timeline.find((x) => x.id === hit.id); if (it && it.type !== 'card') it.transition = { kind: data.kind, dur: getPrefs().transitionDur }; }, undefined, tx('Transition'));
      return;
    }
    const media = data.type === 'file' ? data.media : data.type === 'source' ? project.sources.find((s) => s.id === data.id)?.kind : undefined;
    if (rw?.kind === 'v1' && data.type === 'source' && media !== 'audio') {
      const src = project.sources.find((s) => s.id === data.id);
      if (!src) return;
      const a = data.a ?? 0, b = data.b ?? src.duration;
      const idx = r.items.findIndex((it) => tt * fps < it.from + it.dur / 2);
      const clip: ClipItem = { id: uid('i'), type: 'clip', src: src.id, in: a, out: b, label: '', jump: null, speed: 1, captions: [], fx: [] };
      update((p) => { p.timeline.splice(idx < 0 ? p.timeline.length : idx, 0, clip); }, undefined, tx('Insertion'));
      select({ itemId: clip.id });
      api.autoCaptions(project.id, { src: src.id, in: a, out: b }).then((caps) => {
        if (caps.length) update((p) => { const c = p.timeline.find((x) => x.id === clip.id) as ClipItem | undefined; if (c) c.captions = caps; }, 'caps:auto');
      }).catch(() => undefined);
      return;
    }
    const wantKind: Track['kind'] = data.type === 'text' ? 'text' : media === 'audio' ? 'audio' : 'video';
    const clip = makeClip(data, tt, project);
    if (!clip) return;
    // audio dropped on Voice / Music / Sound effects: it goes into that lane; on a track of the right type: into that track
    const role: RoleKind | null = rw && isRole(rw.kind) && wantKind === 'audio' ? rw.kind : null;
    if (role === 'music' && clip.type === 'audio') clip.duck = true;
    let trackId = rw?.kind === 'track' && rw.tr.kind === wantKind && !rw.tr.locked ? rw.tr.id : null;
    update((p) => {
      const list = p.tracks || (p.tracks = []);
      let tr = role ? roleTrack(p, role) : trackId ? list.find((x) => x.id === trackId) : list.find((x) => x.kind === wantKind && !x.locked && !x.role);
      if (!tr) {
        const n = list.filter((x) => x.kind === wantKind && !x.role).length + 1;
        tr = { id: uid('t'), kind: wantKind, name: wantKind === 'video' ? `${tx('Vidéo')} ${n + 1}` : wantKind === 'text' ? `${tx('Titres')} ${n}` : `${tx('Audio')} ${n + 3}`, clips: [] };
        if (wantKind === 'audio') list.push(tr); else list.unshift(tr);
      }
      trackId = tr.id;
      tr.clips.push(clip);
    }, undefined, tx('Ajout'));
    select({ clipId: clip.id, trackId: trackId || undefined });
  };

  const razorAt = (clientX: number) => { if (!splitAt(timeAt(clientX) * fps)) notify(tx('Rien à couper ici')); };

  // ---------- right-click menus
  const clipMenu = (e: React.MouseEvent, c: OClip, tr: Track) => {
    select({ clipId: c.id, trackId: tr.id });
    const at = timeAt(e.clientX);
    const items: MenuItem[] = [
      { label: tx('Demander à l’IA sur ce clip…'), icon: 'wand', keys: '⌘K', onClick: () => { select({ clipId: c.id, trackId: tr.id }); focusAssistant(); } },
      'sep',
      { label: tx('Couper ici'), icon: 'razor', keys: 'S', onClick: () => { select({ clipId: c.id, trackId: tr.id }); splitAt(at * fps); } },
      'sep',
      { label: tx('Copier'), icon: 'copy', keys: '⌘C', onClick: () => copySelection() },
      { label: tx('Couper'), icon: 'razor', keys: '⌘X', onClick: () => copySelection(true) },
      { label: tx('Coller à la tête de lecture'), icon: 'import', keys: '⌘V', disabled: !hasClipboard(), onClick: () => pasteAtPlayhead() },
      { label: tx('Dupliquer'), icon: 'layers', keys: '⌘D', onClick: () => duplicateSelection() },
      'sep',
      ...(c.type === 'video' && c.kind === 'video' ? [linkEntry({ kind: 'clip', id: c.id })] : []),
      ...(c.type === 'audio' && c.link ? [{ label: tx('Rattacher à la vidéo'), icon: 'link' as const, keys: '⌘L', onClick: () => relinkAudio(c.link!) }] : []),
      ...(c.type !== 'text' ? [{ label: c.type === 'video' && c.muted ? tx('Rétablir le son') : tx('Couper le son'), icon: 'mute', onClick: () => update((p) => {
        const x = (p.tracks || []).flatMap((y) => y.clips).find((y) => y.id === c.id);
        if (x?.type === 'video') x.muted = !x.muted; else if (x?.type === 'audio') x.volumeDb = (x.volumeDb ?? 0) <= -60 ? 0 : -100;
      }, undefined, tx('Son')) }] : []),
      { label: tx('Propriétés'), icon: 'sliders', onClick: () => setUi({ upperTab: 'props' }) },
      'sep',
      { label: tx('Supprimer'), icon: 'trash', keys: '⌫', danger: true, onClick: () => deleteSelection() },
    ];
    contextMenu(e, items);
  };
  const itemMenu = (e: React.MouseEvent, id: string) => {
    select({ itemId: id });
    const at = timeAt(e.clientX);
    contextMenu(e, [
      { label: tx('Demander à l’IA sur ce plan…'), icon: 'wand', keys: '⌘K', onClick: () => { select({ itemId: id }); focusAssistant(); } },
      'sep',
      { label: tx('Couper ici'), icon: 'razor', keys: 'S', onClick: () => splitAt(at * fps) },
      'sep',
      { label: tx('Copier'), icon: 'copy', keys: '⌘C', onClick: () => copySelection() },
      { label: tx('Couper'), icon: 'razor', keys: '⌘X', onClick: () => copySelection(true) },
      { label: tx('Coller à la tête de lecture'), icon: 'import', keys: '⌘V', disabled: !hasClipboard(), onClick: () => pasteAtPlayhead() },
      { label: tx('Dupliquer'), icon: 'layers', keys: '⌘D', onClick: () => duplicateSelection() },
      'sep',
      ...(canUnlink(id) ? [linkEntry({ kind: 'item', id }), 'sep' as const] : []),
      { label: tx('Insérer 1 s d’espace avant'), icon: 'plus', onClick: () => update((p) => { const it = p.timeline.find((x) => x.id === id); if (it) it.before = Math.round(((it.before || 0) + 1) * 1000) / 1000; }, undefined, tx('Espace')) },
      ...((project.timeline.find((x) => x.id === id)?.before || 0) > 0 ? [{ label: tx("Fermer l'espace avant"), icon: 'trash' as const, onClick: () => closeGap(id) }] : []),
      'sep',
      { label: tx('Propriétés'), icon: 'sliders', onClick: () => setUi({ upperTab: 'props' }) },
      { label: tx('Effets…'), icon: 'style', onClick: () => setUi({ lowerTab: 'effects' }) },
      'sep',
      { label: tx('Supprimer en gardant l’espace'), icon: 'trash', keys: '⇧⌫', onClick: () => deleteSelection(true) },
      { label: tx('Supprimer'), icon: 'trash', keys: '⌫', danger: true, onClick: () => deleteSelection() },
    ]);
  };
  /** Unlink audio / Relink audio (like Premiere: the audio becomes separate clips, movable for a J/L-cut) */
  const linkEntry = (ref: { kind: 'item' | 'clip'; id: string }): MenuItem => {
    const t = project.timeline.find((x) => x.id === ref.id)?.type;
    const sounds = t === 'card' || t === 'freeze';
    return isUnlinked(ref.id)
      ? { label: sounds ? tx('Rattacher les sons') : tx('Rattacher l’audio'), icon: 'link', keys: '⌘L', onClick: () => relinkAudio(ref.id) }
      : { label: sounds ? tx('Délier les sons') : tx('Délier l’audio'), icon: 'split', keys: '⌘L', onClick: () => { if (!unlinkAudio(ref)) notify(tx('Ce plan n’a pas de son à délier')); } };
  };
  const canUnlink = (id: string) => {
    const it = project.timeline.find((x) => x.id === id);
    if (!it) return false;
    if (it.type === 'clip') { const s = project.sources.find((x) => x.id === it.src); return !!s && (s.kind === 'audio' || s.hasAudio !== false); }
    if (it.type === 'card' || it.type === 'freeze') return isUnlinked(id) || r.sfx.some((x) => x.key.startsWith(`${id}:`));
    return it.type === 'media' && it.kind === 'video';
  };
  const closeGap = (id: string) => update((p) => { const it = p.timeline.find((x) => x.id === id); if (it) delete it.before; }, undefined, tx("Fermer l'espace"));
  const emptyMenu = (e: React.MouseEvent) => {
    const at = timeAt(e.clientX);
    contextMenu(e, [
      { label: tx('Coller ici'), icon: 'import', keys: '⌘V', disabled: !hasClipboard(), onClick: () => { seek(at * fps); pasteAtPlayhead(); } },
      { label: tx('Ajouter un marqueur ici'), icon: 'marker', keys: 'M', onClick: () => { seek(at * fps); addMarker(); } },
      'sep',
      { label: tx('Nouvelle piste vidéo'), icon: 'film', onClick: () => addTrack('video') },
      { label: tx('Nouvelle piste de titres'), icon: 'text', onClick: () => addTrack('text') },
      { label: tx('Nouvelle piste audio'), icon: 'audio', onClick: () => addTrack('audio') },
    ]);
  };
  const trackMenu = (e: React.MouseEvent, tr: Track) => contextMenu(e, [
    ...(tr.role ? [] : [
      { label: tr.kind === 'audio' ? tx('Monter la piste') : tx('Passer au-dessus'), icon: 'chev' as const, disabled: !canMove(tr, -1), onClick: () => moveTrack(tr.id, 'up') },
      { label: tr.kind === 'audio' ? tx('Descendre la piste') : tx('Passer en dessous'), icon: 'chev' as const, disabled: !canMove(tr, 1), onClick: () => moveTrack(tr.id, 'down') },
      { label: tr.kind === 'audio' ? tx('Nouvelle piste audio en dessous') : tx('Nouvelle piste au-dessus'), icon: 'plus' as const, onClick: () => addTrackNear(tr, tr.kind !== 'audio') },
      'sep' as const,
    ]),
    { label: tx('Renommer…'), icon: 'edit', onClick: () => { const n = prompt(tx('Nom de la piste'), tr.name); if (n) patchTrack(tr.id, (x) => { x.name = n; }); } },
    { label: tr.locked ? tx('Déverrouiller') : tx('Verrouiller'), icon: tr.locked ? 'unlock' : 'lock', onClick: () => patchTrack(tr.id, (x) => { x.locked = !x.locked; }) },
    tr.kind === 'audio'
      ? { label: tr.muted ? tx('Rétablir le son') : tx('Couper le son'), icon: 'mute', onClick: () => patchTrack(tr.id, (x) => { x.muted = !x.muted; }) }
      : { label: tr.hidden ? tx('Afficher') : tx('Masquer'), icon: 'eye', onClick: () => patchTrack(tr.id, (x) => { x.hidden = !x.hidden; }) },
    'sep',
    { label: tx('Supprimer la piste'), icon: 'trash', danger: true, onClick: () => { if (!tr.clips.length || !getPrefs().confirmDelete || confirm(tx('Supprimer la piste « {0} » et ses {1} clip(s) ?', tr.name, tr.clips.length))) update((p) => { p.tracks = (p.tracks || []).filter((x) => x.id !== tr.id); }, undefined, tx('Suppression')); } },
  ]);

  // ---------- render
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => s * pps >= 70) || 1800;
  const ticks: number[] = [];
  const t0 = Math.max(0, Math.floor(view.left / pps / step) * step);
  for (let k = t0; k <= (view.left + view.width) / pps + step; k += step) ticks.push(k);
  const spkColor = (id: string | null) => (id && speakers.find((s) => s.id === id)?.color) || props.pack.style?.captions?.color || '#fff';
  const visible = (x0: number, x1: number) => x1 >= view.left - 200 && x0 <= view.left + view.width + 200;

  const headFor = (rw: Row) => {
    const tidCls = rw.tid.startsWith('V') ? 'v' : rw.tid.startsWith('A') ? 'a' : rw.tid.startsWith('T') ? 't' : 's';
    if (rw.kind === 'track') {
      const tr = rw.tr;
      return (
        <>
          <span className={`tid ${tidCls}`}>{rw.tid}</span>
          <span className="tname" title={tr.name} onDoubleClick={() => { const n = prompt(tx('Nom de la piste'), tr.name); if (n) patchTrack(tr.id, (x) => { x.name = n; }); }}>{tr.name}</span>
          <button className={tr.locked ? 'on' : ''} onClick={() => patchTrack(tr.id, (x) => { x.locked = !x.locked; })} title={tx('Verrouiller')}><Icon name={tr.locked ? 'lock' : 'unlock'} size={12} /></button>
          {tr.kind === 'audio'
            ? <button className={`mute ${tr.muted ? 'on' : ''}`} onClick={() => patchTrack(tr.id, (x) => { x.muted = !x.muted; })} title={tx('Couper le son')}><Icon name={tr.muted ? 'mute' : 'volume'} size={12} /></button>
            : <button className={tr.hidden ? 'on' : ''} onClick={() => patchTrack(tr.id, (x) => { x.hidden = !x.hidden; })} title={tx('Masquer')}><Icon name={tr.hidden ? 'eyeoff' : 'eye'} size={12} /></button>}
          <button className="del" onClick={(e) => trackMenu(e, tr)} title={tx('Options de la piste')}><Icon name="more" size={12} /></button>
        </>
      );
    }
    const def: Record<string, [string, keyof NonNullable<Project['mix']> | null, 'eye' | 'volume']> = {
      v1: [tx('Montage'), 'mainHidden', 'eye'], captions: [tx('Sous-titres'), 'captionsHidden', 'eye'], fx: [tx('Effets'), null, 'eye'],
      voice: [tx('Voix'), 'voiceMuted', 'volume'], music: [tx('Musique'), 'musicMuted', 'volume'], sfx: [tx('Bruitages'), 'sfxMuted', 'volume'],
    };
    const [name, key, kind] = def[rw.kind];
    const on = key ? !!mix[key] : false;
    return (
      <>
        <span className={`tid ${tidCls}`}>{rw.tid}</span>
        <span className="tname">{name}</span>
        {key ? (
          <button className={`${kind === 'volume' ? 'mute' : ''} ${on ? 'on' : ''}`} onClick={() => setMix(key, !on)} title={kind === 'eye' ? tx('Masquer') : tx('Couper le son')}>
            <Icon name={kind === 'eye' ? (on ? 'eyeoff' : 'eye') : (on ? 'mute' : 'volume')} size={12} />
          </button>
        ) : null}
      </>
    );
  };

  /** clips of a track (free, or Voice / Music / Sound effects lane) */
  const trackClips = (tr: Track, h: number) => tr.clips.map((c) => {
    const x0 = X(c.start), w = Math.max(4, X(c.dur));
    if (!visible(x0, x0 + w)) return null;
    const hw = Math.max(3, Math.min(8, w / 4));
    const start = (op: 'move' | 'trimL' | 'trimR') => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (tr.locked) return;
      if (tool === 'razor') { razorAt(e.clientX); return; }
      select({ clipId: c.id, trackId: tr.id });
      capture(e);
      drag.current = { mode: 'clip', sid: uid('d'), op, clipId: c.id, trackId: tr.id, x0: e.clientX, y0: e.clientY, start0: c.start, dur0: c.dur, in0: 'in' in c ? c.in : 0, active: false, alt: e.altKey };
    };
    return (
      <div key={c.id} className={`clip ${c.type} ${sel.clipId === c.id ? 'sel' : ''} ${tr.locked ? 'locked' : ''} ${dragging === c.id ? 'dragging' : ''}`}
        style={{ left: x0, width: w, opacity: tr.hidden || tr.muted ? 0.45 : undefined, top: tr.role ? 3 : undefined, bottom: tr.role ? 3 : undefined }}
        onPointerDown={start('move')} onContextMenu={(e) => clipMenu(e, c, tr)}>
        <ClipFace c={c} w={w} h={h - 4} project={project} />
        <span className="hdl" style={{ left: 0, width: hw }} onPointerDown={start('trimL')} />
        <span className="hdl" style={{ right: 0, width: hw }} onPointerDown={start('trimR')} />
      </div>
    );
  });

  return (
    <div className="tl">
      <div className="tl-bar">
        <span className="tc-big" ref={tcRef} style={{ minWidth: 92 }}>{tc(getFrame(), fps)}</span>
        <span className="sep-v" />
        <button className="btn icon sm ghost" onClick={undo} title={tx('Annuler (⌘Z)')}><Icon name="undo" size={14} /></button>
        <button className="btn icon sm ghost" onClick={redo} title={tx('Rétablir (⇧⌘Z)')}><Icon name="redo" size={14} /></button>
        <span className="sep-v" />
        <button className="btn icon sm ghost" onClick={() => splitAt(getFrame()) || notify(tx('Rien à couper sous la tête de lecture'))} title={tx('Couper à la tête de lecture (S)')}><Icon name="split" size={14} /></button>
        <button className="btn icon sm ghost" onClick={() => deleteSelection()} title={tx('Supprimer (Suppr)')}><Icon name="trash" size={14} /></button>
        <button className="btn icon sm ghost" onClick={addMarker} title={tx('Marqueur (M)')}><Icon name="marker" size={14} /></button>
        <Dropdown width={190} button={(_, tg) => <button className="btn sm ghost" onClick={tg} title={tx('Ajouter une piste')}><Icon name="plus" size={12} /> {tx('Piste')}</button>}>
          {(close) => (
            <>
              <button onClick={() => { addTrack('video'); close(); }}><Icon name="film" size={14} /> {tx('Vidéo')}</button>
              <button onClick={() => { addTrack('text'); close(); }}><Icon name="text" size={14} /> {tx('Titres')}</button>
              <button onClick={() => { addTrack('audio'); close(); }}><Icon name="audio" size={14} /> {tx('Audio')}</button>
            </>
          )}
        </Dropdown>
        <span className="spacer" />
        {hint ? <span className="tl-hint">{hint}</span> : null}
        <button className="btn icon sm ghost" onClick={() => zoomBy(1 / 1.4)} title={tx('Dézoomer (−)')}><Icon name="zoomout" size={14} /></button>
        <input type="range" min={0} max={100} value={Math.round((Math.log(pps) / Math.log(600)) * 100)} onChange={(e) => setPps(Math.max(1, Math.pow(600, Number(e.target.value) / 100)))} style={{ width: 110 }} className="d-only" />
        <button className="btn icon sm ghost" onClick={() => zoomBy(1.4)} title={tx('Zoomer (+)')}><Icon name="zoomin" size={14} /></button>
        <button className="btn icon sm ghost" onClick={fit} title={tx('Tout afficher (⇧Z)')}><Icon name="fit" size={14} /></button>
      </div>
      <div className="tl-main">
        <div className="tl-tools">
          <button className={`btn icon sm ${tool === 'select' ? 'on' : 'ghost'}`} onClick={() => setUi({ tool: 'select' })} title={tx('Sélection (V)')}><Icon name="cursor" size={14} /></button>
          <button className={`btn icon sm ${tool === 'razor' ? 'on' : 'ghost'}`} onClick={() => setUi({ tool: 'razor' })} title={tx('Lame (C)')}><Icon name="razor" size={14} /></button>
          <button className={`btn icon sm ${snap ? 'on' : 'ghost'}`} onClick={() => setUi({ snap: !snap })} title={tx('Magnétisme')}><Icon name="magnet" size={14} /></button>
        </div>
        <div className="tl-heads" ref={heads}>
          <div className="tl-ruler-pad" />
          {rows.map((rw) => (
            <div key={rw.key} className={`thead ${trackOver === rw.key ? 'drop-ok' : ''}`} style={{ height: rw.h }} onContextMenu={(e) => { if (rw.kind === 'track') trackMenu(e, rw.tr); }}
              draggable={rw.kind === 'track' && !rw.tr.role} title={rw.kind === 'track' ? tx('Glisser pour changer l’ordre des pistes') : undefined}
              onDragStart={(e) => { if (rw.kind === 'track') { e.dataTransfer.setData(TRACK_DND, rw.tr.id); e.dataTransfer.effectAllowed = 'move'; } }}
              onDragOver={(e) => { if (rw.kind === 'track' && e.dataTransfer.types.includes(TRACK_DND)) { e.preventDefault(); setTrackOver(rw.key); } }}
              onDragLeave={() => setTrackOver((o) => (o === rw.key ? null : o))}
              onDrop={(e) => {
                setTrackOver(null);
                const id = e.dataTransfer.getData(TRACK_DND);
                if (!id || rw.kind !== 'track') return;
                e.preventDefault();
                moveTrack(id, tracks.findIndex((t) => t.id === rw.tr.id));
              }}>
              {headFor(rw)}
            </div>
          ))}
          <div style={{ height: 160 }} />
        </div>
        <div className={`tl-scroll ${tool === 'razor' ? 'razor' : ''}`} ref={scroll}>
          <div className="tl-inner" style={{ width }}>
            <div className="tl-ruler" onPointerDown={(e) => { if (e.button !== 0) return; capture(e); drag.current = { mode: 'scrub' }; seek(timeAt(e.clientX) * fps); }}>
              {ticks.map((k) => (
                <React.Fragment key={k}>
                  <div className="tick" style={{ left: X(k) }}>{ruler(k)}</div>
                  {[1, 2, 3, 4].map((q) => <div key={q} className="tick-minor" style={{ left: X(k + (step * q) / 5) }} />)}
                </React.Fragment>
              ))}
              {r.chapters.map((c) => <div key={c.from} className="chapter" style={{ left: X(c.from / fps) }}>{c.label}</div>)}
              {(project.markers || []).map((m) => (
                <div key={m.id} className="marker" style={{ left: X(m.t) }} title={m.label || tx('Marqueur (double-clic : supprimer)')}
                  onPointerDown={(e) => { e.stopPropagation(); seek(m.t * fps); }}
                  onDoubleClick={(e) => { e.stopPropagation(); update((p) => { p.markers = (p.markers || []).filter((x) => x.id !== m.id); }); }} />
              ))}
            </div>

            {rows.map((rw) => (
              <div key={rw.key} className={`track ${overId === rw.key ? 'drop-ok' : ''}`} style={{ height: rw.h }}
                onDragOver={(e) => { if (accepts(rw, e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (overId !== rw.key) setOverId(rw.key); } }}
                onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOverId((o) => (o === rw.key ? null : o)); }}
                onDrop={(e) => onDrop(e, rw)}
                onContextMenu={(e) => { if (e.target === e.currentTarget) emptyMenu(e); }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || e.target !== e.currentTarget) return;
                  if (tool === 'razor') { razorAt(e.clientX); return; }
                  select({}); capture(e); drag.current = { mode: 'scrub' }; seek(timeAt(e.clientX) * fps);
                }}>
                {rw.kind === 'track' ? trackClips(rw.tr, rw.h) : null}
                {ghost && ghost.key === rw.key ? <div className="drop-ghost" style={{ left: ghost.left, width: ghost.width }} /> : null}
                {rw.kind === 'v1' ? r.items.map((ri) => {
                  const b = project.timeline.find((i) => i.id === ri.id)?.before || 0;
                  if (b <= 0) return null;
                  const x1 = X(ri.from / fps), x0 = Math.max(0, x1 - X(b));
                  return <div key={`gap${ri.id}`} className="gap" style={{ left: x0, width: Math.max(2, x1 - x0) }} title={tx('Espace vide : {0} s (double-clic : fermer)', b.toFixed(2))}
                    onDoubleClick={(e) => { e.stopPropagation(); closeGap(ri.id); }}
                    onContextMenu={(e) => { e.stopPropagation(); contextMenu(e, [{ label: tx("Fermer l'espace"), icon: 'trash', onClick: () => closeGap(ri.id) }]); }} />;
                }) : null}

                {rw.kind === 'v1' ? <V1Row thumbsOn={prefs.thumbs} r={r} project={project} pps={pps} h={rw.h - 4} visible={visible} sel={sel} dragging={dragging}
                  onDown={(id, e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    if (tool === 'razor') { razorAt(e.clientX); return; }
                    select({ itemId: id });
                    capture(e);
                    const k = project.timeline.findIndex((i) => i.id === id);
                    const ri = r.items.find((x) => x.id === id);
                    const next = project.timeline[k + 1];
                    ghostRef.current = null;
                    drag.current = { mode: 'reorder', sid: uid('d'), id, x0: e.clientX, y0: e.clientY, active: false, idx: null, seekT: e.altKey ? getFrame() / fps : timeAt(e.clientX),
                      start0: (ri?.from || 0) / fps, dur: (ri?.dur || 0) / fps, before0: project.timeline[k]?.before || 0, nextId: next?.id || null, nextBefore0: next?.before || 0,
                      changed: false, toTrack: null };
                  }}
                  onMenu={itemMenu}
                  onTrim={(id, side, e, v0, rate) => {
                    if (e.button !== 0) return;
                    e.stopPropagation(); e.preventDefault();
                    select({ itemId: id });
                    capture(e);
                    drag.current = { mode: 'trim', sid: uid('d'), id, side, x0: e.clientX, v0, rate, active: false };
                  }}
                /> : null}

                {rw.kind === 'captions' ? r.captions.filter((c) => visible(X(c.from / fps), X((c.from + c.dur) / fps))).map((c) => (
                  <div key={c.id} className="mark" title={c.text}
                    style={{ left: X(c.from / fps), width: Math.max(2, X(c.dur / fps) - 1), background: spkColor(c.speaker), opacity: mix.captionsHidden ? 0.35 : sel.capId === c.id ? 1 : 0.8,
                      boxShadow: selShadow(sel.capId === c.id), fontWeight: c.style === 'normal' ? 500 : 800 }}
                    onPointerDown={(e) => markDown(e, { itemId: c.itemId, capId: c.id, from: c.from })}>{c.text}{markHandles({ itemId: c.itemId, capId: c.id, from: c.from }, X(c.dur / fps))}</div>
                )) : null}

                {rw.kind === 'fx' ? (
                  <>
                    {r.transitions.map((z, i) => <div key={`tr${i}`} className="mark" style={{ left: X(z.from / fps), width: Math.max(4, X(z.dur / fps)), background: '#c9a0ff' }} title={`${tx('Transition')} : ${z.kind}`} />)}
                    {r.zooms.map((z, i) => (
                      <div key={`z${i}`} className="mark" style={{ left: X(z.from / fps), width: Math.max(2, X(z.dur / fps)), background: z.auto ? 'rgba(110,190,255,.35)' : '#6ebeff', boxShadow: selShadow(!!z.ref && sel.fxId === z.ref.fxId) }}
                        title={`Zoom ×${z.scale.toFixed(2)}${z.auto ? ` (${tx('automatique')})` : ''}`}
                        onPointerDown={(e) => { if (z.ref) markDown(e, { ...z.ref, from: z.from }); else { e.stopPropagation(); seek(z.from); } }}>
                        {tx('×')}{z.scale.toFixed(1)}{z.ref ? markHandles({ ...z.ref, from: z.from }, X(z.dur / fps)) : null}
                      </div>
                    ))}
                    {r.shakes.map((z, i) => (
                      <div key={`s${i}`} className="mark" style={{ left: X(z.from / fps), width: Math.max(2, X(z.dur / fps)), background: '#e8c35a', top: 10, boxShadow: selShadow(!!z.ref && sel.fxId === z.ref.fxId) }} title={tx('Secousse')}
                        onPointerDown={(e) => { if (z.ref) markDown(e, { ...z.ref, from: z.from }); else { e.stopPropagation(); seek(z.from); } }}>
                        {z.ref ? markHandles({ ...z.ref, from: z.from }, X(z.dur / fps)) : null}
                      </div>
                    ))}
                    {r.tints.map((z, i) => (
                      <div key={`t${i}`} className="mark" style={{ left: X(z.from / fps), width: Math.max(2, X(z.dur / fps)), background: z.mode === 'bw' ? '#aaa' : z.mode === 'red' ? '#ff7a7a' : '#fff', boxShadow: selShadow(!!z.ref && sel.fxId === z.ref.fxId) }} title={z.mode}
                        onPointerDown={(e) => { if (z.ref) markDown(e, { ...z.ref, from: z.from }); else { e.stopPropagation(); seek(z.from); } }}>
                        {z.mode === 'bw' ? 'N&B' : z.mode}{z.ref ? markHandles({ ...z.ref, from: z.from }, X(z.dur / fps)) : null}
                      </div>
                    ))}
                    {r.texts.map((z, i) => (
                      <div key={`x${i}`} className="mark" style={{ left: X(z.from / fps), width: Math.max(2, X(z.dur / fps)), background: '#e59ad8', boxShadow: selShadow(!!z.ref && sel.fxId === z.ref.fxId) }} title={z.text}
                        onPointerDown={(e) => { if (z.ref) markDown(e, { ...z.ref, from: z.from }); else { e.stopPropagation(); seek(z.from); } }}>
                        {z.text}{z.ref ? markHandles({ ...z.ref, from: z.from }, X(z.dur / fps), true) : null}
                      </div>
                    ))}
                  </>
                ) : null}

                {rw.kind === 'voice' && prefs.waves ? <VoiceWave r={r} project={project} pps={pps} left={view.left} width={view.width} h={rw.h} muted={!!mix.voiceMuted} /> : null}

                {rw.kind === 'music' ? r.music.map((m) => (
                  <div key={m.key} className={`clip music ${sel.musicId === m.key ? 'sel' : ''}`} style={{ left: X(m.from / fps), width: Math.max(4, X(m.dur / fps)), opacity: mix.musicMuted ? 0.4 : 1 }}
                    onPointerDown={(e) => { e.stopPropagation(); select({ musicId: m.key }); }}>
                    <div className="cl-name"><Icon name="music" size={10} /> {m.name}</div>
                    <FileWave path={pathOf(m.url)} w={Math.max(4, X(m.dur / fps))} h={rw.h - 19} color="rgba(255,255,255,.55)" offset={m.offset} pps={pps} />
                  </div>
                )) : null}

                {rw.kind === 'sfx' ? r.sfx.filter((s) => visible(X(s.from / fps), X((s.from + s.dur) / fps))).map((s) => (
                  <div key={s.key} className="mark" style={{ left: X(s.from / fps), width: Math.max(3, X(s.dur / fps)), background: s.name === 'censor' ? '#ff7a7a' : '#7fd6a4', opacity: mix.sfxMuted ? 0.4 : 1,
                    boxShadow: selShadow(!!s.ref && sel.fxId === s.ref.fxId) }}
                    title={s.name} onPointerDown={(e) => { if (s.ref) markDown(e, { ...s.ref, from: s.from }); else { e.stopPropagation(); seek(s.from); } }}>{s.name.startsWith('f:') ? '' : s.name}</div>
                )) : null}

                {rw.kind !== 'track' && 'tr' in rw && rw.tr ? trackClips(rw.tr, rw.h) : null}
              </div>
            ))}

            <div style={{ height: 160 }} className={overId === '__new' ? 'drop-ok' : ''}
              onDragOver={(e) => { if (accepts(null, e.dataTransfer.types)) { e.preventDefault(); setOverId('__new'); } }}
              onDragLeave={() => setOverId((o) => (o === '__new' ? null : o))}
              onDrop={(e) => onDrop(e, null)} onContextMenu={emptyMenu} />
            {snapAt !== null ? <div className="snapline" style={{ left: X(snapAt) }} /> : null}
            {insertX !== null ? <div className="insert-line" style={{ left: insertX - 1 }} /> : null}
            <div className="playhead" ref={head} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- V1: the main edit (shots with thumbnails)
function V1Row({ thumbsOn, r, project, pps, h, visible, sel, dragging, onDown, onMenu, onTrim }: {
  thumbsOn: boolean; r: Resolved; project: Project; pps: number; h: number; visible: (a: number, b: number) => boolean; sel: { itemId?: string }; dragging: string | null;
  onDown: (id: string, e: React.PointerEvent) => void; onMenu: (e: React.MouseEvent, id: string) => void;
  onTrim: (id: string, side: 'in' | 'out' | 'dur', e: React.PointerEvent, v0: number, rate: number) => void;
}) {
  const fps = r.fps;
  const sprites = useSpritesMany(project.sources.filter((s) => s.kind === 'video').map((s) => previewPath(s)));
  const fh = h - 15;
  const tw = Math.max(20, Math.round((fh * 16) / 9));
  return (
    <>
      {r.items.map((ri) => {
        const it = project.timeline.find((i) => i.id === ri.id) as Item | undefined;
        if (!it) return null;
        const x0 = (ri.from / fps) * pps;
        const w = Math.max(4, (ri.dur / fps) * pps);
        if (!visible(x0, x0 + w)) return null;
        const src = it.type === 'clip' || it.type === 'freeze' ? project.sources.find((s) => s.id === it.src) : undefined;
        const label = it.type === 'clip' ? (it.label || src?.name || tx('Plan')) : it.type === 'card' ? (it.text.split('\n')[0] || (it.image ? tx('Image') : tx('Carton'))) : it.type === 'freeze' ? tx('Arrêt sur image') : (it.path.split(/[\\/]/).pop() || tx('Média'));
        const rate = it.type === 'clip' ? (ri.segs[0]?.rate || 1) : 1;
        const sp = src ? sprites[previewPath(src) || ''] : undefined;
        const hw = Math.max(3, Math.min(8, w / 4));
        const thumbs: React.ReactNode[] = [];
        if (thumbsOn && sp && fh > 10 && (it.type === 'clip' || it.type === 'freeze')) {
          const n = Math.ceil(w / tw);
          for (let k = 0; k < n; k++) {
            const ax = x0 + k * tw;
            if (!visible(ax, ax + tw)) { thumbs.push(<div key={k} style={{ width: tw, height: fh }} />); continue; }
            const f = ri.from + ((k * tw + tw / 2) / pps) * fps;
            const tt = it.type === 'freeze' ? it.t : frameToSrc(r, Math.min(f, ri.from + ri.dur - 1))?.t ?? it.in;
            thumbs.push(<div key={k} style={spriteCell(sp, tt ?? 0, fh)} />);
          }
        }
        return (
          <div key={ri.id} className={`clip ${it.type === 'clip' ? 'v1' : it.type} ${sel.itemId === ri.id ? 'sel' : ''} ${dragging === ri.id ? 'ghost' : ''}`}
            style={{ left: x0, width: w }} title={it.note ? `${label}\n${tx('Choix de l’IA')} : ${it.note}` : label}
            onPointerDown={(e) => onDown(ri.id, e)} onContextMenu={(e) => onMenu(e, ri.id)}>
            <div className="cl-name">
              {it.type === 'card' ? <Icon name="text" size={10} /> : it.type === 'freeze' ? <Icon name="freeze" size={10} /> : it.type === 'media' ? <Icon name="image" size={10} /> : null}
              {'audioOff' in it && it.audioOff ? <span title={tx('Son délié')} style={{ display: 'inline-flex' }}><Icon name="mute" size={10} /></span> : null}
              <span className="ellipsis">{label}</span>
            </div>
            {thumbs.length ? <div className="film">{thumbs}</div> : null}
            {it.type === 'clip' ? ri.segs.slice(1).map((s) => (
              <span key={s.key} style={{ position: 'absolute', left: ((s.from - ri.from) / fps) * pps, top: 15, bottom: 0, borderLeft: '1px solid rgba(0,0,0,.55)', zIndex: 1 }} />
            )) : null}
            {'transition' in it && it.transition ? <span className="trans" style={{ width: Math.max(6, it.transition.dur * pps) }} title={`${tx('Transition')} : ${it.transition.kind}`} /> : null}
            {it.type === 'clip' ? (
              <>
                <span className="hdl" style={{ left: 0, width: hw }} onPointerDown={(e) => onTrim(it.id, 'in', e, it.in, rate)} />
                <span className="hdl" style={{ right: 0, width: hw }} onPointerDown={(e) => onTrim(it.id, 'out', e, it.out, rate)} />
              </>
            ) : <span className="hdl" style={{ right: 0, width: hw }} onPointerDown={(e) => onTrim(it.id, 'dur', e, it.dur, 1)} />}
          </div>
        );
      })}
    </>
  );
}

// ---------- content of a free track clip
function ClipFace({ c, w, h, project }: { c: OClip; w: number; h: number; project: Project }) {
  if (c.type === 'text') return <div className="cl-name"><Icon name="text" size={10} /> <span className="ellipsis">{c.text}</span></div>;
  if (c.type === 'audio') {
    const src = c.src ? project.sources.find((s) => s.id === c.src) : undefined;
    const path = src ? previewPath(src) || src.path : pathOf(c.url) || c.path;
    return (
      <>
        <div className="cl-name">{c.link ? <span title={tx('Son délié d’une vidéo (⌘L : rattacher)')} style={{ display: 'inline-flex' }}><Icon name="link" size={10} /></span> : <Icon name="audio" size={10} />} <span className="ellipsis">{c.name || src?.name || (path || '').split(/[\\/]/).pop()}</span></div>
        <FileWave path={path} w={w} h={h - 15} color="rgba(255,255,255,.55)" offset={c.in} pps={w / Math.max(0.1, c.dur * (c.speed || 1))} />
      </>
    );
  }
  return <VideoFace c={c} w={w} h={h} project={project} />;
}

function VideoFace({ c, w, h, project }: { c: Extract<OClip, { type: 'video' }>; w: number; h: number; project: Project }) {
  const src = c.src ? project.sources.find((s) => s.id === c.src) : undefined;
  const path = src ? previewPath(src) : pathOf(c.url) || c.path || null;
  const sprites = useSpritesMany(c.kind === 'video' ? [path] : []);
  const sp = path ? sprites[path] : undefined;
  const fh = h - 15;
  const tw = Math.max(20, Math.round((fh * 16) / 9));
  const n = Math.min(40, Math.ceil(w / tw));
  return (
    <>
      <div className="cl-name"><Icon name={c.kind === 'image' ? 'image' : 'film'} size={10} /> <span className="ellipsis">{c.name || (path || '').split(/[\\/]/).pop()}</span></div>
      {fh > 10 && c.kind === 'image' && path ? <div className="film" style={{ backgroundImage: `url(/api/thumb?p=${encodeURIComponent(path)}&w=160)`, backgroundSize: `${tw}px ${fh}px`, backgroundRepeat: 'repeat-x' }} /> : null}
      {fh > 10 && sp ? <div className="film">{Array.from({ length: n }, (_, k) => <div key={k} style={spriteCell(sp, (c.in || 0) + ((k * tw) / w) * c.dur * (c.speed || 1), fh)} />)}</div> : null}
    </>
  );
}

// ---------- waveforms
function drawPeaks(cv: HTMLCanvasElement | null, w: number, h: number, sample: (px: number) => number, color: string) {
  if (!cv || w < 1 || h < 1) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const g = cv.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  const mid = h / 2;
  for (let px = 0; px < w; px += 2) {
    const v = sample(px);
    if (v <= 0) continue;
    const a = Math.max(0.5, (v / 255) * (h * 0.48));
    g.fillRect(px, mid - a, 1.4, a * 2);
  }
}

function FileWave({ path, w, h, color, offset = 0, pps }: { path: string | null | undefined; w: number; h: number; color: string; offset?: number; pps: number }) {
  const pk = usePeaks(path);
  const cv = useRef<HTMLCanvasElement>(null);
  const cw = Math.min(w, 6000);
  useEffect(() => {
    if (!pk) return;
    drawPeaks(cv.current, cw, h, (px) => {
      const t = offset + (px * (w / cw)) / pps;
      const i = Math.floor(t * pk.rate) % Math.max(1, pk.peaks.length);
      return pk.peaks[i] || 0;
    }, color);
  }, [pk, cw, w, h, color, offset, pps]);
  return h > 4 ? <canvas ref={cv} style={{ width: cw, height: h }} /> : null;
}

function VoiceWave({ r, project, pps, left, width, h, muted }: { r: Resolved; project: Project; pps: number; left: number; width: number; h: number; muted: boolean }) {
  const map = usePeaksMany(project.sources.map((s) => previewPath(s)));
  const cv = useRef<HTMLCanvasElement>(null);
  const byId = useMemo(() => new Map(project.sources.map((s) => [s.id, map[previewPath(s) || '']] as [string, Peaks | undefined])), [project.sources, map]);
  const off = useMemo(() => new Set(project.timeline.filter((i) => 'audioOff' in i && i.audioOff).map((i) => i.id)), [project.timeline]);
  useEffect(() => {
    drawPeaks(cv.current, width, h - 4, (px) => {
      const f = ((left + px) / pps) * r.fps;
      const hit = frameToSrc(r, f);
      if (!hit || hit.t === null) return 0;
      if (off.has(hit.itemId)) return 0;
      const ri = r.items.find((x) => x.id === hit.itemId);
      const seg = ri?.segs[0];
      const pk = seg ? byId.get(seg.src) : undefined;
      return pk ? pk.peaks[Math.floor(hit.t * pk.rate)] || 0 : 0;
    }, muted ? '#3a3d44' : '#6fcf97');
  }, [r, pps, left, width, h, byId, muted, off]);
  return (
    <>
      {r.items.map((ri) => ri.segs.length && !off.has(ri.id) ? (
        <div key={ri.id} style={{ position: 'absolute', left: (ri.from / r.fps) * pps, width: (ri.dur / r.fps) * pps, top: 2, bottom: 2, borderRadius: 3, background: 'rgba(47,122,87,.28)', border: '1px solid rgba(47,122,87,.6)', pointerEvents: 'none' }} />
      ) : null)}
      <canvas ref={cv} style={{ position: 'absolute', left, top: 2, width, height: h - 4, pointerEvents: 'none' }} />
    </>
  );
}

// ---------- data dragged from the panels
export type DropData =
  | { type: 'source'; id: string; a?: number; b?: number }
  | { type: 'file'; path: string; url: string; media: 'video' | 'image' | 'audio'; name: string; dur: number }
  | { type: 'text'; preset: string; text: string; style: TextStyle }
  | { type: 'transition'; kind: TransitionKind }
  | { type: 'effect'; kind: import('../types').VFxKind }
  | { type: 'preset'; id: string };

function makeClip(d: DropData, t: number, p: Project): OClip | null {
  if (d.type === 'text') return { id: uid('o'), type: 'text', start: t, dur: getPrefs().textDur, text: d.text, style: { ...d.style } };
  if (d.type === 'source') {
    const s = p.sources.find((x) => x.id === d.id);
    if (!s) return null;
    const a = d.a ?? 0, b = d.b ?? s.duration;
    if (s.kind === 'audio') return { id: uid('o'), type: 'audio', src: s.id, start: t, dur: Math.max(0.2, b - a), in: a, volumeDb: 0, name: s.name };
    return { id: uid('o'), type: 'video', src: s.id, kind: s.kind === 'image' ? 'image' : 'video', start: t, dur: s.kind === 'image' ? getPrefs().imageDur : Math.max(0.2, Math.min(b - a, d.b !== undefined ? Infinity : 10)), in: a, name: s.name, look: {} };
  }
  if (d.type === 'file') {
    if (d.media === 'audio') return { id: uid('o'), type: 'audio', path: d.path, url: d.url, start: t, dur: Math.max(0.3, d.dur || 5), in: 0, volumeDb: 0, name: d.name };
    const green = /green|vert|chroma/i.test(d.name);
    return { id: uid('o'), type: 'video', path: d.path, url: d.url, kind: d.media, start: t, dur: d.media === 'image' ? getPrefs().imageDur : Math.max(0.5, d.dur || 4), in: 0, name: d.name,
      look: green ? { chroma: '#00ff00' } : {}, fadeIn: 0.1, fadeOut: 0.15 };
  }
  return null;
}
