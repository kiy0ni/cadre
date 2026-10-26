// Project panel: imported media (thumbnails or list), import via files / drag and drop / link, analysis status.
// Double-click: opens the media in the source monitor. Drag: to the timeline.
import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { desktop } from '../../lib/desktop';
import { fmt } from '../../lib/format';
import { Icon } from '../../lib/icons';
import { previewPath, thumbUrl } from '../../lib/previews';
import { useStore } from '../../lib/store';
import { Dropdown } from '../../lib/ui';
import type { JobInfo, Source } from '../../types';
import { useComp } from '../comp';
import { insertSource } from '../actions';
import { DND } from '../Timeline';
import { tx } from '../../lib/i18n';

function statusOf(s: Source, jobs: JobInfo[]): { text: string; busy: boolean; error?: boolean } | null {
  const j = jobs.find((x) => x.meta?.source === s.id && (x.status === 'running' || x.status === 'queued'));
  if (j) {
    const what = j.kind === 'proxy' ? tx('Préparation') : j.kind === 'transcribe' ? tx('Transcription') : j.kind === 'speakers' ? tx('Voix') : j.kind === 'stems' ? tx('Séparation') : tx('Analyse');
    return { text: j.status === 'queued' ? tx('{0} en attente', what) : `${what} ${Math.round(j.progress * 100)} %`, busy: true };
  }
  if (Object.values(s.status).includes('error')) return { text: tx('Erreur'), busy: false, error: true };
  return null;
}

export function ProjectBin() {
  const { props } = useComp();
  const project = props.project;
  const jobs = useStore((s) => s.jobs);
  const watchJob = useStore((s) => s.watchJob);
  const refreshSources = useStore((s) => s.refreshSources);
  const setUi = useStore((s) => s.setUi);
  const notify = useStore((s) => s.notify);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('cadre-bin') as 'grid') || 'grid'; } catch { return 'grid'; } });
  const [q, setQ] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const afterAdd = async () => {
    await refreshSources();
    const js = await api.jobs(project.id);
    js.forEach((j) => (j.status === 'running' || j.status === 'queued') && watchJob(j.id));
  };
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    try {
      const r = await api.addSource(project.id, { paths });
      if (r.errors?.length) notify(r.errors.join(' · '));
      await afterAdd();
    } catch (e) { notify(tx('Import impossible : {0}', (e as Error).message)); }
    finally { setBusy(false); }
  };
  const importFiles = async () => {
    const d = desktop();
    if (d) addPaths(await d.pickFiles());
    else file.current?.click();
  };
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const d = desktop();
    if (d) { addPaths(Array.from(files).map((f) => d.pathForFile(f)).filter(Boolean)); return; }
    setBusy(true);
    try { for (const f of Array.from(files)) await api.upload(project.id, f); await afterAdd(); }
    catch (e) { notify(tx('Envoi impossible : {0}', (e as Error).message)); }
    finally { setBusy(false); }
  };
  const addLink = async () => {
    const v = (link || '').trim();
    if (!v) return;
    setBusy(true);
    try {
      const r = await api.addSource(project.id, /^https?:\/\//.test(v) ? { url: v } : { path: v });
      if (r.job) watchJob(r.job);
      setLink(null);
      await afterAdd();
    } catch (e) { notify(tx('Ajout impossible : {0}', (e as Error).message)); }
    finally { setBusy(false); }
  };
  const run = async (s: Source, action: 'speakers' | 'stems' | 'transcribe' | 'proxy') => {
    try { const { job } = await api.sourceAction(project.id, s.id, action); watchJob(job); await refreshSources(); }
    catch (e) { notify((e as Error).message); }
  };
  const remove = async (s: Source) => {
    if (!confirm(tx('Retirer « {0} » du projet ? Ses plans sont aussi retirés. Le fichier reste sur le disque.', s.name))) return;
    await api.deleteSource(project.id, s.id);
    useStore.getState().open(project.id);
  };
  const openSource = (s: Source) => setUi({ sourceId: s.id, upperTab: 'source' });
  const setV = (v: 'grid' | 'list') => { setView(v); try { localStorage.setItem('cadre-bin', v); } catch { /* storage unavailable */ } };
  const downloads = jobs.filter((j) => j.project === project.id && j.kind === 'download' && (j.status === 'running' || j.status === 'queued'));
  const shown = project.sources.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  const sel = project.sources.find((s) => s.id === selId);

  const menuFor = (s: Source) => (close: () => void) => (
    <>
      <button onClick={() => { close(); openSource(s); }}>{tx('Ouvrir dans le moniteur source')}</button>
      <button onClick={() => { close(); insertSource(s.id, 0, s.duration, 'end'); }}>{tx('Ajouter à la fin du montage')}</button>
      <hr />
      {s.status.transcript === 'error' || s.status.transcript === 'none' ? <button onClick={() => { close(); run(s, 'transcribe'); }}>{tx('Transcrire')}</button> : null}
      {s.status.transcript === 'done' && project.speakers.length > 1 ? <button onClick={() => { close(); run(s, 'speakers'); }}>{tx('Reconnaître qui parle')}</button> : null}
      {s.kind === 'video' ? <button onClick={() => { close(); run(s, 'stems'); }}>{tx('Séparer voix et fond sonore')}</button> : null}
      {s.kind === 'video' && !s.proxy ? <button onClick={() => { close(); run(s, 'proxy'); }}>{tx('Créer une copie allégée')}</button> : null}
      {desktop() ? <button onClick={() => { close(); desktop()!.reveal(s.path); }}>{tx('Afficher dans le dossier')}</button> : null}
      <hr />
      <button onClick={() => { close(); remove(s); }}>{tx('Retirer du projet')}</button>
    </>
  );

  return (
    <div className="col" style={{ gap: 0, flex: 1, minHeight: 0 }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); } }}>
      <div className="toolbar">
        <Dropdown width={190} button={(_, t) => <button className="btn sm primary" data-import onClick={t} disabled={busy}><Icon name="import" size={12} /> {tx('Importer')}</button>}>
          {(close) => (
            <>
              <button onClick={() => { close(); importFiles(); }}><Icon name="folder" size={14} /> {tx('Fichiers…')}</button>
              <button onClick={() => { close(); setLink(''); }}><Icon name="link" size={14} /> {tx('Lien ou chemin…')}</button>
            </>
          )}
        </Dropdown>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('Rechercher')} />
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setV('grid')} title={tx('Vignettes')}><Icon name="grid" size={11} /></button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setV('list')} title={tx('Liste')}><Icon name="sliders" size={11} /></button>
        </div>
        <input ref={file} type="file" multiple accept="video/*,audio/*,image/*" style={{ display: 'none' }} onChange={(e) => uploadFiles(e.target.files)} />
      </div>
      <div className="pbody">
        {link !== null ? (
          <div className="row" style={{ padding: 8 }}>
            <input className="input" autoFocus value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addLink(); if (e.key === 'Escape') setLink(null); }} placeholder={tx('Lien YouTube / Twitch, ou chemin d\'un fichier')} />
            <button className="btn primary" onClick={addLink} disabled={busy}>{tx('Ajouter')}</button>
          </div>
        ) : null}
        {downloads.map((j) => <div key={j.id} className="small muted" style={{ padding: '4px 8px' }}>{tx('Téléchargement')} {Math.round(j.progress * 100)} %<div className="progress"><div style={{ width: `${Math.round(j.progress * 100)}%` }} /></div></div>)}
        {project.sources.length === 0 ? (
          <div style={{ padding: 8 }}><button className="empty" onClick={importFiles}>{tx('Glisse tes fichiers ici ou clique pour importer')}</button></div>
        ) : view === 'grid' ? (
          <div className="bin-grid">
            {shown.map((s) => {
              const st = statusOf(s, jobs);
              return (
                <div key={s.id} className={`tile ${selId === s.id ? 'on' : ''}`} draggable title={s.name}
                  onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'source', id: s.id }))}
                  onClick={() => setSelId(s.id)} onDoubleClick={() => openSource(s)}
                  onContextMenu={(e) => { e.preventDefault(); setSelId(s.id); }}>
                  <div className="tile-img">
                    {s.kind === 'audio' ? <Icon name="audio" size={22} /> : <img src={thumbUrl(previewPath(s), Math.min(30, s.duration / 3), 240)} loading="lazy" alt="" />}
                    {st ? <div className={`tile-state ${st.error ? 'err' : ''}`}>{st.busy ? <span className="spin" style={{ width: 7, height: 7, borderWidth: 1.5 }} /> : null}{st.text}</div> : null}
                    {s.kind !== 'image' ? <span className="tile-dur">{fmt(s.duration, 0)}</span> : null}
                  </div>
                  <div className="row" style={{ gap: 2 }}>
                    <span className="tile-name ellipsis grow">{s.name}</span>
                    {selId === s.id ? <Dropdown align="right" width={240} button={(_, t) => <button className="btn icon sm ghost" style={{ width: 18, height: 18 }} onClick={(e) => { e.stopPropagation(); t(); }}><Icon name="more" size={12} /></button>}>{menuFor(s)}</Dropdown> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div>
            {shown.map((s) => {
              const st = statusOf(s, jobs);
              return (
                <div key={s.id} className="rowi" draggable style={selId === s.id ? { background: 'var(--accent-bg)' } : undefined}
                  onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'source', id: s.id }))}
                  onClick={() => setSelId(s.id)} onDoubleClick={() => openSource(s)}>
                  <Icon name={s.kind === 'audio' ? 'audio' : s.kind === 'image' ? 'image' : 'film'} size={13} className="dim" />
                  <span className="grow ellipsis">{s.name}</span>
                  {st ? <span className={`small ${st.error ? '' : 'dim'}`} style={st.error ? { color: 'var(--danger)' } : undefined}>{st.text}</span> : null}
                  <span className="mono dim">{s.kind !== 'image' ? fmt(s.duration, 0) : ''}</span>
                  <Dropdown align="right" width={240} button={(_, t) => <button className="btn icon sm ghost" style={{ width: 18, height: 18 }} onClick={(e) => { e.stopPropagation(); t(); }}><Icon name="more" size={12} /></button>}>{menuFor(s)}</Dropdown>
                </div>
              );
            })}
          </div>
        )}
        {sel ? (
          <div className="tiny dim" style={{ padding: '4px 10px 10px' }}>
            {sel.width ? `${sel.width}×${sel.height} · ` : ''}{sel.fps ? `${Math.round(sel.fps)} ${tx('i/s')} · ` : ''}{sel.status.transcript === 'done' ? tx('transcrit') : sel.status.transcript === 'running' ? tx('transcription…') : ''}{sel.stems ? tx(' · voix séparée') : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}
