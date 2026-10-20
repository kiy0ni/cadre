// Préférences de l'interface (enregistrées dans les réglages du moteur : les mêmes sur tous tes appareils).
import { useStore } from './store';
import { api } from './api';
import type { AiMode } from '../types';

export interface Prefs {
  defaultPack: string;         // style des nouveaux projets ('' = le premier)
  defaultFormat: string;       // '' = celui du style
  snap: boolean;               // magnétisme activé à l'ouverture
  previewFull: boolean;        // aperçu en pleine qualité par défaut
  thumbs: boolean;             // vignettes dans la timeline
  waves: boolean;              // formes d'onde dans la timeline
  followPlayhead: boolean;     // la timeline suit la tête de lecture
  imageDur: number;            // durée d'une image posée (s)
  textDur: number;             // durée d'un titre posé (s)
  transitionDur: number;       // durée d'une transition posée (s)
  notify: boolean;             // notification système à la fin d'un export
  revealExport: boolean;       // ouvrir le dossier à la fin d'un export (appli de bureau)
  exportPreset: string;        // préréglage d'export par défaut
  aiMode: AiMode;              // mode de l'assistant par défaut
  confirmDelete: boolean;      // demander avant de supprimer un projet / une piste pleine
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
