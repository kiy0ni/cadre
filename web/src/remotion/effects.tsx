// General picture effects (catalog, parameters, rendering). Same code for the preview and the export.
// - SVG filters (sharpen, glow, grain, pixelate, chromatic aberration) appended to the layer filter (look.tsx);
// - CSS filters (blur, B&W, sepia, invert, hue, drop shadow);
// - framing (letterbox bars, rounded corners, border) and animation (two-keyframe motion, fades).
import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Look, VFx, VFxKind } from '../types';

export interface ParamDef { key: string; label: string; min?: number; max?: number; step?: number; def: number | string; unit?: string; options?: [string, string][]; color?: boolean }
export interface FxDef { kind: VFxKind; label: string; cat: string; icon: string; params: ParamDef[] }

export const FX_CATS: [string, string][] = [['anim', 'Animation'], ['flou', 'Flou et netteté'], ['style', 'Stylisation'], ['habillage', 'Habillage']];

export const FX_DEFS: FxDef[] = [
  { kind: 'motion', label: 'Mouvement (Ken Burns)', cat: 'anim', icon: 'zoomin', params: [
    { key: 'scale0', label: 'Échelle début', min: 50, max: 300, def: 100, unit: '%' }, { key: 'scale1', label: 'Échelle fin', min: 50, max: 300, def: 115, unit: '%' },
    { key: 'x0', label: 'X début', min: -50, max: 50, step: 0.5, def: 0, unit: '%' }, { key: 'x1', label: 'X fin', min: -50, max: 50, step: 0.5, def: 0, unit: '%' },
    { key: 'y0', label: 'Y début', min: -50, max: 50, step: 0.5, def: 0, unit: '%' }, { key: 'y1', label: 'Y fin', min: -50, max: 50, step: 0.5, def: 0, unit: '%' },
    { key: 'rot0', label: 'Rotation début', min: -45, max: 45, def: 0, unit: '°' }, { key: 'rot1', label: 'Rotation fin', min: -45, max: 45, def: 0, unit: '°' },
    { key: 'ease', label: 'Courbe', def: 'douce', options: [['douce', 'Douce'], ['lineaire', 'Linéaire'], ['entree', 'Accélère'], ['sortie', 'Ralentit']] }] },
  { kind: 'fade', label: 'Fondu', cat: 'anim', icon: 'contrast', params: [
    { key: 'in', label: 'Entrée', min: 0, max: 5, step: 0.05, def: 0.5, unit: ' s' }, { key: 'out', label: 'Sortie', min: 0, max: 5, step: 0.05, def: 0.5, unit: ' s' },
    { key: 'color', label: 'Couleur', def: 'noir', options: [['noir', 'Noir'], ['blanc', 'Blanc'], ['transparent', 'Transparent']] }] },
  { kind: 'mirror', label: 'Miroir', cat: 'anim', icon: 'split', params: [{ key: 'axis', label: 'Axe', def: 'h', options: [['h', 'Horizontal'], ['v', 'Vertical']] }] },
  { kind: 'blur', label: 'Flou', cat: 'flou', icon: 'target', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 60, step: 0.5, def: 8, unit: ' px' }] },
  { kind: 'sharpen', label: 'Netteté', cat: 'flou', icon: 'scope', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 35 }] },
  { kind: 'pixelate', label: 'Pixellisation', cat: 'flou', icon: 'grid', params: [{ key: 'size', label: 'Taille', min: 2, max: 80, def: 16, unit: ' px' }] },
  { kind: 'glow', label: 'Lueur', cat: 'style', icon: 'zap', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 45 }, { key: 'radius', label: 'Rayon', min: 1, max: 60, def: 18, unit: ' px' }] },
  { kind: 'grain', label: 'Grain film', cat: 'style', icon: 'more', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 25 }, { key: 'size', label: 'Taille', min: 0.3, max: 3, step: 0.05, def: 1 }] },
  { kind: 'rgbsplit', label: 'Aberration chromatique', cat: 'style', icon: 'layers', params: [{ key: 'amount', label: 'Décalage', min: 0, max: 40, step: 0.5, def: 6, unit: ' px' }] },
  { kind: 'bw', label: 'Noir et blanc', cat: 'style', icon: 'contrast', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 100, unit: '%' }] },
  { kind: 'sepia', label: 'Sépia', cat: 'style', icon: 'color', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 70, unit: '%' }] },
  { kind: 'hue', label: 'Rotation de teinte', cat: 'style', icon: 'color', params: [{ key: 'deg', label: 'Angle', min: -180, max: 180, def: 90, unit: '°' }] },
  { kind: 'invert', label: 'Négatif', cat: 'style', icon: 'contrast', params: [{ key: 'amount', label: 'Intensité', min: 0, max: 100, def: 100, unit: '%' }] },
  { kind: 'letterbox', label: 'Bandes cinéma', cat: 'habillage', icon: 'media', params: [
    { key: 'ratio', label: 'Format', def: '2.39', options: [['2.39', '2.39:1 Scope'], ['2.0', '2:1'], ['1.85', '1.85:1'], ['1.33', '4:3'], ['1', '1:1']] },
    { key: 'color', label: 'Couleur', def: '#000000', color: true }] },
  { kind: 'rounded', label: 'Coins arrondis', cat: 'habillage', icon: 'image', params: [{ key: 'radius', label: 'Rayon', min: 0, max: 50, step: 0.5, def: 6, unit: '%' }] },
  { kind: 'border', label: 'Bordure', cat: 'habillage', icon: 'media', params: [{ key: 'width', label: 'Épaisseur', min: 0, max: 60, def: 8, unit: ' px' }, { key: 'color', label: 'Couleur', def: '#ffffff', color: true }] },
  { kind: 'shadow', label: 'Ombre portée', cat: 'habillage', icon: 'layers', params: [
    { key: 'amount', label: 'Opacité', min: 0, max: 100, def: 60, unit: '%' }, { key: 'size', label: 'Flou', min: 0, max: 100, def: 30, unit: ' px' }, { key: 'y', label: 'Décalage', min: 0, max: 80, def: 14, unit: ' px' }] },
];

export const fxDef = (k: VFxKind) => FX_DEFS.find((d) => d.kind === k)!;
export const defaults = (k: VFxKind) => Object.fromEntries(fxDef(k).params.map((p) => [p.key, p.def])) as Record<string, number | string>;
const num = (fx: VFx, k: string) => { const v = fx.p[k]; return typeof v === 'number' ? v : Number(v ?? defaults(fx.kind)[k]) || 0; };
const str = (fx: VFx, k: string) => String(fx.p[k] ?? defaults(fx.kind)[k]);
export const active = (look?: Look) => (look?.effects || []).filter((e) => e.on !== false && FX_DEFS.some((d) => d.kind === e.kind));

const SVG_KINDS: VFxKind[] = ['sharpen', 'glow', 'grain', 'rgbsplit'];
export const needsSvgFx = (look?: Look) => active(look).some((e) => SVG_KINDS.includes(e.kind));

/** SVG primitives appended to the end of the layer filter (input: previous result "cur") */
export function svgFx(look: Look | undefined, k: number, frame: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cur = 'col';
  active(look).filter((e) => SVG_KINDS.includes(e.kind)).forEach((e, i) => {
    const n = `fx${i}`;
    if (e.kind === 'sharpen') {
      const a = num(e, 'amount') / 100;
      out.push(<feConvolveMatrix key={n} in={cur} order="3" preserveAlpha="true" kernelMatrix={`0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`} result={n} />);
    } else if (e.kind === 'glow') {
      const a = num(e, 'amount') / 100;
      out.push(<feGaussianBlur key={`${n}b`} in={cur} stdDeviation={num(e, 'radius') * k} result={`${n}b`} />);
      out.push(<feComponentTransfer key={`${n}t`} in={`${n}b`} result={`${n}t`}><feFuncR type="linear" slope={a * 1.6} /><feFuncG type="linear" slope={a * 1.6} /><feFuncB type="linear" slope={a * 1.6} /></feComponentTransfer>);
      out.push(<feBlend key={n} in={cur} in2={`${n}t`} mode="screen" result={n} />);
    } else if (e.kind === 'grain') {
      const a = num(e, 'amount') / 100;
      out.push(<feTurbulence key={`${n}n`} type="fractalNoise" baseFrequency={(0.9 / Math.max(0.3, num(e, 'size'))) / Math.max(0.5, k)} numOctaves="2" seed={frame % 97} result={`${n}n`} />);
      out.push(<feColorMatrix key={`${n}g`} in={`${n}n`} type="matrix" values={`0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 ${a * 0.9}`} result={`${n}g`} />);
      out.push(<feBlend key={`${n}m`} in={cur} in2={`${n}g`} mode="overlay" result={`${n}m`} />);
      out.push(<feComposite key={n} in={`${n}m`} in2="SourceGraphic" operator="in" result={n} />);
    } else if (e.kind === 'rgbsplit') {
      const d = num(e, 'amount') * k;
      out.push(<feColorMatrix key={`${n}r`} in={cur} type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result={`${n}r`} />);
      out.push(<feOffset key={`${n}ro`} in={`${n}r`} dx={d} result={`${n}ro`} />);
      out.push(<feColorMatrix key={`${n}g`} in={cur} type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result={`${n}g`} />);
      out.push(<feColorMatrix key={`${n}b`} in={cur} type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result={`${n}b`} />);
      out.push(<feOffset key={`${n}bo`} in={`${n}b`} dx={-d} result={`${n}bo`} />);
      out.push(<feBlend key={`${n}x`} in={`${n}ro`} in2={`${n}g`} mode="screen" result={`${n}x`} />);
      out.push(<feBlend key={n} in={`${n}x`} in2={`${n}bo`} mode="screen" result={n} />);
    }
    cur = n;
  });
  return out;
}

/** pixelate: separate filter, in units relative to the layer (Chrome breaks pixel-based subregions as soon as
 *  the layer is resized: scaled preview, shrunk overlay…). The layer is w × h. */
export function PixelFilter({ id, look, w, h, k }: { id: string; look?: Look; w: number; h: number; k: number }) {
  const e = active(look).find((x) => x.kind === 'pixelate');
  if (!e) return null;
  const s = Math.max(2, num(e, 'size') * k);
  const hs = s / 2;
  return (
    <filter id={`pix-${id}`} x="0" y="0" width="100%" height="100%" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
      <feFlood x={hs / w} y={hs / h} width={1 / w} height={1 / h} result="f" />
      <feComposite in="f" x="0" y="0" width={s / w} height={s / h} result="c" />
      <feTile in="c" result="t" />
      <feComposite in="SourceGraphic" in2="t" operator="in" result="k" />
      <feMorphology in="k" operator="dilate" radius={`${hs / w} ${hs / h}`} />
    </filter>
  );
}

/** CSS filters added to the layer */
export function cssFx(look: Look | undefined, k: number, id = ''): string {
  return active(look).map((e) => {
    switch (e.kind) {
      case 'blur': return `blur(${num(e, 'amount') * k}px)`;
      case 'bw': return `grayscale(${num(e, 'amount') / 100})`;
      case 'sepia': return `sepia(${num(e, 'amount') / 100})`;
      case 'invert': return `invert(${num(e, 'amount') / 100})`;
      case 'hue': return `hue-rotate(${num(e, 'deg')}deg)`;
      case 'pixelate': return id ? `url(#pix-${id})` : '';
      case 'shadow': return `drop-shadow(0 ${num(e, 'y') * k}px ${num(e, 'size') * k}px rgba(0,0,0,${num(e, 'amount') / 100}))`;
      default: return '';
    }
  }).filter(Boolean).join(' ');
}

const EASE: Record<string, (t: number) => number> = {
  douce: Easing.inOut(Easing.cubic), lineaire: (t) => t, entree: Easing.in(Easing.cubic), sortie: Easing.out(Easing.cubic),
};

/** animation, fades and framing of a layer. start = (local) frame where the element starts, dur = its duration. */
export const FxLayer: React.FC<{ look?: Look; start: number; dur: number; bars?: boolean; children: React.ReactNode }> = ({ look, start, dur, bars = true, children }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fx = active(look);
  if (!fx.length) return <>{children}</>;
  const k = Math.min(width, height) / 1080;
  const local = f - start;
  const p = Math.max(0, Math.min(1, local / Math.max(1, dur - 1)));
  let transform = '';
  let opacity = 1;
  let white = 0;
  const rnd = fx.find((e) => e.kind === 'rounded');
  const radius = rnd ? `${num(rnd, 'radius')}%` : '';
  const extra: React.ReactNode[] = [];
  for (const e of fx) {
    if (e.kind === 'motion') {
      const t = (EASE[str(e, 'ease')] || EASE.douce)(p);
      const lerp = (a: string, b: string) => num(e, a) + (num(e, b) - num(e, a)) * t;
      transform += ` translate(${lerp('x0', 'x1')}%, ${lerp('y0', 'y1')}%) rotate(${lerp('rot0', 'rot1')}deg) scale(${lerp('scale0', 'scale1') / 100})`;
    } else if (e.kind === 'mirror') {
      transform += str(e, 'axis') === 'v' ? ' scaleY(-1)' : ' scaleX(-1)';
    } else if (e.kind === 'fade') {
      const fi = num(e, 'in') * fps, fo = num(e, 'out') * fps;
      let v = 1;
      if (fi > 0) v = Math.min(v, interpolate(local, [0, fi], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
      if (fo > 0) v = Math.min(v, interpolate(local, [dur - fo, dur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
      if (str(e, 'color') === 'blanc') white = Math.max(white, 1 - v); else opacity *= v;
    } else if (e.kind === 'border') {
      extra.push(<div key={e.id} style={{ position: 'absolute', inset: 0, border: `${num(e, 'width') * k}px solid ${str(e, 'color')}`, borderRadius: radius || undefined, pointerEvents: 'none' }} />);
    } else if (e.kind === 'letterbox' && bars) {
      const r = Number(str(e, 'ratio')) || 2.39;
      const bar = Math.max(0, (1 - width / height / r) / 2) * 100;
      const side = Math.max(0, (1 - (height * r) / width) / 2) * 100;
      const c = str(e, 'color');
      if (bar > 0) extra.push(<div key={`${e.id}t`} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${bar}%`, background: c }} />, <div key={`${e.id}b`} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${bar}%`, background: c }} />);
      else if (side > 0) extra.push(<div key={`${e.id}l`} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${side}%`, background: c }} />, <div key={`${e.id}r`} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: `${side}%`, background: c }} />);
    }
  }
  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill style={{ transform: transform.trim() || undefined, borderRadius: radius || undefined, overflow: radius ? 'hidden' : undefined }}>{children}</AbsoluteFill>
      {extra}
      {white ? <AbsoluteFill style={{ background: 'white', opacity: white }} /> : null}
    </AbsoluteFill>
  );
};

let n = 0;
export const newFx = (kind: VFxKind, p?: Record<string, number | string>): VFx => ({ id: `x${Date.now().toString(36)}${(n++).toString(36)}`, kind, on: true, p: { ...defaults(kind), ...(p || {}) } });

export const hasLetterbox = (look?: Look) => active(look).some((e) => e.kind === 'letterbox');

/** letterbox bars of a main-edit shot, laid on top of the camera zooms */
export const LetterboxBars: React.FC<{ look?: Look }> = ({ look }) => {
  const { width, height } = useVideoConfig();
  const e = active(look).find((x) => x.kind === 'letterbox');
  if (!e) return null;
  const r = Number(str(e, 'ratio')) || 2.39;
  const c = str(e, 'color');
  const bar = Math.max(0, (1 - width / height / r) / 2) * 100;
  const side = Math.max(0, (1 - (height * r) / width) / 2) * 100;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {bar > 0 ? <><div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${bar}%`, background: c }} /><div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${bar}%`, background: c }} /></> : null}
      {side > 0 ? <><div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${side}%`, background: c }} /><div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: `${side}%`, background: c }} /></> : null}
    </AbsoluteFill>
  );
};
