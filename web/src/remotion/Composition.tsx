// The video itself. Same code for the live preview (Player in the editor) and the final render (Node).
import React, { useMemo } from 'react';
import {
  AbsoluteFill, Freeze, Html5Audio, Img, interpolate, OffthreadVideo, random, Sequence, useCurrentFrame, useVideoConfig,
} from 'remotion';
import type { CompositionProps, Look, OText, OVideo, Source } from '../types';
import { LookFilters, colorOf, lookStyle, Vignette } from './look';
import { FxLayer, hasLetterbox, LetterboxBars } from './effects';
import { censorText } from './censor';
import { fontFamily } from './fonts';
import { dbToGain, inRanges, mergeStyle, nearRanges, resolve, type Resolved } from './resolve';

const MASTER = 0.8; // headroom: the render is normalized (pack LUFS) at the end
// Preview: playback never stops to wait for media (no stutter or jumping back), media
// catch up smoothly. Render: every frame waits for its media.
let BUFFER = true;
const SHIFT = () => (BUFFER ? undefined : 0.9);
// browsers reject playback rates above 16× (the preview resyncs on its own; the render has no such limit)
const RATE = (r: number) => (BUFFER ? r : Math.min(16, Math.max(0.0625, r)));

export const Main: React.FC<CompositionProps> = (props) => {
  const r = useMemo(() => resolve(props), [props]);
  const style = useMemo(() => mergeStyle(props.pack?.style, props.project.overrides), [props.pack, props.project.overrides]);
  const frame = useCurrentFrame();
  const srcs = useMemo(() => new Map(props.project.sources.map((s) => [s.id, s])), [props.project.sources]);
  const preview = props.mode === 'preview';
  BUFFER = !preview;
  const k = Math.min(r.width, r.height) / 1080; // pack sizes are designed for 1080

  const transform = cameraAt(r, frame);
  const tint = r.tints.find((t) => frame >= t.from && frame < t.from + t.dur);
  const filter = tint?.mode === 'bw' ? 'grayscale(1) contrast(1.08)' : tint?.mode === 'red' ? 'saturate(1.3) sepia(0.25)' : undefined;
  const srcUrl = (s: Source | undefined) => (s ? (preview && s.proxy ? s.proxy : s.url) : '');
  const trans = transitionAt(r, frame);
  const itemById = useMemo(() => new Map(props.project.timeline.map((x) => [x.id, x])), [props.project.timeline]);
  const ritemById = useMemo(() => new Map(r.items.map((x) => [x.id, x])), [r.items]);
  const looks = useMemo(() => [
    ...props.project.timeline.map((x) => ({ id: x.id, look: 'look' in x ? (x as { look?: Look }).look : undefined })),
    ...r.overlays.filter((o) => o.clip.type === 'video').map((o) => ({ id: o.clip.id, look: (o.clip as OVideo).look })),
  ], [props.project.timeline, r.overlays]);
  const lookOf = (id: string) => { const it = itemById.get(id); return it && 'look' in it ? (it as { look?: Look }).look : undefined; };
  /** audio fade in / out of a shot (seconds) */
  const fadeGain = (itemId: string, g: number) => {
    const it = itemById.get(itemId);
    const ri = ritemById.get(itemId);
    if (!it || !ri || it.type !== 'clip') return 1;
    let v = 1;
    if (it.fadeIn) v = Math.min(v, (g - ri.from) / (it.fadeIn * r.fps));
    if (it.fadeOut) v = Math.min(v, (ri.from + ri.dur - g) / (it.fadeOut * r.fps));
    return Math.max(0, Math.min(1, v));
  };
  const voiceGain = r.mix.voiceMuted ? 0 : dbToGain(r.mix.voiceDb || 0);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
      <LookFilters looks={looks} k={k} frame={frame} w={r.width} h={r.height} />
      <AbsoluteFill style={{ ...trans.style, visibility: r.mix.mainHidden ? 'hidden' : undefined }}>
      <AbsoluteFill style={{ transform, transformOrigin: '0 0', filter }}>
        {r.segs.map((seg) => {
          const s = srcs.get(seg.src);
          if (!s) return null;
          const useStems = style.stems.enabled && !!s.stems;
          const clip = props.project.timeline.find((x) => x.id === seg.itemId);
          const cropX = clip && clip.type === 'clip' && clip.cropX !== undefined ? clip.cropX : 0.5;
          const off = !!(clip && clip.type === 'clip' && clip.audioOff); // unlinked audio: played by its audio clips
          const baseVol = off ? 0 : MASTER * voiceGain * dbToGain(clip && clip.type === 'clip' ? clip.volumeDb || 0 : 0);
          const voiceVol = (f: number) => {
            const g = seg.from + f;
            const v = baseVol * fadeGain(seg.itemId, g);
            return inRanges(r.censors, g) ? v * dbToGain(style.censor.duckDb) : v;
          };
          const boost = s.stems ? Math.max(0, Math.min(22, -37 - (s.stems.gameMedianDb ?? -50))) : 0;
          const gameVol = (f: number) => {
            const g = seg.from + f;
            const d = nearRanges(r.speech, g);
            const under = d === 0 ? 1 : Math.max(0, 1 - d / (0.25 * r.fps));
            return Math.min(8, baseVol * fadeGain(seg.itemId, g) * dbToGain(Math.max(style.stems.gameBoostDb, boost) - style.stems.gameUnderVoiceDb * under));
          };
          const trim = Math.round(seg.a * r.fps);
          return (
            <Sequence key={seg.key} from={seg.from} durationInFrames={seg.dur} premountFor={r.fps * 2} name={seg.key}>
              <AbsoluteFill style={lookStyle(seg.itemId, seg.look, '', k)}>
              <FxLayer bars={false} look={seg.look} start={(ritemById.get(seg.itemId)?.from ?? seg.from) - seg.from} dur={ritemById.get(seg.itemId)?.dur ?? seg.dur}>
              {s.kind === 'image' ? (
                <Img src={s.url} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : s.kind === 'audio' ? (off ? null :
                <Html5Audio src={srcUrl(s)} trimBefore={trim} playbackRate={RATE(seg.rate)} volume={voiceVol} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()} />
              ) : (
                <OffthreadVideo
                  src={srcUrl(s)}
                  trimBefore={trim}
                  playbackRate={RATE(seg.rate)}
                  muted={useStems || !s.hasAudio || off}
                  volume={voiceVol}
                  pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${cropX * 100}% 50%` }}
                />
              )}
              </FxLayer>
              </AbsoluteFill>
              <Vignette amount={colorOf(seg.look).vignette} />
              {useStems && s.stems && !off ? (
                <>
                  <Html5Audio src={s.stems.voice} trimBefore={trim} playbackRate={RATE(seg.rate)} volume={voiceVol} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()} />
                  <Html5Audio src={s.stems.game} trimBefore={trim} playbackRate={RATE(seg.rate)} volume={gameVol}
                    useWebAudioApi={preview} allowAmplificationDuringRender pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()} crossOrigin="anonymous" />
                </>
              ) : null}
            </Sequence>
          );
        })}
        {r.freezes.map((fz) => {
          const s = srcs.get(fz.src);
          if (!s) return null;
          return (
            <Sequence key={fz.id} from={fz.from} durationInFrames={fz.dur} premountFor={r.fps}>
              <AbsoluteFill style={lookStyle(fz.id, lookOf(fz.id), '', k)}>
                <FxLayer bars={false} look={lookOf(fz.id)} start={0} dur={fz.dur}>
                <FreezeShot url={srcUrl(s)} t={fz.t} fps={r.fps} target={fz.target} scale={fz.scale} w={r.width} h={r.height} />
                </FxLayer>
              </AbsoluteFill>
              <Vignette amount={colorOf(lookOf(fz.id)).vignette} />
            </Sequence>
          );
        })}
        {r.medias.filter((m) => m.item.url).map((m) => (
          <Sequence key={m.id} from={m.from} durationInFrames={m.dur} premountFor={r.fps}>
            <AbsoluteFill style={lookStyle(m.id, m.item.look, '', k)}>
            <FxLayer bars={false} look={m.item.look} start={0} dur={m.dur}>
            {m.item.kind === 'image' ? (
              <Img src={m.item.url} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <OffthreadVideo src={m.item.url} muted={!!m.item.audioOff} volume={m.item.audioOff ? 0 : MASTER * dbToGain(m.item.volumeDb || 0)} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            )}
            </FxLayer>
            </AbsoluteFill>
          </Sequence>
        ))}
      </AbsoluteFill>
      </AbsoluteFill>
      {r.items.map((it) => (hasLetterbox(lookOf(it.id)) ? (
        <Sequence key={`lb${it.id}`} from={it.from} durationInFrames={Math.max(1, it.dur)} layout="none"><LetterboxBars look={lookOf(it.id)} /></Sequence>
      ) : null))}
      {trans.flash ? <AbsoluteFill style={{ backgroundColor: 'white', opacity: trans.flash }} /> : null}

      {r.overlays.map((o) => (
        <Sequence key={o.key} from={o.from} durationInFrames={o.dur} premountFor={r.fps}>
          {o.clip.type === 'video'
            ? <OverlayVideo clip={o.clip} dur={o.dur} fps={r.fps} url={o.clip.src ? srcUrl(srcs.get(o.clip.src)) : o.clip.url || ''} gain={MASTER} />
            : <TextClip clip={o.clip} dur={o.dur} fps={r.fps} k={k} w={r.width} h={r.height} />}
        </Sequence>
      ))}

      {r.tints.filter((t) => t.mode !== 'bw').map((t, i) => (
        <Sequence key={`tint${i}`} from={t.from} durationInFrames={Math.max(1, t.dur)} layout="none">
          <TintOverlay mode={t.mode} dur={t.dur} />
        </Sequence>
      ))}

      {r.texts.map((t, i) => (
        <Sequence key={`txt${i}`} from={t.from} durationInFrames={Math.max(1, t.dur)} layout="none">
          <FxText text={style.censor.captions ? censorText(t.text) : t.text} kind={t.style} k={k} fps={r.fps} font={style.captions.font} />
        </Sequence>
      ))}

      {r.captions.map((c) => (
        <Sequence key={c.id} from={c.from} durationInFrames={c.dur} layout="none">
          <CaptionView text={c.text} color={c.color} kind={c.style} k={k} fps={r.fps} style={style.captions} />
        </Sequence>
      ))}

      {r.cards.map((c) => (
        <Sequence key={c.id} from={c.from} durationInFrames={Math.max(1, c.dur)}>
          <CardView item={c.item} k={k} fps={r.fps} font={style.captions.font} logo={props.logo || props.project.logoUrl || null}
            twitchColor={style.cards.twitchColor} />
        </Sequence>
      ))}

      {style.topText ? (
        <div style={{ position: 'absolute', top: 104 * k, left: 0, right: 0, textAlign: 'center', fontFamily: fontFamily(style.captions.font),
          fontWeight: 900, fontSize: 92 * k * 0.8, color: style.topTextColor || '#CD96EF', WebkitTextStroke: `${14 * k}px black`,
          paintOrder: 'stroke fill' }}>{style.topText}</div>
      ) : null}

      {r.sfx.map((s) => (
        <Sequence key={s.key} from={s.from} durationInFrames={s.dur} layout="none">
          <Html5Audio src={s.url} trimBefore={Math.round(s.trim * r.fps)} volume={(f) => sfxVol(f, s.dur, s.volume * MASTER, r.fps)}
            useWebAudioApi={preview && s.volume * MASTER > 1} allowAmplificationDuringRender pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()} crossOrigin="anonymous" />
        </Sequence>
      ))}

      {r.audio.map((a) => (
        <Sequence key={a.key} from={a.from} durationInFrames={a.dur} layout="none">
          <Html5Audio src={a.clip.src ? srcUrl(srcs.get(a.clip.src)) : a.clip.url || ''} loop={!!a.clip.loop} playbackRate={RATE(a.clip.speed || 1)} trimBefore={Math.round((a.clip.in || 0) * r.fps)} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()}
            volume={(f) => {
              let v = MASTER * a.volume * clipFade(f, a.dur, a.clip.fadeIn, a.clip.fadeOut, r.fps);
              if (a.clip.duck) { const d = nearRanges(r.speech, a.from + f); v *= 1 - (1 - dbToGain(-(style.music.duckDb || 0))) * (d === 0 ? 1 : Math.max(0, 1 - d / (0.3 * r.fps))); }
              return Math.min(1, v);
            }} />
        </Sequence>
      ))}

      {r.music.map((m) => (
        <Sequence key={m.key} from={m.from} durationInFrames={m.dur} layout="none">
          <Html5Audio src={m.url} loop trimBefore={Math.round(m.offset * r.fps)} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()}
            volume={(f) => musicVol(f, m, r)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

function clipFade(f: number, dur: number, fin = 0, fout = 0, fps = 30) {
  let v = 1;
  if (fin) v = Math.min(v, f / (fin * fps));
  if (fout) v = Math.min(v, (dur - f) / (fout * fps));
  return Math.max(0, Math.min(1, v));
}

/** incoming transition active at frame f -> main layer style (+ white flash) */
function transitionAt(r: Resolved, frame: number): { style: React.CSSProperties; flash: number } {
  const t = r.transitions.find((x) => frame >= x.from && frame < x.from + x.dur);
  if (!t) return { style: {}, flash: 0 };
  const p = (frame - t.from) / t.dur;
  const e = 1 - Math.pow(1 - p, 3);
  switch (t.kind) {
    case 'fade': return { style: { opacity: e }, flash: 0 };
    case 'flash': return { style: {}, flash: Math.max(0, 1 - p) * 0.95 };
    case 'zoom': return { style: { transform: `scale(${1.35 - 0.35 * e})` }, flash: 0 };
    case 'whip': return { style: { transform: `translateX(${(1 - e) * 35}%)`, filter: `blur(${(1 - e) * 24}px)` }, flash: 0 };
    case 'blur': return { style: { filter: `blur(${(1 - e) * 30}px)` }, flash: 0 };
    case 'glitch': {
      const dx = (random(`gx${frame}`) - 0.5) * 60 * (1 - p);
      return { style: { transform: `translateX(${dx}px)`, filter: `hue-rotate(${Math.round(random(`gh${frame}`) * 180 * (1 - p))}deg) saturate(${1 + 2 * (1 - p)})` }, flash: 0 };
    }
  }
  return { style: {}, flash: 0 };
}

const OverlayVideo: React.FC<{ clip: OVideo; dur: number; fps: number; url: string; gain: number }> = ({ clip, dur, fps, url, gain }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fade = clipFade(f, dur, clip.fadeIn, clip.fadeOut, fps);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={lookStyle(clip.id, clip.look, '', Math.min(width, height) / 1080)}>
        <FxLayer look={clip.look} start={0} dur={dur}>
        {clip.kind === 'image' ? (
          <Img src={url} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <OffthreadVideo src={url} trimBefore={Math.round((clip.in || 0) * fps)} playbackRate={RATE(clip.speed || 1)} muted={clip.muted}
            volume={gain * dbToGain(clip.volumeDb || 0) * fade} pauseWhenBuffering={BUFFER} acceptableTimeShiftInSeconds={SHIFT()} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        )}
        </FxLayer>
      </AbsoluteFill>
      <Vignette amount={colorOf(clip.look).vignette} />
    </AbsoluteFill>
  );
};

const TextClip: React.FC<{ clip: OText; dur: number; fps: number; k: number; w: number; h: number }> = ({ clip, dur, fps, k, w, h }) => {
  const f = useCurrentFrame();
  const st = clip.style;
  const fade = clipFade(f, dur, clip.fadeIn ?? (st.anim === 'fade' ? 0.3 : 0), clip.fadeOut ?? 0.15, fps);
  let transform = `translate(-50%, -50%) rotate(${st.rotation || 0}deg)`;
  let text = st.uppercase ? clip.text.toUpperCase() : clip.text;
  if (st.anim === 'pop') transform += ` scale(${pop(f, fps, 0.55, 1.12, 90, 160)})`;
  if (st.anim === 'slide') transform += ` translateY(${(1 - Math.min(1, f / (0.35 * fps))) * 60 * k}px)`;
  if (st.anim === 'type') text = text.slice(0, Math.ceil((text.length * f) / Math.max(1, 0.04 * fps * text.length)));
  return (
    <div style={{ position: 'absolute', left: st.x * w, top: st.y * h, transform, opacity: fade, textAlign: st.align, whiteSpace: 'pre-line',
      fontFamily: fontFamily(st.font), fontWeight: st.weight, fontStyle: st.italic ? 'italic' : undefined, fontSize: st.size * k, lineHeight: 1.1,
      color: st.color, WebkitTextStroke: st.stroke ? `${st.stroke * 2 * k}px ${st.strokeColor}` : undefined, paintOrder: 'stroke fill',
      background: st.bg || undefined, padding: st.bg ? `${0.15 * st.size * k}px ${0.4 * st.size * k}px` : undefined, borderRadius: st.bg ? 0.2 * st.size * k : undefined,
      textShadow: st.shadow ? `0 ${4 * k}px ${14 * k}px rgba(0,0,0,0.6)` : undefined, width: 'max-content', maxWidth: w * 0.9 }}>
      {text}
    </div>
  );
};

function sfxVol(f: number, dur: number, v: number, fps: number) {
  const fade = Math.min(dur / 3, 0.25 * fps);
  const left = dur - f;
  return Math.min(8, v * (left < fade ? Math.pow(Math.max(0, left / fade), 1.5) : 1));
}

function musicVol(f: number, m: Resolved['music'][number], r: Resolved) {
  const g = m.from + f;
  const fin = Math.min(1, f / (0.4 * r.fps));
  const fout = Math.min(1, (m.dur - f) / (0.8 * r.fps));
  const d = nearRanges(r.speech, g);
  const near = d === 0 ? 1 : Math.max(0, 1 - d / (0.3 * r.fps)); // gentle ducking under the voice
  const duck = 1 - (1 - m.duck) * near;
  return Math.min(1, MASTER * m.volume * duck * Math.max(0, Math.min(fin, fout)));
}

/** camera: hard zoom on a target (window clamped to the frame, never a black edge) + shake */
function cameraAt(r: Resolved, frame: number): string {
  let s = 1;
  let tx = 0.5;
  let ty = 0.5;
  for (const z of r.zooms) {
    if (frame >= z.from && frame < z.from + z.dur) { s = z.scale; tx = z.target[0]; ty = z.target[1]; }
  }
  let dx = 0;
  let dy = 0;
  for (const sh of r.shakes) {
    if (frame >= sh.from && frame < sh.from + sh.dur) {
      const p = (frame - sh.from) / Math.max(1, sh.dur);
      const a = sh.amp * Math.pow(1 - p, 1.5) * (r.width / 1920);
      dx += (random(`x${sh.from}-${frame}`) - 0.5) * 2 * a;
      dy += (random(`y${sh.from}-${frame}`) - 0.5) * 2 * a;
    }
  }
  if (dx || dy) s *= 1 + (2 * Math.max(Math.abs(dx), Math.abs(dy))) / r.width;
  if (s === 1 && !dx && !dy) return 'none';
  const W = r.width;
  const H = r.height;
  const vw = W / s;
  const vh = H / s;
  const x0 = Math.min(Math.max(tx * W - vw / 2, 0), W - vw);
  const y0 = Math.min(Math.max(ty * H - vh / 2, 0), H - vh);
  return `translate(${-x0 * s + dx}px, ${-y0 * s + dy}px) scale(${s})`;
}

const FreezeShot: React.FC<{ url: string; t: number; fps: number; target: [number, number]; scale: number; w: number; h: number }> = ({
  url, t, fps, target, scale, w, h,
}) => {
  const vw = w / scale;
  const vh = h / scale;
  const x0 = Math.min(Math.max(target[0] * w - vw / 2, 0), w - vw);
  const y0 = Math.min(Math.max(target[1] * h - vh / 2, 0), h - vh);
  return (
    <AbsoluteFill style={{ transform: `translate(${-x0 * scale}px, ${-y0 * scale}px) scale(${scale})`, transformOrigin: '0 0' }}>
      <Freeze frame={0}>
        <OffthreadVideo src={url} trimBefore={Math.round(t * fps)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </Freeze>
    </AbsoluteFill>
  );
};

const TintOverlay: React.FC<{ mode: 'red' | 'flash' | 'bw'; dur: number }> = ({ mode, dur }) => {
  const f = useCurrentFrame();
  if (mode === 'flash') {
    const o = interpolate(f, [0, Math.max(2, dur)], [0.95, 0], { extrapolateRight: 'clamp' });
    return <AbsoluteFill style={{ backgroundColor: 'white', opacity: o }} />;
  }
  return <AbsoluteFill style={{ backgroundColor: 'rgba(232,35,42,0.33)', mixBlendMode: 'multiply' }} />;
};

/** "pop" entrance (scale 0.7 -> 1.08 -> 1) */
function pop(f: number, fps: number, from = 0.7, peak = 1.08, ms1 = 70, ms2 = 130) {
  const t = (f / fps) * 1000;
  if (t >= ms2) return 1;
  if (t <= ms1) return interpolate(t, [0, ms1], [from, peak]);
  return interpolate(t, [ms1, ms2], [peak, 1]);
}

const CaptionView: React.FC<{
  text: string; color: string; kind: 'normal' | 'hype' | 'shout'; k: number; fps: number;
  style: ReturnType<typeof mergeStyle>['captions'];
}> = ({ text, color, kind, k, fps, style }) => {
  const f = useCurrentFrame();
  const scale = (kind === 'shout' ? style.shoutScale : kind === 'hype' ? 1.06 : 1) * (style.pop ? pop(f, fps) : 1);
  const size = style.size * k;
  return (
    <div style={{ position: 'absolute', left: '6%', right: '6%', bottom: style.bottom * k, display: 'flex', justifyContent: 'center' }}>
      <span
        style={{
          fontFamily: fontFamily(style.font), fontWeight: style.weight, fontSize: size, lineHeight: 1.12, color, textAlign: 'center',
          transform: `scale(${scale})`, transformOrigin: '50% 100%', display: 'inline-block',
          WebkitTextStroke: style.outline ? `${style.outline * 2 * k}px black` : undefined, paintOrder: 'stroke fill',
          textShadow: style.shadow ? `0 ${style.shadow * k}px ${style.shadow * 1.6 * k}px rgba(0,0,0,0.55)` : undefined,
          background: style.box ? 'rgba(0,0,0,0.62)' : undefined, padding: style.box ? `${0.12 * size}px ${0.32 * size}px` : undefined,
          borderRadius: style.box ? 0.18 * size : undefined,
        }}
      >
        {text}
      </span>
    </div>
  );
};

const FxText: React.FC<{ text: string; kind: 'big' | 'note' | 'rip'; k: number; fps: number; font: string }> = ({ text, kind, k, fps, font }) => {
  const f = useCurrentFrame();
  const p = pop(f, fps, 0.55, 1.12, 90, 160);
  const base: React.CSSProperties = { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontFamily: fontFamily(font),
    fontWeight: 900, whiteSpace: 'pre-line', paintOrder: 'stroke fill', transform: `scale(${p})` };
  if (kind === 'note') {
    return <div style={{ ...base, top: 110 * k, fontSize: 76 * k, color: 'white', WebkitTextStroke: `${11 * k}px black` }}>{text}</div>;
  }
  if (kind === 'rip') {
    return <div style={{ ...base, top: '42%', fontSize: 128 * k, color: '#C8C8C8', textShadow: `0 ${3 * k}px ${8 * k}px rgba(0,0,0,0.6)` }}>{text}</div>;
  }
  return (
    <div style={{ ...base, top: 330 * k, fontSize: 200 * k, color: 'white', WebkitTextStroke: `${22 * k}px black`,
      transform: `scale(${p}) rotate(-3deg)`, textShadow: `0 ${6 * k}px ${12 * k}px rgba(0,0,0,0.5)` }}>{text}</div>
  );
};

const MARKS: [RegExp, string][] = [[/\*(.+?)\*/g, '#E8232A'], [/~(.+?)~/g, '#9146FF'], [/\^(.+?)\^/g, '#FFD400']];
function marked(text: string, accent?: string): React.ReactNode[] {
  // *red*  ~purple~  ^yellow^  (like the engine's title cards)
  const out: React.ReactNode[] = [];
  const re = /\*(.+?)\*|~(.+?)~|\^(.+?)\^/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const col = m[1] ? MARKS[0][1] : m[2] ? accent || MARKS[1][1] : MARKS[2][1];
    out.push(<span key={i++} style={{ color: col }}>{m[1] || m[2] || m[3]}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const CardView: React.FC<{
  item: Extract<CompositionProps['project']['timeline'][number], { type: 'card' }>;
  k: number; fps: number; font: string; logo: string | null; twitchColor: string;
}> = ({ item, k, fps, font, logo, twitchColor }) => {
  const f = useCurrentFrame();
  const p = pop(f, fps, 0.55, 1.12, 90, 160);
  const fam = fontFamily(font);
  const bg = item.bg || 'black';
  const common: React.CSSProperties = { fontFamily: fam, fontWeight: 800, color: item.color || 'white', textAlign: 'center', whiteSpace: 'pre-line' };
  if (item.style === 'logo' && (item.image || logo)) {
    return (
      <AbsoluteFill style={{ backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Img src={(item.image || logo) as string} style={{ maxWidth: '62%', maxHeight: '58%', objectFit: 'contain', transform: `scale(${p})` }} />
      </AbsoluteFill>
    );
  }
  if (item.style === 'twitch') {
    const lines = item.text.split('\n').map((l) => l.replace(/[~*^]/g, '').trim());
    return (
      <AbsoluteFill style={{ backgroundColor: bg }}>
        <div style={{ ...common, position: 'absolute', left: 0, right: 0, top: 500 * k - 95 * k, fontSize: 159 * k * 0.62, transform: `scale(${p})` }}>{lines[0]}</div>
        <div style={{ ...common, position: 'absolute', left: 0, right: 0, top: 617 * k - 95 * k, fontSize: 159 * k * 0.62, color: twitchColor, transform: `scale(${p})` }}>{lines[1] || ''}</div>
      </AbsoluteFill>
    );
  }
  const img = item.image ? <Img src={item.image} style={{ maxWidth: '50%', maxHeight: item.text.trim() ? '36%' : '58%', objectFit: 'contain', transform: `scale(${p})` }} /> : null;
  if (item.style === 'title') {
    return (
      <AbsoluteFill style={{ backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 40 * k }}>
        {img}
        {item.text.trim() ? <div style={{ ...common, fontSize: 150 * k, background: item.band ?? '#E8232A', padding: `${10 * k}px ${40 * k}px`, transform: `scale(${p})` }}>{item.text}</div> : null}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 30 * k }}>
      {img}
      <div style={{ ...common, fontSize: (item.style === 'narr' ? 96 : 150) * k, transform: `scale(${p})`, padding: `0 ${80 * k}px` }}>
        {marked(item.text, twitchColor)}
      </div>
      {item.sub ? <div style={{ ...common, fontSize: 74 * k, color: '#C8C8C8', fontWeight: 700 }}>{marked(item.sub)}</div> : null}
    </AbsoluteFill>
  );
};

export function durationOf(props: CompositionProps) {
  return resolve(props).duration;
}
