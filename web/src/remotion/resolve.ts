// Résolution de la timeline : projet + transcriptions + style du pack -> tout ce qui est à l'écran et dans le son,
// en images de sortie. Fonction pure : la même pour l'aperçu en direct, la timeline de l'éditeur et le rendu final.
import type { CompositionProps, ClipItem, Item, Look, Mix, OAudio, OText, OVideo, PackStyle, SfxType, Target, TransitionKind, Word } from '../types';
import { censorText, isSwear } from './censor';

export interface Seg {
  key: string;
  itemId: string;
  src: string;
  a: number; // secondes source
  b: number;
  rate: number;
  from: number; // image de sortie
  dur: number;
  look?: Look;
}

export interface RItem {
  id: string;
  type: Item['type'];
  from: number;
  dur: number;
  segs: Seg[];
}

export interface CapEv {
  id: string;
  itemId: string;
  from: number;
  dur: number;
  text: string;
  color: string;
  style: 'normal' | 'hype' | 'shout';
  speaker: string | null;
}

export interface ZoomEv { from: number; dur: number; target: [number, number]; scale: number; auto?: boolean }
export interface ShakeEv { from: number; dur: number; amp: number }
export interface TintEv { from: number; dur: number; mode: 'bw' | 'red' | 'flash' }
export interface TextEv { from: number; dur: number; text: string; style: 'big' | 'note' | 'rip' }
export interface SfxEv { key: string; from: number; dur: number; url: string; trim: number; volume: number; name: string }
export interface MusicEv { key: string; from: number; dur: number; url: string; volume: number; offset: number; duck: number; name: string }
export interface CardEv { id: string; from: number; dur: number; item: Extract<Item, { type: 'card' }> }
export interface FreezeEv { id: string; from: number; dur: number; src: string; t: number; target: [number, number]; scale: number }
export interface MediaEv { id: string; from: number; dur: number; item: Extract<Item, { type: 'media' }> }
export interface TransEv { from: number; dur: number; kind: TransitionKind }
export interface OverlayEv { key: string; layer: number; from: number; dur: number; clip: OVideo | OText; trackId: string }
export interface AudioEv { key: string; from: number; dur: number; clip: OAudio; volume: number; trackId: string }

export interface Resolved {
  fps: number;
  width: number;
  height: number;
  duration: number;
  items: RItem[];
  segs: Seg[];
  captions: CapEv[];
  zooms: ZoomEv[];
  shakes: ShakeEv[];
  tints: TintEv[];
  texts: TextEv[];
  sfx: SfxEv[];
  music: MusicEv[];
  cards: CardEv[];
  freezes: FreezeEv[];
  medias: MediaEv[];
  speech: [number, number][]; // images de sortie où quelqu'un parle (baisse de la musique / du jeu)
  censors: [number, number][]; // gros mots (son baissé + bip)
  chapters: { from: number; label: string }[];
  transitions: TransEv[];
  overlays: OverlayEv[];
  audio: AudioEv[];
  mix: Required<Pick<Mix, 'voiceDb' | 'musicDb' | 'sfxDb'>> & Mix;
}

export const DEFAULT_STYLE: PackStyle = {
  captions: { font: 'Montserrat', weight: 700, size: 90, color: '#FFFFFF', outline: 7, shadow: 3.5, bottom: 92, mode: 'groups',
    uppercase: false, pop: true, shoutScale: 1.22, maxChars: 32 },
  jumpCuts: { enabled: true, gap: 0.25, pre: 0.1, post: 0.22 },
  baseSpeed: 1,
  face: [0.5, 0.5],
  zoom: { face: 2, center: 1.3 },
  shakeOnImpact: true,
  whooshOnFaceZoom: true,
  music: { db: -15, duckDb: 5 },
  sfxDb: 0,
  censor: { captions: true, audio: true, duckDb: -22 },
  stems: { enabled: false, gameBoostDb: 12, gameUnderVoiceDb: 4 },
  cards: { twitchHandle: '', twitchColor: '#B322C5' },
  topText: '',
  loudness: -14,
};

export function mergeStyle(base: Partial<PackStyle> | undefined, over?: Partial<PackStyle>): PackStyle {
  const out = JSON.parse(JSON.stringify(DEFAULT_STYLE)) as PackStyle & Record<string, unknown>;
  for (const src of [base, over]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      const cur = (out as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
        (out as Record<string, unknown>)[k] = { ...(cur as object), ...(v as object) };
      } else if (v !== undefined) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

const IMPACTS = new Set(['hit', 'impact', 'bass', 'explosion', 'vine_boom', 'bonk']);
export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** morceaux gardés d'un plan (coupes des silences) — même logique que server/ai/tools.py:pieces */
export function clipPieces(clip: ClipItem, words: Word[], style: PackStyle): [number, number][] {
  const a = clip.in;
  const b = clip.out;
  const jc = style.jumpCuts;
  const jump = clip.jump ?? jc.enabled;
  const ws = words.filter((w) => w[1] > a && w[0] < b);
  let out: [number, number][] = [];
  if (!jump || ws.length === 0) out = [[a, b]];
  else {
    const runs: [number, number][] = [];
    for (const w of ws) {
      const last = runs[runs.length - 1];
      if (last && w[0] - last[1] <= (clip.gap ?? jc.gap)) last[1] = Math.max(last[1], w[1]);
      else runs.push([w[0], w[1]]);
    }
    for (const [s0, e0] of runs) {
      const s = Math.max(a, s0 - jc.pre);
      const e = Math.min(b, e0 + jc.post);
      const last = out[out.length - 1];
      if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
  }
  for (const f of clip.fx) if (f.kind === 'keep') out.push([Math.max(a, f.t0), Math.min(b, f.t1)]);
  out.sort((x, y) => x[0] - y[0]);
  let merged: [number, number][] = [];
  for (const [s, e] of out) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  for (const f of clip.fx) {
    if (f.kind !== 'cut') continue;
    const nxt: [number, number][] = [];
    for (const [s, e] of merged) {
      if (f.t1 <= s || f.t0 >= e) { nxt.push([s, e]); continue; }
      if (f.t0 > s) nxt.push([s, f.t0]);
      if (f.t1 < e) nxt.push([f.t1, e]);
    }
    merged = nxt;
  }
  return merged.filter(([s, e]) => e - s >= 0.08);
}

/** découpe les morceaux aux changements de vitesse -> [a, b, vitesse] */
function withSpeed(pieces: [number, number][], clip: ClipItem, base: number): [number, number, number][] {
  const speeds = clip.fx.filter((f) => f.kind === 'speed') as Extract<ClipItem['fx'][number], { kind: 'speed' }>[];
  const k = base * (clip.speed || 1);
  if (!speeds.length) return pieces.map(([a, b]) => [a, b, k]);
  const out: [number, number, number][] = [];
  for (const [a, b] of pieces) {
    const cuts = new Set<number>([a, b]);
    for (const s of speeds) {
      if (s.t0 > a && s.t0 < b) cuts.add(s.t0);
      if (s.t1 > a && s.t1 < b) cuts.add(s.t1);
    }
    const pts = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const sp = speeds.find((s) => s.t0 <= mid && mid < s.t1);
      out.push([pts[i], pts[i + 1], sp ? k * sp.rate : k]);
    }
  }
  return out;
}

function targetOf(t: Target, clip: ClipItem | null, style: PackStyle): [number, number] {
  if (Array.isArray(t)) return [t[0], t[1]];
  if (t === 'center') return [0.5, 0.5];
  return (clip?.face as [number, number]) || style.face;
}

function mergeRanges(r: [number, number][], tol: number): [number, number][] {
  const s = [...r].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + tol) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function resolve(props: CompositionProps): Resolved {
  const { project, words, speakers, sfx: lib } = props;
  const style = mergeStyle(props.pack?.style, project.overrides);
  const fps = project.format.fps;
  const r: Resolved = {
    fps, width: project.format.width, height: project.format.height, duration: 0, items: [], segs: [], captions: [],
    zooms: [], shakes: [], tints: [], texts: [], sfx: [], music: [], cards: [], freezes: [], medias: [], speech: [],
    censors: [], chapters: [], transitions: [], overlays: [], audio: [],
    mix: { voiceDb: 0, musicDb: 0, sfxDb: 0, ...(project.mix || {}) },
  };
  const TRANS_SFX: Partial<Record<TransitionKind, string>> = { whip: 'whoosh', zoom: 'whoosh', glitch: 'glitch', flash: 'pop' };
  const rot: Record<string, number> = {};
  const addSfx = (name: string, atSec: number, db: number, key: string) => {
    const t: SfxType | undefined = lib?.[name];
    if (!t || !t.variants.length) return;
    const i = rot[name] ?? 0;
    rot[name] = i + 1;
    const v = t.variants[i % t.variants.length];
    const from = Math.round((atSec - v.anchor) * fps);
    r.sfx.push({ key, name, from: Math.max(0, from), dur: Math.max(1, Math.round(v.dur * fps)), url: v.url,
      trim: v.start + (from < 0 ? -from / fps : 0), volume: dbToGain(v.gainDb + db + style.sfxDb + (r.mix.sfxDb || 0)) });
  };
  const defaultColor = style.captions.color;
  const colorOf = (spk: string | null) => (spk && speakers?.[spk]?.color) || defaultColor;

  let tOut = 0; // secondes de sortie (flottant, arrondi à chaque frontière)
  const speechSec: [number, number][] = [];
  const censorSec: [number, number][] = [];
  const capsRaw: (CapEv & { endSec: number; startSec: number })[] = [];

  for (const it of project.timeline) {
    const from = Math.round(tOut * fps);
    const ri: RItem = { id: it.id, type: it.type, from, dur: 0, segs: [] };
    if (it.type === 'clip' && it.label) r.chapters.push({ from, label: it.label });
    if (it.type !== 'card' && it.transition && it.transition.dur > 0) {
      r.transitions.push({ from, dur: Math.max(1, Math.round(it.transition.dur * fps)), kind: it.transition.kind });
      const ts = TRANS_SFX[it.transition.kind];
      if (ts) addSfx(ts, from / fps, -4, `${it.id}:tr`);
    }

    if (it.type === 'clip') {
      const ws = words[it.src] || [];
      const parts = withSpeed(clipPieces(it, ws, style), it, style.baseSpeed || 1);
      const segs: (Seg & { t0: number })[] = [];
      parts.forEach(([a, b, k], n) => {
        const f0 = Math.round(tOut * fps);
        tOut += (b - a) / k;
        const f1 = Math.round(tOut * fps);
        if (f1 > f0) segs.push({ key: `${it.id}:${n}`, itemId: it.id, src: it.src, a, b, rate: k, from: f0, dur: f1 - f0, t0: f0 / fps, look: it.look });
      });
      // temps source -> secondes de sortie (dans un trou coupé : début du morceau suivant)
      const mapT = (t: number): number => {
        for (const s of segs) {
          if (t < s.a) return s.from / fps;
          if (t <= s.b) return s.from / fps + (t - s.a) / s.rate;
        }
        const l = segs[segs.length - 1];
        return l ? (l.from + l.dur) / fps : tOut;
      };
      const inPlayed = (t: number) => segs.some((s) => t >= s.a && t <= s.b);
      ri.segs = segs;
      r.segs.push(...segs);

      // parole (baisse musique / jeu) et gros mots
      for (const w of ws) {
        if (w[1] <= it.in || w[0] >= it.out) continue;
        const mid = (w[0] + w[1]) / 2;
        if (!inPlayed(mid)) continue;
        speechSec.push([mapT(w[0]), mapT(w[1])]);
        if (style.censor.audio && isSwear(w[2])) {
          const a = mapT(w[0]) - 0.02;
          const b = Math.min(mapT(w[1]) + 0.02, a + 0.7);
          censorSec.push([a, b]);
        }
      }

      for (const f of it.fx) {
        if (f.kind === 'zoom') {
          const a = mapT(f.t0); const b = mapT(f.t1);
          if (b > a) {
            const target = targetOf(f.target, it, style);
            r.zooms.push({ from: Math.round(a * fps), dur: Math.max(1, Math.round((b - a) * fps)), target, scale: f.scale });
            if (style.whooshOnFaceZoom && f.target === 'face') addSfx('whoosh', a, -8, `${f.id}:w`);
          }
        } else if (f.kind === 'shake') {
          const a = mapT(f.t0); const b = mapT(f.t1);
          if (b > a) r.shakes.push({ from: Math.round(a * fps), dur: Math.round((b - a) * fps), amp: f.amp });
        } else if (f.kind === 'tint') {
          const a = mapT(f.t0); const b = mapT(f.t1);
          if (b > a) r.tints.push({ from: Math.round(a * fps), dur: Math.round((b - a) * fps), mode: f.mode });
        } else if (f.kind === 'sfx') {
          const a = mapT(f.t);
          addSfx(f.name, a, f.db, f.id);
          if (style.shakeOnImpact && IMPACTS.has(f.name)) r.shakes.push({ from: Math.round(a * fps), dur: Math.round(0.28 * fps), amp: 12 });
        } else if (f.kind === 'text') {
          const a = mapT(f.t);
          r.texts.push({ from: Math.round(a * fps), dur: Math.round(f.dur * fps), text: f.text, style: f.style });
          if (f.style === 'rip') r.tints.push({ from: Math.round(a * fps), dur: Math.round(f.dur * fps), mode: 'bw' });
          if (f.style === 'big') addSfx('pop', a, -2, `${f.id}:p`);
        } else if (f.kind === 'censor') {
          censorSec.push([mapT(f.t0), mapT(f.t1)]);
        }
      }

      for (const c of it.captions) {
        if (c.t1 <= it.in || c.t0 >= it.out) continue;
        const a = mapT(Math.max(c.t0, it.in));
        const b = mapT(Math.min(c.t1, it.out));
        if (b - a < 0.05 && !inPlayed(c.t0)) continue;
        let text = style.censor.captions ? censorText(c.text) : c.text;
        const shout = c.style === 'shout';
        if (shout || style.captions.uppercase) text = text.toUpperCase();
        capsRaw.push({ id: c.id, itemId: it.id, from: 0, dur: 0, startSec: a, endSec: Math.max(b, a + 0.35), text,
          color: colorOf(c.speaker), style: c.style, speaker: c.speaker });
        // moment intense : gros zoom (visage si c'est la personne principale, centre sinon) + secousse sur un cri
        if (c.style !== 'normal' && style.shakeOnImpact) {
          const hasZoom = it.fx.some((f) => f.kind === 'zoom' && f.t0 < c.t1 && f.t1 > c.t0);
          if (!hasZoom) {
            const onFace = !c.speaker;
            r.zooms.push({ from: Math.round(a * fps), dur: Math.max(1, Math.round((Math.max(b, a + 0.6) - a) * fps)),
              target: onFace ? targetOf('face', it, style) : [0.5, 0.5],
              scale: (onFace ? style.zoom.face : style.zoom.center) * 1.08, auto: true });
          }
          if (shout) r.shakes.push({ from: Math.round(a * fps), dur: Math.round(0.35 * fps), amp: 10 });
        }
      }
    } else if (it.type === 'card') {
      tOut += it.dur;
      const dur = Math.round(tOut * fps) - from;
      r.cards.push({ id: it.id, from, dur, item: it });
      const at = from / fps;
      for (const so of it.sounds || []) addSfx(so.name, at + (so.at || 0), so.db || 0, `${it.id}:${so.id}`);
      if (it.autoSfx === false) { /* sons automatiques coupés */ }
      else if (it.style === 'logo') {
        addSfx('logo_hit', at + 0.14, 0, `${it.id}:1`);
        addSfx('logo_boom', at + 0.14, -2, `${it.id}:2`);
        addSfx('logo_clap', at + 0.14, -5, `${it.id}:3`);
      } else if (it.style === 'twitch') {
        addSfx('lid_pop', at, 0, `${it.id}:1`);
        addSfx('deep_whoosh', at + it.dur, 0, `${it.id}:2`);
        addSfx('cork_pop', at + it.dur, 0, `${it.id}:3`);
      } else {
        addSfx('pop', at, -4, `${it.id}:1`);
      }
    } else if (it.type === 'freeze') {
      tOut += it.dur;
      const dur = Math.round(tOut * fps) - from;
      r.freezes.push({ id: it.id, from, dur, src: it.src, t: it.t, target: targetOf(it.target, null, style), scale: it.scale });
      if (it.sfx) addSfx(it.sfx, from / fps, 0, `${it.id}:s`);
    } else if (it.type === 'media') {
      tOut += it.dur;
      const dur = Math.round(tOut * fps) - from;
      r.medias.push({ id: it.id, from, dur, item: it });
    }
    ri.dur = Math.round(tOut * fps) - from;
    r.items.push(ri);
  }
  r.duration = Math.max(1, Math.round(tOut * fps));

  // sous-titres : jamais deux à la fois ; on garde un sous-titre affiché jusqu'au suivant (0,5 s max)
  capsRaw.sort((x, y) => x.startSec - y.startSec);
  for (let i = 0; i < capsRaw.length; i++) {
    const c = capsRaw[i];
    const next = capsRaw[i + 1];
    let end = c.endSec + 0.25;
    if (next) end = Math.min(Math.max(end, Math.min(next.startSec, c.endSec + 0.5)), next.startSec);
    const f0 = Math.round(c.startSec * fps);
    const f1 = Math.max(f0 + 4, Math.round(end * fps));
    r.captions.push({ ...c, from: f0, dur: f1 - f0 });
  }

  r.speech = mergeRanges(speechSec, 0.3).map(([a, b]) => [Math.round(a * fps), Math.round(b * fps)]);
  r.censors = mergeRanges(censorSec, 0.05).map(([a, b]) => [Math.round(a * fps), Math.round(b * fps)]);
  r.censors.forEach(([a], i) => addSfx('censor', a / fps, 0, `censor:${i}`));

  // pistes libres (index 0 = la plus haute) : incrustations / textes au-dessus, audio à part
  const tracks = project.tracks || [];
  tracks.forEach((tr, ti) => {
    for (const c of tr.clips) {
      const from = Math.round(c.start * fps);
      const dur = Math.max(1, Math.round(c.dur * fps));
      if (c.type === 'audio') {
        const roleMute = tr.role === 'voice' ? r.mix.voiceMuted : tr.role === 'music' ? r.mix.musicMuted : tr.role === 'sfx' ? r.mix.sfxMuted : false;
        const roleDb = tr.role === 'voice' ? r.mix.voiceDb : tr.role === 'music' ? r.mix.musicDb : tr.role === 'sfx' ? r.mix.sfxDb : 0;
        r.audio.push({ key: c.id, from, dur, clip: c, trackId: tr.id, volume: tr.muted || roleMute ? 0 : dbToGain((c.volumeDb || 0) + (tr.volumeDb || 0) + (roleDb || 0)) });
      } else if (!tr.hidden) {
        r.overlays.push({ key: c.id, layer: tracks.length - ti, from, dur, clip: c, trackId: tr.id });
      }
    }
    for (const c of tr.clips) if (c.start + c.dur > r.duration / fps) r.duration = Math.round((c.start + c.dur) * fps);
  });
  r.overlays.sort((a, b) => a.layer - b.layer);
  if (r.mix.captionsHidden) r.captions = [];
  if (r.mix.sfxMuted) r.sfx = [];

  // musique : du début de l'élément A à la fin de l'élément B
  const byId = new Map(r.items.map((x) => [x.id, x]));
  for (const m of project.music || []) {
    const a = byId.get(m.fromItem);
    const b = byId.get(m.toItem);
    if (!a || !b) continue;
    const from = a.from;
    const to = Math.max(b.from + b.dur, from + 1);
    if (r.mix.musicMuted) continue;
    r.music.push({ key: m.id, name: m.name, from, dur: to - from, url: m.url, volume: dbToGain(m.gainDb + m.db + (r.mix.musicDb || 0)),
      offset: m.offset || 0, duck: dbToGain(-(style.music.duckDb || 0)) });
  }
  return r;
}

/** vrai si l'image f est dans une des plages triées [a, b) */
export function inRanges(ranges: [number, number][], f: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (f < a) hi = mid - 1;
    else if (f >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** distance (images) à la plage la plus proche, pour adoucir les baisses de volume */
export function nearRanges(ranges: [number, number][], f: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  let best = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (f < a) { best = Math.min(best, a - f); hi = mid - 1; }
    else if (f >= b) { best = Math.min(best, f - b + 1); lo = mid + 1; }
    else return 0;
  }
  return best;
}

/** temps source d'un plan -> image de sortie (pour l'éditeur : clic dans la transcription, effets…) */
export function srcToFrame(r: Resolved, itemId: string, t: number): number | null {
  const it = r.items.find((x) => x.id === itemId);
  if (!it) return null;
  for (const s of it.segs) {
    if (t < s.a) return s.from;
    if (t <= s.b) return Math.round(s.from + ((t - s.a) / s.rate) * r.fps);
  }
  return it.segs.length ? it.from + it.dur - 1 : it.from;
}

/** image de sortie -> (élément, temps source) */
export function frameToSrc(r: Resolved, f: number): { itemId: string; t: number | null } | null {
  for (const it of r.items) {
    if (f >= it.from && f < it.from + it.dur) {
      for (const s of it.segs) {
        if (f >= s.from && f < s.from + s.dur) return { itemId: it.id, t: s.a + ((f - s.from) / r.fps) * s.rate };
      }
      return { itemId: it.id, t: null };
    }
  }
  return null;
}
