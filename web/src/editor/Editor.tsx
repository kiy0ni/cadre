// Editor: top bar (project, workspaces, assistant, export) and panel layout per workspace.
// Edit: [Source | Properties | Transcript] + Program on top, [Project | Library | Effects] + Timeline at the bottom,
// assistant full height on the right. Color, Audio, Export: dedicated layouts. Phone: one panel at a time.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Icon, Logo } from '../lib/icons';
import { useStore, type Workspace } from '../lib/store';
import { Dropdown, useIsMobile, useSize } from '../lib/ui';
import { ago, jobLabel } from '../lib/format';
import { Comp, useBuildComp } from './comp';
import { ProgramMonitor, SourceMonitor } from './Monitor';
import { Timeline } from './Timeline';
import { PropsPanel } from './Props';
import { Assistant } from './Assistant';
import { TranscriptPanel } from './TranscriptPanel';
import { ProjectBin } from './panels/ProjectBin';
import { LibraryPanel } from './panels/Library';
import { EffectsPanel } from './panels/Effects';
import { ColorPanel, ExportPage, Mixer } from './Workspaces';
import { focusAssistant, useShortcuts } from './shortcuts';
import { HistoryPanel } from './History';
import { migrateLegacyMusic } from './actions';
import { tx } from '../lib/i18n';

export function Editor({ id }: { id: string }) {
  const open = useStore((s) => s.open);
  const close = useStore((s) => s.close);
  const project = useStore((s) => s.project);
  const comp = useBuildComp();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    open(id).catch((e) => setErr(String(e)));
    return () => close();
  }, [id, open, close]);
  useEffect(() => { if (project) document.title = `${project.name} · Cadre`; return () => { document.title = 'Cadre'; }; }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="overlay-msg" style={{ position: 'fixed' }}><b>{tx('Projet introuvable')}</b><a className="btn" href="#/">{tx('Retour aux projets')}</a></div>;
  if (!project || project.id !== id || !comp) return <div className="overlay-msg" style={{ position: 'fixed' }}><span className="spin" /></div>;
  return <Comp.Provider value={comp}><Responsive /></Comp.Provider>;
}

function Responsive() {
  useShortcuts();
  const pid = useStore((s) => s.project?.id);
  useEffect(() => { migrateLegacyMusic(); }, [pid]);
  const sel = useStore((s) => s.sel);
  const setUi = useStore((s) => s.setUi);
  useEffect(() => {
    if (!(sel.itemId || sel.clipId || sel.musicId)) return;
    const st = useStore.getState();
    if (st.upperTab !== 'source' && st.upperTab !== 'history') setUi({ upperTab: 'props' });
  }, [sel.itemId, sel.clipId, sel.musicId, setUi]);
  return useIsMobile() ? <MobileLayout /> : <DesktopLayout />;
}

// ---------------------------------------------------------------- desktop
// maximized panel (double-click on the tabs, or the ² / ` key on hover): only one at a time
let hovered: string | null = null;
let setMaxGlobal: ((v: string | null) => void) | null = null;
let maxGlobal: string | null = null;

function Panel({ id, tabs, active, onTab, children, style, tools }: { id?: string; tabs?: [string, string][]; active?: string; onTab?: (k: string) => void; children: ReactNode; style?: React.CSSProperties; tools?: ReactNode }) {
  const maxed = !!id && maxGlobal === id;
  const toggle = () => { if (id && setMaxGlobal) setMaxGlobal(maxed ? null : id); };
  return (
    <section className={`panel ${maxed ? 'maxed' : ''}`} style={style} onMouseEnter={() => { hovered = id || null; }}>
      {tabs ? (
        <div className="ptabs" onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('.ptab') || e.target === e.currentTarget) toggle(); }}>
          {tabs.map(([k, l]) => <button key={k} className={`ptab ${active === k ? 'on' : ''}`} onClick={() => onTab?.(k)}>{l}</button>)}
          <div className="tools">
            {tools}
            {id ? <button className="btn icon sm ghost max-btn" onClick={toggle} title={maxed ? tx('Réduire (²)') : tx('Agrandir le panneau (²)')}><Icon name={maxed ? 'fit' : 'full'} size={12} /></button> : null}
          </div>
        </div>
      ) : null}
      {children}
    </section>
  );
}

function useMaxPanel() {
  const [max, setMax] = useState<string | null>(null);
  maxGlobal = max;
  setMaxGlobal = setMax;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.key === '²' || e.key === '`') { e.preventDefault(); setMax((m) => (m ? null : hovered)); }
      if (e.key === 'Escape') setMax(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return max;
}

function DesktopLayout() {
  useMaxPanel();
  const workspace = useStore((s) => s.workspace);
  const assistant = useStore((s) => s.assistant);
  const setUi = useStore((s) => s.setUi);
  const upperTab = useStore((s) => s.upperTab);
  const lowerTab = useStore((s) => s.lowerTab);
  const sourceId = useStore((s) => s.sourceId);
  const [srcWords, setSrcWords] = useState<string | null>(null);
  const [upperH, dragUpper] = useSize('upper', Math.round(window.innerHeight * 0.52), 180, () => window.innerHeight - 220);
  const [leftW, dragLeft] = useSize('left', 330, 240, () => window.innerWidth * 0.45);
  const [lowLeftW, dragLowLeft] = useSize('lowleft', 330, 220, () => window.innerWidth * 0.45);
  const [aiW, dragAi] = useSize('ai', 360, 280, () => window.innerWidth * 0.45);
  const [sideW, dragSide] = useSize('side', 360, 260, () => window.innerWidth * 0.5);

  let main: ReactNode;
  if (workspace === 'edit') {
    main = (
      <>
        <div className="ed-upper" style={{ height: upperH, flex: 'none' }}>
          <Panel id="upper" style={{ width: leftW, flex: 'none' }} active={upperTab} onTab={(k) => setUi({ upperTab: k as 'props' })}
            tabs={[['source', tx('Source')], ['props', tx('Propriétés')], ['words', tx('Paroles')], ['history', tx('Historique')]]}>
            {upperTab === 'source' ? <SourceMonitor /> : upperTab === 'history' ? <HistoryPanel /> : upperTab === 'words' ? <TranscriptPanel srcId={srcWords || sourceId} setSrcId={setSrcWords} /> : <PropsPanel />}
          </Panel>
          <div className="gutter-v" onPointerDown={(e) => dragLeft(e, 'x', 1)} />
          <Panel id="program" style={{ flex: 1 }} tabs={[['program', tx('Programme')]]} active="program"><ProgramMonitor /></Panel>
        </div>
        <div className="gutter-h" onPointerDown={(e) => dragUpper(e, 'y', 1)} />
        <div className="ed-upper">
          <Panel id="lower" style={{ width: lowLeftW, flex: 'none' }} active={lowerTab} onTab={(k) => setUi({ lowerTab: k as 'project' })}
            tabs={[['project', tx('Projet')], ['library', tx('Bibliothèque')], ['effects', tx('Effets')]]}>
            {lowerTab === 'project' ? <ProjectBin /> : lowerTab === 'library' ? <LibraryPanel /> : <EffectsPanel />}
          </Panel>
          <div className="gutter-v" onPointerDown={(e) => dragLowLeft(e, 'x', 1)} />
          <Panel id="timeline" style={{ flex: 1 }} tabs={[['tl', tx('Timeline')]]} active="tl"><Timeline /></Panel>
        </div>
      </>
    );
  } else if (workspace === 'color' || workspace === 'audio') {
    main = (
      <>
        <div className="ed-upper" style={{ height: upperH, flex: 'none' }}>
          <Panel id="program" style={{ flex: 1 }} tabs={[['program', tx('Programme')]]} active="program"><ProgramMonitor /></Panel>
          <div className="gutter-v" onPointerDown={(e) => dragSide(e, 'x', -1)} />
          <Panel id="side" style={{ width: sideW, flex: 'none' }} tabs={[['p', workspace === 'color' ? tx('Couleur') : tx('Propriétés')]]} active="p">
            {workspace === 'color' ? <ColorPanel /> : <PropsPanel />}
          </Panel>
        </div>
        <div className="gutter-h" onPointerDown={(e) => dragUpper(e, 'y', 1)} />
        <div className="ed-upper">
          {workspace === 'audio' ? (
            <>
              <Panel id="mixer" style={{ width: lowLeftW, flex: 'none' }} tabs={[['m', tx('Mixage')]]} active="m"><Mixer /></Panel>
              <div className="gutter-v" onPointerDown={(e) => dragLowLeft(e, 'x', 1)} />
            </>
          ) : null}
          <Panel id="timeline" style={{ flex: 1 }} tabs={[['tl', tx('Timeline')]]} active="tl"><Timeline compact={workspace === 'color'} /></Panel>
        </div>
      </>
    );
  } else {
    main = (
      <div className="ed-upper" style={{ flex: 1 }}>
        <Panel style={{ flex: 1 }}><ExportPage /></Panel>
        <div className="gutter-v" onPointerDown={(e) => dragSide(e, 'x', -1)} />
        <Panel style={{ width: Math.max(sideW, 420), flex: 'none' }} tabs={[['program', tx('Aperçu')]]} active="program"><ProgramMonitor compact /></Panel>
      </div>
    );
  }

  return (
    <div className="ed">
      <TopBar />
      <div className="ed-body" style={{ flexDirection: 'row' }}>
        <div className="col" style={{ flex: 1, minWidth: 0, gap: 0 }}>{main}</div>
        {assistant ? (
          <>
            <div className="gutter-v" onPointerDown={(e) => dragAi(e, 'x', -1)} />
            <Panel id="ai" style={{ width: aiW, flex: 'none' }}><Assistant onClose={() => setUi({ assistant: false })} /></Panel>
          </>
        ) : null}
      </div>
    </div>
  );
}

const WORKSPACES: [Workspace, string][] = [['edit', tx('Montage')], ['color', tx('Couleur')], ['audio', tx('Audio')], ['export', tx('Export')]];

function TopBar({ mobile = false }: { mobile?: boolean }) {
  const project = useStore((s) => s.project)!;
  const saving = useStore((s) => s.saving);
  const jobs = useStore((s) => s.jobs);
  const update = useStore((s) => s.update);
  const aiJob = useStore((s) => s.aiJob);
  const workspace = useStore((s) => s.workspace);
  const assistant = useStore((s) => s.assistant);
  const setUi = useStore((s) => s.setUi);
  const [editing, setEditing] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const running = jobs.filter((j) => (j.status === 'running' || j.status === 'queued') && j.kind !== 'ai');
  const status = saving === 'saved' ? tx('Enregistré {0}', ago(project.updatedAt)) : saving === 'error' ? tx('Non enregistré') : tx('Enregistrement…');

  return (
    <header className="ed-top">
      <div className="crumb">
        <a href="#/" className="btn icon ghost" title={tx('Projets')}><Logo size={18} /></a>
        {editing ? (
          <input className="input" autoFocus defaultValue={project.name} style={{ width: 220, height: 24 }}
            onBlur={(e) => { update((p) => { p.name = e.target.value || p.name; }); setEditing(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }} />
        ) : <b className="ellipsis nd" style={{ maxWidth: mobile ? 150 : 260, cursor: 'text' }} onDoubleClick={() => setEditing(true)} title={tx('Double-clic pour renommer')}>{project.name}</b>}
        {!mobile ? <span className="dot" style={{ background: saving === 'error' ? 'var(--danger)' : saving === 'saved' ? 'var(--text-3)' : 'var(--warn)', width: 6, height: 6 }} title={status} /> : null}
      </div>
      {!mobile ? (
        <nav className="workspaces">
          {WORKSPACES.map(([k, l]) => <button key={k} className={workspace === k ? 'on' : ''} onClick={() => setUi({ workspace: k })}>{l}</button>)}
        </nav>
      ) : <span />}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
        {running.length ? (
          <Dropdown align="right" width={300} button={(_, t) => (
            <button className="btn sm ghost" onClick={t} title={tx('Tâches en cours')}><span className="spin" style={{ width: 9, height: 9 }} />{!mobile ? <span className="small">{running.length > 1 ? tx('{0} tâches', running.length) : `${jobLabel(running[0]).slice(0, 24)} ${Math.round(running[0].progress * 100)} %`}</span> : null}</button>
          )}>
            {() => running.map((j) => (
              <div key={j.id} className="col" style={{ padding: '6px 10px', gap: 4 }}>
                <div className="row small"><span className="grow ellipsis">{jobLabel(j)}</span><span className="mono">{Math.round(j.progress * 100)} %</span>
                  <button className="btn icon sm ghost" style={{ width: 18, height: 18 }} onClick={() => api.cancelJob(j.id)} title={tx('Annuler')}><Icon name="x" size={10} /></button></div>
                <div className="progress"><div style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
              </div>
            ))}
          </Dropdown>
        ) : null}
        {!mobile ? (
          <button className={`btn sm ${assistant ? 'on' : 'ghost'}`} onClick={() => (assistant ? setUi({ assistant: false }) : focusAssistant())} title={tx('Assistant (⌘K)')}>
            {aiJob ? <span className="spin" style={{ width: 9, height: 9 }} /> : <Icon name="assistant" size={14} />} Assistant
          </button>
        ) : null}
        <button className="btn sm primary" onClick={() => setUi({ workspace: 'export' })} title={tx('Exporter (⌘E)')}><Icon name="export" size={13} />{!mobile ? tx(' Exporter') : ''}</button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- phone
type MTab = 'ai' | 'timeline' | 'media' | 'props' | 'more';

function MobileLayout() {
  const [tab, setTab] = useState<MTab>('ai');
  const [more, setMore] = useState<null | 'library' | 'effects' | 'words' | 'mix' | 'export'>(null);
  const [srcWords, setSrcWords] = useState<string | null>(null);
  const sel = useStore((s) => s.sel);
  useEffect(() => { if (sel.itemId || sel.clipId || sel.musicId) setTab((t) => (t === 'timeline' ? t : 'props')); }, [sel.itemId, sel.clipId, sel.musicId]);
  const tabs: [MTab, string, string][] = [['ai', 'assistant', tx('Assistant')], ['timeline', 'layers', tx('Timeline')], ['media', 'media', tx('Médias')], ['props', 'sliders', tx('Réglages')], ['more', 'more', tx('Plus')]];
  const MORE: [NonNullable<typeof more>, string, string][] = [['library', 'music', tx('Bibliothèque')], ['effects', 'style', tx('Effets et titres')], ['words', 'captions', tx('Paroles')], ['mix', 'audio', tx('Mixage')], ['export', 'export', tx('Exporter')]];
  return (
    <div className="m-ed">
      <TopBar mobile />
      <div className="m-viewer"><ProgramMonitor compact /></div>
      <div className="m-body">
        {tab === 'ai' ? <Assistant />
          : tab === 'timeline' ? <Timeline compact />
          : tab === 'media' ? <ProjectBin />
          : tab === 'props' ? <PropsPanel />
          : more ? (
            <>
              <div className="toolbar"><button className="btn icon sm ghost" onClick={() => setMore(null)}><Icon name="back" size={14} /></button><b>{MORE.find((m) => m[0] === more)?.[2]}</b></div>
              {more === 'library' ? <LibraryPanel /> : more === 'effects' ? <EffectsPanel /> : more === 'words' ? <TranscriptPanel srcId={srcWords} setSrcId={setSrcWords} />
                : more === 'mix' ? <Mixer /> : <ExportPage />}
            </>
          ) : (
            <div className="pad">
              {MORE.map(([k, i, l]) => <button key={k} className="list-item" style={{ border: 'none', background: 'none', width: '100%' }} onClick={() => setMore(k)}><Icon name={i} size={15} /> {l}<span className="spacer" /><Icon name="chevr" size={12} /></button>)}
              <a className="list-item" href="#/reglages"><Icon name="settings" size={15} /> {tx('Réglages')}</a>
            </div>
          )}
      </div>
      <nav className="m-tabs">
        {tabs.map(([k, icon, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); if (k === 'more') setMore(null); }}><Icon name={icon} size={18} />{label}</button>)}
      </nav>
    </div>
  );
}
