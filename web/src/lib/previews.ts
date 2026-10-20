// Aperçus servis par le serveur (calculés à la demande, mis en cache) : vignettes, planches (filmstrip), formes d'onde.
import { useEffect, useState, type CSSProperties } from 'react';

export interface Sprite { url: string; interval: number; cols: number; n: number; w: number; h: number }
export interface Peaks { rate: number; peaks: number[] }

/** chemin disque d'une URL /api/file?p=… */
export const pathOf = (url?: string | null) => {
  if (!url) return null;
  const m = url.match(/[?&]p=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

export const thumbUrl = (path: string | null | undefined, t = 0, w = 320) =>
  path ? `/api/thumb?p=${encodeURIComponent(path)}&t=${t.toFixed(1)}&w=${w}` : '';

const cache = new Map<string, unknown>();
const waiting = new Map<string, Promise<unknown>>();

function poll<T>(kind: 'sprite' | 'peaks', path: string): Promise<T | null> {
  const key = `${kind}:${path}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key) as T);
  if (waiting.has(key)) return waiting.get(key) as Promise<T | null>;
  const p = (async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`/api/${kind}?p=${encodeURIComponent(path)}`);
        if (!r.ok) return null;
        const j = await r.json();
        if (!j.pending) { cache.set(key, j); return j as T; }
      } catch { return null; }
      await new Promise((res) => setTimeout(res, 2500));
    }
    return null;
  })();
  waiting.set(key, p);
  p.finally(() => waiting.delete(key));
  return p;
}

function usePreview<T>(kind: 'sprite' | 'peaks', path: string | null | undefined): T | null {
  const [v, setV] = useState<T | null>(() => (path ? (cache.get(`${kind}:${path}`) as T) || null : null));
  useEffect(() => {
    if (!path) { setV(null); return; }
    let live = true;
    poll<T>(kind, path).then((x) => { if (live) setV(x); });
    return () => { live = false; };
  }, [kind, path]);
  return v;
}

export const useSprite = (path: string | null | undefined) => usePreview<Sprite>('sprite', path);
export const usePeaks = (path: string | null | undefined) => usePreview<Peaks>('peaks', path);

/** style CSS d'une vignette de la planche à l'instant t */
export function spriteCell(sp: Sprite, t: number, h: number): CSSProperties {
  const i = Math.max(0, Math.min(sp.n - 1, Math.floor(t / sp.interval)));
  const scale = h / sp.h;
  const cols = sp.cols;
  const rows = Math.ceil(sp.n / cols);
  return {
    backgroundImage: `url(${sp.url})`,
    backgroundSize: `${cols * sp.w * scale}px ${rows * sp.h * scale}px`,
    backgroundPosition: `${-(i % cols) * sp.w * scale}px ${-Math.floor(i / cols) * sp.h * scale}px`,
    width: sp.w * scale,
    height: h,
  };
}

/** plusieurs formes d'onde à la fois (une par source) */
export function usePeaksMany(paths: (string | null | undefined)[]): Record<string, Peaks> {
  const key = paths.filter(Boolean).sort().join('|');
  const [map, setMap] = useState<Record<string, Peaks>>({});
  useEffect(() => {
    let live = true;
    for (const p of key ? key.split('|') : []) {
      poll<Peaks>('peaks', p).then((x) => { if (live && x) setMap((m) => (m[p] ? m : { ...m, [p]: x })); });
    }
    return () => { live = false; };
  }, [key]);
  return map;
}

/** même chose pour les planches de vignettes */
export function useSpritesMany(paths: (string | null | undefined)[]): Record<string, Sprite> {
  const key = paths.filter(Boolean).sort().join('|');
  const [map, setMap] = useState<Record<string, Sprite>>({});
  useEffect(() => {
    let live = true;
    for (const p of key ? key.split('|') : []) {
      poll<Sprite>('sprite', p).then((x) => { if (live && x) setMap((m) => (m[p] ? m : { ...m, [p]: x })); });
    }
    return () => { live = false; };
  }, [key]);
  return map;
}

/** chemin à utiliser pour les aperçus d'une source : la vidéo légère si elle existe */
export const previewPath = (s: { path: string; proxy?: string | null } | undefined) => (s ? pathOf(s.proxy) || s.path : null);
