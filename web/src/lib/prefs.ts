// UI preferences (stored in the engine settings: the same on all your devices).
import { useStore } from './store';
import { api } from './api';
import type { AiMode } from '../types';

export interface Prefs {
  defaultPack: string;         // style for new projects ('' = the first one)
  defaultFormat: string;       // '' = the style's own
  snap: boolean;               // snapping enabled on open
  previewFull: boolean;        // full-quality preview by default
  thumbs: boolean;             // thumbnails in the timeline
  waves: boolean;              // waveforms in the timeline
  followPlayhead: boolean;     // the timeline follows the playhead
  imageDur: number;            // duration of a placed image (s)
  textDur: number;             // duration of a placed title (s)
  transitionDur: number;       // duration of a placed transition (s)
  notify: boolean;             // system notification when an export finishes
  revealExport: boolean;       // open the folder when an export finishes (desktop app)
  exportPreset: string;        // default export preset
  aiMode: AiMode;              // default assistant mode
  confirmDelete: boolean;      // ask before deleting a project / a non-empty track
}

export const DEFAULT_PREFS: Prefs = {
  defaultPack: '', defaultFormat: '', snap: true, previewFull: false, thumbs: true, waves: true, followPlayhead: true,
  imageDur: 3, textDur: 3, transitionDur: 0.4, notify: true, revealExport: false, exportPreset: 'web', aiMode: 'auto', confirmDelete: true,
};

export function getPrefs(): Prefs {
  const s = useStore.getState().settings as { ui?: Partial<Prefs> } | null;
  return { ...DEFAULT_PREFS, ...(s?.ui || {}) };
}

export function usePrefs(): Prefs {
  const ui = useStore((s) => (s.settings as { ui?: Partial<Prefs> } | null)?.ui);
  return { ...DEFAULT_PREFS, ...(ui || {}) };
}

export async function setPrefs(patch: Partial<Prefs>) {
  const cur = getPrefs();
  const ui = { ...cur, ...patch };
  useStore.setState({ settings: { ...(useStore.getState().settings || {}), ui } });
  const r = await api.saveSettings({ ui });
  useStore.setState({ settings: r.settings });
}
