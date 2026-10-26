// Picture settings of a shot / an overlay: transform, opacity, blending, crop, color grading, green screen.
// Grading goes through an SVG filter (curve + color matrix): identical output in the preview and the export.
import React from 'react';
import type { ColorAdj, Look } from '../types';
import { cssFx, needsSvgFx, PixelFilter, svgFx } from './effects';

export const COLOR_PRESETS: Record<string, { label: string; adj: ColorAdj }> = {
  none: { label: 'Aucun', adj: {} },
  film: { label: 'Film', adj: { contrast: 12, saturation: -12, temperature: 8, shadows: 10, highlights: -10, vignette: 25 } },
  vif: { label: 'Vif', adj: { contrast: 15, saturation: 35, exposure: 3 } },
  doux: { label: 'Doux', adj: { contrast: -18, saturation: -8, shadows: 18, exposure: 4 } },
  nb: { label: 'N&B', adj: { saturation: -100, contrast: 18 } },
  chaud: { label: 'Chaud', adj: { temperature: 35, saturation: 8, tint: 4 } },
  froid: { label: 'Froid', adj: { temperature: -35, saturation: -5, contrast: 6 } },
  vintage: { label: 'Vintage', adj: { contrast: -10, saturation: -30, temperature: 25, shadows: 22, vignette: 40 } },
  nuit: { label: 'Nuit', adj: { exposure: -18, temperature: -40, saturation: -20, contrast: 10, vignette: 35 } },
  punch: { label: 'Punch', adj: { contrast: 30, saturation: 20, highlights: -15, shadows: -10, vignette: 20 } },
};

export const BLENDS: [string, string][] = [
  ['normal', 'Normal'], ['multiply', 'Produit'], ['screen', 'Superposition (écran)'], ['overlay', 'Incrustation'],
  ['darken', 'Obscurcir'], ['lighten', 'Éclaircir'], ['color-dodge', 'Densité couleur −'], ['soft-light', 'Lumière tamisée'],
  ['hard-light', 'Lumière crue'], ['difference', 'Différence'], ['luminosity', 'Luminosité'],
];

/** effective color settings (preset + adjustments on top) */
export function colorOf(look?: Look): ColorAdj {
  const c = look?.color || {};
  const base = c.preset ? COLOR_PRESETS[c.preset]?.adj || {} : {};
  const out: ColorAdj = { ...base };
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'vignette'] as const) {
    if (c[k] !== undefined) out[k] = (base[k] || 0) + (c[k] || 0);
  }
  return out;
}

const hasColor = (c: ColorAdj) => ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'].some((k) => (c as Record<string, number>)[k]);
export const needsFilter = (look?: Look) => !!look && (hasColor(colorOf(look)) || !!look.chroma || needsSvgFx(look));

function curve(c: ColorAdj): string {
  const e = Math.pow(2, (c.exposure || 0) / 100);
  const k = 1 + (c.contrast || 0) / 100;
  const sh = (c.shadows || 0) / 100;
  const hi = (c.highlights || 0) / 100;
  const pts: string[] = [];
  for (let i = 0; i <= 16; i++) {
    let v = i / 16;
    v = v * e;
    v = v + sh * 0.35 * Math.pow(1 - Math.min(1, v), 3);
    v = v + hi * 0.3 * Math.pow(Math.min(1, v), 3);
    v = (v - 0.5) * k + 0.5;
    pts.push(Math.max(0, Math.min(1, v)).toFixed(4));
  }
  return pts.join(' ');
}

/** SVG filter definitions (one per shot / overlay that needs it) */
export const LookFilters: React.FC<{ looks: { id: string; look?: Look }[]; k?: number; frame?: number; w?: number; h?: number }> = ({ looks, k = 1, frame = 0, w = 1920, h = 1080 }) => {
  const used = looks.filter((l) => needsFilter(l.look));
  const pix = looks.filter((l) => (l.look?.effects || []).some((e) => e.kind === 'pixelate' && e.on !== false));
  if (!used.length && !pix.length) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        {used.map(({ id, look }) => {
          const c = colorOf(look);
          const t = (c.temperature || 0) / 100;
          const tn = (c.tint || 0) / 100;
          const s = 1 + (c.saturation || 0) / 100;
          const tbl = curve(c);
          const blue = (look!.chroma || '').toLowerCase().startsWith('#00') && (look!.chroma || '').toLowerCase().endsWith('ff');
          return (
            <filter key={id} id={`look-${id}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
              {look!.chroma ? (
                <feColorMatrix type="matrix" values={blue
                  ? '1 0 0 0 0  0 1 0 0 0  0.125 0.125 0.75 0 0  2 2 -4 0 1'
                  : '1 0 0 0 0  0.125 0.75 0.125 0 0  0 0 1 0 0  2 -4 2 0 1'} />
              ) : null}
              <feComponentTransfer>
                <feFuncR type="table" tableValues={tbl} />
                <feFuncG type="table" tableValues={tbl} />
                <feFuncB type="table" tableValues={tbl} />
              </feComponentTransfer>
              <feColorMatrix type="saturate" values={String(Math.max(0, s))} />
              <feColorMatrix type="matrix" values={`${1 + t * 0.14} 0 0 0 ${t * 0.03}  0 ${1 - tn * 0.12} 0 0 0  0 0 ${1 - t * 0.14} 0 ${-t * 0.03}  0 0 0 1 0`} result="col" />
              {svgFx(look, k, frame)}
            </filter>
          );
        })}
        {pix.map(({ id, look }) => <PixelFilter key={`p${id}`} id={id} look={look} w={w} h={h} k={k} />)}
      </defs>
    </svg>
  );
};

/** CSS style of a layer (transform, opacity, blending, crop, filter) */
export function lookStyle(id: string, look: Look | undefined, extraTransform = '', k = 1): React.CSSProperties {
  if (!look) return extraTransform ? { transform: extraTransform } : {};
  const tr = [
    extraTransform,
    look.x || look.y ? `translate(${look.x || 0}%, ${look.y || 0}%)` : '',
    look.rotation ? `rotate(${look.rotation}deg)` : '',
    look.scale !== undefined && look.scale !== 1 ? `scale(${look.scale})` : '',
    look.flipH || look.flipV ? `scale(${look.flipH ? -1 : 1}, ${look.flipV ? -1 : 1})` : '',
  ].filter(Boolean).join(' ');
  const cr = look.crop;
  return {
    transform: tr || undefined,
    opacity: look.opacity ?? 1,
    mixBlendMode: (look.blend && look.blend !== 'normal' ? look.blend : undefined) as React.CSSProperties['mixBlendMode'],
    clipPath: cr && (cr.l || cr.t || cr.r || cr.b) ? `inset(${cr.t}% ${cr.r}% ${cr.b}% ${cr.l}%)` : undefined,
    filter: [needsFilter(look) ? `url(#look-${id})` : '', cssFx(look, k, id)].filter(Boolean).join(' ') || undefined,
  };
}

export const Vignette: React.FC<{ amount?: number }> = ({ amount }) =>
  amount ? (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
      background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.max(20, 70 - amount * 0.4)}%, rgba(0,0,0,${Math.min(0.85, amount / 100)}) 100%)` }} />
  ) : null;

/** approximate CSS preview of a preset (Color panel thumbnails, outside the composition) */
export function cssPreview(adj: ColorAdj): string {
  const e = 1 + (adj.exposure || 0) / 100;
  const k = 1 + (adj.contrast || 0) / 100;
  const s = 1 + (adj.saturation || 0) / 100;
  const t = adj.temperature || 0;
  return `brightness(${e}) contrast(${k}) saturate(${Math.max(0, s)}) sepia(${Math.max(0, t) / 250}) hue-rotate(${t < 0 ? t * 0.4 : 0}deg)`;
}
