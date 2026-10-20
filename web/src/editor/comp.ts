import { createContext, useContext, useMemo } from 'react';
import { useStore } from '../lib/store';
import type { CompositionProps, ClipItem, Item } from '../types';
import { mergeStyle, resolve, type Resolved } from '../remotion/resolve';

export interface CompCtx { props: CompositionProps; r: Resolved; style: ReturnType<typeof mergeStyle> }
export const Comp = createContext<CompCtx | null>(null);
export const useComp = () => useContext(Comp)!;

/** props de la composition (aperçu) + timeline résolue, recalculées à chaque modification */
export function useBuildComp(): CompCtx | null {
  const project = useStore((s) => s.project);
  const words = useStore((s) => s.words);
  const speakers = useStore((s) => s.speakers);
  const packs = useStore((s) => s.packs);
  const library = useStore((s) => s.library);
  return useMemo(() => {
    if (!project) return null;
    const pack = packs.find((p) => p.id === project.packId);
    // banque de sons (iCloud) pas encore lisible : on n'essaie pas de charger musiques, VFX ni outro (le lecteur
    // attendrait ces fichiers indéfiniment et l'image resterait noire)
    const bankLocked = !library;
    const isBank = (u?: string | null) => !!u && decodeURIComponent(u).includes('/Library/Mobile Documents/');
    const shown = bankLocked ? {
      ...project,
      music: [],
      tracks: (project.tracks || []).map((t) => ({ ...t, clips: t.clips.filter((c) => !('url' in c) || !isBank(c.url)) })),
      timeline: project.timeline.map((it) => (it.type === 'media' && isBank(it.url) ? { ...it, url: '' } : it)),
    } : project;
    const props: CompositionProps = {
      project: shown, words,
      pack: { id: project.packId, style: pack?.style || ({} as CompositionProps['pack']['style']) },
      speakers: Object.fromEntries(speakers.map((s) => [s.id, { name: s.name, color: s.color }])),
      sfx: library?.sfx || {},
      logo: project.logoUrl || null,
      mode: 'preview',
    };
    return { props, r: resolve(props), style: mergeStyle(pack?.style, project.overrides) };
  }, [project, words, speakers, packs, library]);
}

/** plan (et temps source) sous une image de sortie */
export function clipAt(r: Resolved, timeline: Item[], f: number): { clip: ClipItem; t: number } | null {
  for (const it of r.items) {
    if (f < it.from || f >= it.from + it.dur) continue;
    const item = timeline.find((x) => x.id === it.id);
    if (!item || item.type !== 'clip') return null;
    for (const s of it.segs) {
      if (f >= s.from && f < s.from + s.dur) return { clip: item, t: s.a + ((f - s.from) / r.fps) * s.rate };
    }
  }
  return null;
}
