// Bibliothèque : musiques, sons et visuels des dossiers choisis dans Réglages. Écoute, recherche, glisser vers la timeline.
import { useMemo, useRef, useState } from 'react';
import { Icon } from '../../lib/icons';
import { pathOf, thumbUrl } from '../../lib/previews';
import { getFrame, uid, useStore } from '../../lib/store';
import type { ClipItem } from '../../types';
import { clipAt, useComp } from '../comp';
import { addToTrack } from '../actions';
import { DND } from '../Timeline';
import { tx } from '../../lib/i18n';

function usePreviewAudio() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = (key: string, url: string, start = 0, dur?: number) => {
    audio.current?.pause();
    if (playing === key) { setPlaying(null); return; }
    const a = new Audio(url);
    a.currentTime = start;
    a.play().catch(() => undefined);
    if (dur) setTimeout(() => { if (audio.current === a) { a.pause(); setPlaying(null); } }, dur * 1000 + 100);
    a.onended = () => setPlaying(null);
    audio.current = a;
    setPlaying(key);
  };
  return { play, playing };
}

const outT = () => { const st = useStore.getState(); return getFrame() / (st.project?.format.fps || 30); };

export function LibraryPanel() {
  const library = useStore((s) => s.library);
  const settings = useStore((s) => s.settings);
  const { style, r, props } = useComp();
  const update = useStore((s) => s.update);
  const notify = useStore((s) => s.notify);
  const [tab, setTab] = useState<'music' | 'sfx' | 'vfx'>('music');
  const [q, setQ] = useState('');
  const [mood, setMood] = useState('');
  const { play, playing } = usePreviewAudio();
  const moods = useMemo(() => [...new Set((library?.music || []).flatMap((t) => t.moods))].sort(), [library]);
  const ql = q.toLowerCase();
  const hasLibs = ((settings?.libraries as unknown[]) || []).length > 0;

  const sfxHere = (name: string) => {
    const at = clipAt(r, props.project.timeline, getFrame());
    if (!at) { notify(tx('Place la tête de lecture dans un plan')); return; }
    update((p) => { const c = p.timeline.find((x) => x.id === at.clip.id) as ClipItem; c.fx.push({ id: uid('f'), kind: 'sfx', t: Math.round(at.t * 1000) / 1000, name, db: 0 }); });
  };

  const body = () => {
    if (!hasLibs) return <div className="pad"><span className="small muted">{tx('Ajoute un dossier de musiques, sons ou visuels dans')} <a href="#/reglages/bibliotheques">{tx('Réglages › Bibliothèques')}</a>.</span></div>;
    if (!library) return <div className="pad"><span className="small muted row"><span className="spin" /> {tx('Analyse de la bibliothèque…')}</span></div>;
    if (tab === 'music') {
      const list = library.music.filter((t) => (!mood || t.moods.includes(mood)) && (!ql || t.name.toLowerCase().includes(ql) || t.genres.join(' ').toLowerCase().includes(ql)));
      return (
        <>
          {moods.length ? (
            <div style={{ padding: '6px 8px' }}>
              <select className="input" value={mood} onChange={(e) => setMood(e.target.value)}>
                <option value="">{tx('Toutes les ambiances')}</option>{moods.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
          ) : null}
          {list.length === 0 ? <div className="pad small dim">{tx('Aucune musique.')}</div> : null}
          {list.map((t) => (
            <div key={t.name} className="rowi" draggable
              onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'file', path: pathOf(t.url), url: t.url, media: 'audio', name: t.name, dur: 60 }))}>
              <button className="btn icon sm ghost" onClick={() => play(t.name, t.url, 20)}><Icon name={playing === t.name ? 'pause' : 'play'} size={11} /></button>
              <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis">{t.name}</div><div className="tiny dim ellipsis">{[t.moods.slice(0, 3).join(', '), t.bpm ? `${t.bpm} BPM` : ''].filter(Boolean).join(' · ')}</div></div>
              <button className="btn icon sm ghost" title={tx('Ajouter à la tête de lecture')}
                onClick={() => addToTrack('audio', { id: uid('o'), type: 'audio', path: pathOf(t.url) || undefined, url: t.url, start: outT(), dur: 30, in: 0, volumeDb: style.music.db + t.gainDb, name: t.name, duck: true, fadeIn: 0.4, fadeOut: 0.8 }, null, 'music')}><Icon name="plus" size={12} /></button>
            </div>
          ))}
        </>
      );
    }
    if (tab === 'sfx') {
      const list = Object.values(library.sfx).filter((s) => !ql || s.name.toLowerCase().includes(ql) || ((s as { label?: string }).label || '').toLowerCase().includes(ql) || s.help.toLowerCase().includes(ql));
      return (
        <>
          {list.length === 0 ? <div className="pad small dim">{tx('Aucun son.')}</div> : null}
          {list.slice(0, 400).map((s) => {
            const v = s.variants[0];
            const label = (s as { label?: string }).label || s.name;
            return (
              <div key={s.name} className="rowi" draggable
                onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'file', path: pathOf(v.url), url: v.url, media: 'audio', name: label, dur: v.dur }))}>
                <button className="btn icon sm ghost" onClick={() => { const x = s.variants[Math.floor(Math.random() * s.variants.length)]; play(s.name, x.url, x.start, x.dur); }}><Icon name={playing === s.name ? 'pause' : 'play'} size={11} /></button>
                <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis">{label}</div><div className="tiny dim ellipsis">{s.help}{s.variants.length > 1 ? ` · ${s.variants.length} variantes` : ''}</div></div>
                <button className="btn icon sm ghost" title={tx('Poser sur le plan à la tête de lecture')} onClick={() => sfxHere(s.name)}><Icon name="plus" size={12} /></button>
              </div>
            );
          })}
        </>
      );
    }
    const list = library.vfx.filter((v) => !ql || v.name.toLowerCase().includes(ql) || v.folder.toLowerCase().includes(ql));
    return (
      <div className="bin-grid">
        {list.length === 0 ? <span className="small dim">{tx('Aucun visuel.')}</span> : null}
        {list.slice(0, 300).map((v) => {
          const isImg = /\.(png|jpe?g|gif|webp)$/i.test(v.path);
          return (
            <div key={v.path} className="tile" draggable title={v.name}
              onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'file', path: v.path, url: v.url, media: isImg ? 'image' : 'video', name: v.name, dur: 4 }))}
              onDoubleClick={() => addToTrack('video', { id: uid('o'), type: 'video', path: v.path, url: v.url, kind: isImg ? 'image' : 'video', start: outT(), dur: isImg ? 2.5 : 4, in: 0, name: v.name,
                look: /green|vert|chroma/i.test(v.name) ? { chroma: '#00ff00' } : {}, fadeIn: 0.1, fadeOut: 0.15 })}>
              <div className="tile-img"><img src={thumbUrl(v.path, 1, 240)} loading="lazy" alt="" /></div>
              <span className="tile-name ellipsis">{v.name}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <div className="seg">
          <button className={tab === 'music' ? 'on' : ''} onClick={() => setTab('music')}>{tx('Musiques')}</button>
          <button className={tab === 'sfx' ? 'on' : ''} onClick={() => setTab('sfx')}>{tx('Sons')}</button>
          <button className={tab === 'vfx' ? 'on' : ''} onClick={() => setTab('vfx')}>{tx('Visuels')}</button>
        </div>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('Rechercher')} />
      </div>
      <div className="pbody">{body()}</div>
    </div>
  );
}
