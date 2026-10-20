// État de l'éditeur : projet courant, historique (annuler / rétablir), sélection, tête de lecture, tâches, IA.
import { create } from 'zustand';
import type { PlayerRef } from '@remotion/player';
import type { EffectPreset, AiMode, Block, ConvMsg, JobEvent, JobInfo, Library, Pack, Project, Speaker, Usage, Word } from '../types';
import { api, followJob, type AiStatus, type Render } from './api';
import { getLang, tx } from './i18n';

export type Workspace = 'edit' | 'color' | 'audio' | 'export';
export interface Selection { itemId?: string; capId?: string; fxId?: string; musicId?: string; clipId?: string; trackId?: string }
export interface LiveTurn { user: Extract<ConvMsg, { role: 'user' }> | null; blocks: Block[]; usage: Usage | null; startedAt: number; logs: string[] }

interface S {
  packs: Pack[];
  speakers: Speaker[];
  library: Library | null;
  ai: AiStatus | null;
  settings: Record<string, unknown> | null;
  presets: EffectPreset[];
  project: Project | null;
  words: Record<string, Word[]>;
  renders: Render[];
  past: Project[];
  future: Project[];
  lastMerge: { key: string; t: number } | null;
  sel: Selection;
  frame: number;
  playing: boolean;
  saving: 'saved' | 'pending' | 'saving' | 'error';
  jobs: JobInfo[];
  aiJob: string | null;
  aiConv: string | null;
  aiMode: AiMode;
  live: LiveTurn | null;
  setAi: (p: Partial<Pick<S, 'aiConv' | 'aiMode'>>) => void;
  approve: (id: string, decision: 'allow' | 'deny' | 'always') => Promise<void>;
  rewindTo: (messageId: string) => Promise<void>;
  toast: string | null;
  tool: 'select' | 'razor';
  snap: boolean;
  workspace: Workspace;
  assistant: boolean;
  upperTab: 'source' | 'props' | 'words' | 'history';
  lowerTab: 'project' | 'library' | 'effects';
  sourceId: string | null;
  setUi: (p: Partial<Pick<S, 'tool' | 'snap' | 'workspace' | 'assistant' | 'upperTab' | 'lowerTab' | 'sourceId'>>) => void;

  boot: () => Promise<void>;
  setPacks: (p: Pack[]) => void;
  setSpeakers: (s: Speaker[]) => void;
  open: (id: string) => Promise<void>;
  close: () => void;
  update: (fn: (p: Project) => void, merge?: string, label?: string) => void;
  jumpHistory: (k: number) => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  setFrame: (f: number) => void;
  setPlaying: (p: boolean) => void;
  seek: (f: number) => void;
  refreshSources: () => Promise<void>;
  refreshWords: (src: string) => Promise<void>;
  setWords: (src: string, w: Word[]) => void;
  pollJobs: () => Promise<void>;
  watchJob: (id: string) => void;
  askAi: (prompt: string, opts?: { mode?: AiMode; conversation?: string | null }) => Promise<void>;
  notify: (msg: string | null) => void;
}

// Tête de lecture : diffusée hors de React (les composants qui la dessinent s'abonnent et bougent le DOM directement),
// et recopiée dans le store au plus 5 fois par seconde pendant la lecture : la lecture ne re-rend pas toute l'interface.
const frameSubs = new Set<(f: number) => void>();
let liveFrame = 0;
let lastStoreSync = 0;
export const onFrame = (cb: (f: number) => void) => { frameSubs.add(cb); cb(liveFrame); return () => { frameSubs.delete(cb); }; };
export const getFrame = () => liveFrame;
function emitFrame(f: number) { liveFrame = f; for (const cb of frameSubs) cb(f); }

let player: PlayerRef | null = null;
export const setPlayer = (p: PlayerRef | null) => { player = p; (window as unknown as { __player?: PlayerRef | null }).__player = p; };
export const getPlayer = () => player;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Historique : chaque état du projet garde le nom de la modification qui l'a produit (panneau Historique).
export const histMeta = new WeakMap<Project, { label: string; t: number }>();
const LABELS: [RegExp, string][] = [[/trim/, tx('Rognage')], [/drag/, tx('Déplacement')], [/color/, tx('Couleur')], [/look/, tx('Image')], [/mix|trk/, tx('Mixage')],
  [/cap/, tx('Sous-titre')], [/txt/, tx('Texte')], [/fx/, tx('Effet')], [/vol|fin|fout/, tx('Audio')], [/speed/, tx('Vitesse')], [/prefs/, tx('Consignes')], [/name|title/, tx('Nom')],
  [/music/, tx('Musique')], [/label/, tx('Chapitre')]];
const labelFor = (merge?: string) => (merge && LABELS.find(([re]) => re.test(merge))?.[1]) || tx('Modification');
const watched = new Set<string>();

const clone = <T,>(x: T): T => structuredClone(x);

export const useStore = create<S>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    set({ saving: 'pending' });
    saveTimer = setTimeout(async () => {
      const p = get().project;
      if (!p || get().aiJob) return;
      set({ saving: 'saving' });
      try {
        await api.saveProject(p);
        set({ saving: 'saved' });
      } catch (e) {
        set({ saving: 'error', toast: tx('Sauvegarde impossible : {0}', (e as Error).message) });
      }
    }, 700);
  };

  return {
    packs: [], speakers: [], library: null, ai: null, settings: null, presets: [], project: null, words: {}, renders: [], past: [], future: [],
    lastMerge: null, sel: {}, frame: 0, playing: false, saving: 'saved', jobs: [], aiJob: null, aiConv: null, live: null, toast: null,
    aiMode: ((): AiMode => { try { return (localStorage.getItem('cadre-aimode') as AiMode) || 'auto'; } catch { return 'auto'; } })(),
    setAi: (p) => { if (p.aiMode) { try { localStorage.setItem('cadre-aimode', p.aiMode); } catch { /* stockage indisponible */ } } set(p); },
    tool: 'select', snap: true, workspace: 'edit', upperTab: 'props', lowerTab: 'project', sourceId: null,
    assistant: (() => { try { return localStorage.getItem('cadre-assistant') !== '0'; } catch { return true; } })(),
    setUi: (p) => {
      if (p.assistant !== undefined) { try { localStorage.setItem('cadre-assistant', p.assistant ? '1' : '0'); } catch { /* stockage indisponible */ } }
      set(p);
    },

    boot: async () => {
      const b = await api.bootstrap();
      set({ packs: b.packs, speakers: b.speakers, ai: b.ai, settings: b.settings });
      const ui = (b.settings as { ui?: { snap?: boolean; aiMode?: AiMode } }).ui || {};
      if (ui.snap !== undefined) set({ snap: ui.snap });
      try { if (!localStorage.getItem('cadre-aimode') && ui.aiMode) set({ aiMode: ui.aiMode }); } catch { /* stockage indisponible */ }
      api.presets().then((presets) => set({ presets })).catch(() => undefined);
      // la banque se construit côté serveur en tâche de fond : on réessaie tant qu'elle n'est pas prête
      const load = async (n = 0): Promise<void> => {
        try {
          const lib = await api.library();
          if ((lib as unknown as { loading?: boolean }).loading) { if (n < 200) setTimeout(() => load(n + 1), 3000); return; }
          set({ library: lib });
        } catch { set({ toast: tx('Bibliothèque de médias indisponible') }); }
      };
      load();
    },
    setPacks: (packs) => set({ packs }),
    setSpeakers: (speakers) => set({ speakers }),

    open: async (id) => {
      const r = await api.project(id);
      emitFrame(0);
      histMeta.set(r.project, { label: tx('Ouverture du projet'), t: Date.now() });
      set({ project: r.project, words: r.words, renders: r.renders, past: [], future: [], sel: {}, frame: 0, saving: 'saved',
        live: null, aiJob: null, aiConv: r.project.conversations?.[0]?.id || null, sourceId: null, workspace: 'edit' });
      const jobs = await api.jobs(id);
      set({ jobs });
      for (const j of jobs) if (j.status === 'queued' || j.status === 'running') get().watchJob(j.id);
    },
    close: () => set({ project: null, words: {}, past: [], future: [], sel: {} }),

    update: (fn, merge, label) => {
      const p = get().project;
      if (!p) return;
      if (get().aiJob) { set({ toast: tx("L'IA est en train de monter : attends qu'elle ait fini (ou arrête-la).") }); return; }
      const next = clone(p);
      fn(next);
      const now = Date.now();
      const lm = get().lastMerge;
      const coalesce = merge && lm && lm.key === merge && now - lm.t < 1200;
      histMeta.set(next, { label: label || labelFor(merge), t: now });
      set({
        project: next,
        past: coalesce ? get().past : [...get().past.slice(-99), p],
        future: [],
        lastMerge: merge ? { key: merge, t: now } : null,
      });
      scheduleSave();
    },
    undo: () => {
      const { past, project, future } = get();
      if (!past.length || !project || get().aiJob) return;
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], lastMerge: null });
      scheduleSave();
    },
    redo: () => {
      const { past, project, future } = get();
      if (!future.length || !project || get().aiJob) return;
      set({ project: future[0], future: future.slice(1), past: [...past, project], lastMerge: null });
      scheduleSave();
    },
    jumpHistory: (k) => {
      const { past, project, future } = get();
      if (!project || get().aiJob) return;
      const all = [...past, project, ...future];
      if (k < 0 || k >= all.length || all[k] === project) return;
      set({ project: all[k], past: all.slice(0, k), future: all.slice(k + 1), lastMerge: null });
      scheduleSave();
    },
    select: (sel) => set({ sel }),
    setFrame: (frame) => {
      emitFrame(frame);
      const now = performance.now();
      if (!get().playing || now - lastStoreSync > 200) { lastStoreSync = now; set({ frame }); }
    },
    setPlaying: (playing) => set({ playing, frame: liveFrame }),
    seek: (f) => {
      const fr = Math.max(0, Math.round(f));
      player?.seekTo(fr);
      emitFrame(fr);
      set({ frame: fr });
    },

    refreshSources: async () => {
      const p = get().project;
      if (!p) return;
      const sources = await api.sources(p.id);
      const cur = get().project;
      if (!cur) return;
      const byId = new Map(sources.map((s) => [s.id, s]));
      const merged = cur.sources.filter((s) => byId.has(s.id)).map((s) => ({ ...s, ...byId.get(s.id)!, name: s.name }));
      for (const s of sources) if (!merged.find((m) => m.id === s.id)) merged.push(s);
      set({ project: { ...cur, sources: merged } });
    },
    refreshWords: async (src) => {
      const p = get().project;
      if (!p) return;
      const w = await api.words(p.id, src);
      set({ words: { ...get().words, [src]: w } });
    },
    setWords: (src, w) => {
      const p = get().project;
      if (!p) return;
      set({ words: { ...get().words, [src]: w } });
      api.saveWords(p.id, src, w).catch(() => set({ toast: tx('Transcription non enregistrée') }));
    },

    pollJobs: async () => {
      const p = get().project;
      const jobs = await api.jobs(p?.id);
      set({ jobs });
    },
    watchJob: (id) => {
      if (watched.has(id)) return;
      watched.add(id);
      followJob(id, undefined, (j) => {
        set({ jobs: [...get().jobs.filter((x) => x.id !== j.id), j].sort((a, b) => a.created - b.created) });
      }).then(async (j) => {
        watched.delete(id);
        const p = get().project;
        if (!p || j.project !== p.id) return;
        await get().refreshSources();
        const src = j.meta?.source as string | undefined;
        if (src && ['transcribe', 'speakers'].includes(j.kind)) await get().refreshWords(src);
        if (j.kind === 'render' && j.status === 'done') {
          set({ renders: await api.renders(p.id), toast: tx('Export terminé') });
          const ui = (get().settings as { ui?: { notify?: boolean; revealExport?: boolean } } | null)?.ui || {};
          const path = (j.result as { path?: string } | null)?.path;
          if (ui.notify !== false && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('Cadre', { body: `${tx('Export terminé')} : ${path?.split(/[\\/]/).pop() || ''}` });
          if (ui.revealExport && path) (window as unknown as { cadre?: { reveal: (p: string) => void } }).cadre?.reveal(path);
        }
        if (j.kind === 'download' && j.status === 'done') await get().refreshSources();
        if (j.status === 'error') set({ toast: `${j.label} : ${j.error}` });
      });
    },

    askAi: async (prompt, opts = {}) => {
      const p = get().project;
      if (!p || get().aiJob) return;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await api.saveProject(p).catch(() => undefined);
      const f = liveFrame;
      const before = clone(p);
      const sel = get().sel;
      const mode = opts.mode || get().aiMode;
      const conversation = opts.conversation !== undefined ? opts.conversation : get().aiConv;
      const { job } = await api.ai(p.id, {
        prompt, mode, conversation,
        context: {
          selected: sel.itemId ? describeSel(p, sel.itemId) : sel.clipId ? tx('clip de piste [{0}]', sel.clipId) : undefined,
          time: f ? tx('image {0} ({1} s de la vidéo montée)', f, (f / p.format.fps).toFixed(1)) : undefined,
          lang: getLang(),
        },
      });
      set({ aiJob: job, live: { user: null, blocks: [], usage: null, startedAt: Date.now(), logs: [] }, past: [...get().past.slice(-99), before], future: [] });
      get().watchJob(job);
      const patch = (fn: (l: LiveTurn) => LiveTurn) => { const l = get().live; if (l) set({ live: fn(l) }); };
      const done = await followJob(job, (e: JobEvent) => {
        if (e.type === 'project') { if (get().aiJob === job) set({ project: e.project as Project }); }
        else if (e.type === 'conversation') { set({ aiConv: e.id as string }); patch((l) => ({ ...l, user: e.userMessage as LiveTurn['user'] })); }
        else if (e.type === 'delta') patch((l) => {
          const b = [...l.blocks];
          const last = b[b.length - 1] as (Block & { open?: boolean }) | undefined;
          if (last && last.type === 'text' && last.open) b[b.length - 1] = { ...last, text: last.text + String(e.text) } as Block;
          else b.push({ type: 'text', text: String(e.text), open: true } as Block);
          return { ...l, blocks: b };
        });
        else if (e.type === 'delta_end') patch((l) => ({ ...l, blocks: l.blocks.map((x) => { const y = { ...x } as Block & { open?: boolean }; delete y.open; return y; }) }));
        else if (e.type === 'note') patch((l) => {
          const b = [...l.blocks];
          const last = b[b.length - 1];
          if (last && last.type === 'thinking') b[b.length - 1] = { ...last, text: last.text + String(e.text) };
          else b.push({ type: 'thinking', text: String(e.text) });
          return { ...l, blocks: b };
        });
        else if (e.type === 'tool_start') patch((l) => ({ ...l, blocks: [...l.blocks, e.block as Block] }));
        else if (e.type === 'approval' || e.type === 'tool_status' || e.type === 'tool_end') patch((l) => ({
          ...l, blocks: l.blocks.map((x) => (x.type === 'tool' && x.id === e.id
            ? { ...x, status: (e.type === 'approval' ? 'pending' : e.status) as 'done', ...(e.result !== undefined ? { result: String(e.result) } : {}) } : x)),
        }));
        else if (e.type === 'usage') patch((l) => ({ ...l, usage: e.usage as Usage }));
        else if (e.type === 'log') patch((l) => ({ ...l, logs: [...l.logs.slice(-20), String(e.text)] }));
      });
      const fresh = await api.project(p.id);
      histMeta.set(fresh.project, { label: `Assistant : ${prompt.split('\n')[0].slice(0, 60)}`, t: Date.now() });
      set({ aiJob: null, live: null, project: fresh.project, words: fresh.words });
      // l'assistant a pu lancer des tâches (export…) : on les suit aussi
      const js = await api.jobs(p.id).catch(() => []);
      for (const j of js) if (j.status === 'queued' || j.status === 'running') get().watchJob(j.id);
      if (done.status === 'error') set({ toast: `IA : ${done.error}` });
    },
    approve: async (id, decision) => {
      const job = get().aiJob;
      if (!job) return;
      await api.approve(job, id, decision).catch((e) => set({ toast: (e as Error).message }));
    },
    rewindTo: async (messageId) => {
      const p = get().project;
      const conv = get().aiConv;
      if (!p || !conv || get().aiJob) return;
      const before = clone(p);
      const r = await api.rewind(p.id, conv, messageId);
      histMeta.set(r.project, { label: tx('Retour avant un message'), t: Date.now() });
      set({ project: r.project, past: [...get().past.slice(-99), before], future: [], toast: tx('Montage remis comme avant ce message (⌘Z pour revenir)') });
    },
    notify: (toast) => set({ toast }),
  };
});

function describeSel(p: Project, id: string) {
  const it = p.timeline.find((x) => x.id === id);
  if (!it) return undefined;
  const i = p.timeline.indexOf(it);
  if (it.type === 'clip') return `[${it.id}] plan n°${i} ${it.src} ${it.in.toFixed(2)}-${it.out.toFixed(2)}${it.label ? ` « ${it.label} »` : ''}`;
  return `[${it.id}] ${it.type} n°${i}`;
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 12);
