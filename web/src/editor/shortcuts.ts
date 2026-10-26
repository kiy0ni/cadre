// Editor keyboard shortcuts and desktop app menu actions.
import { useEffect } from 'react';
import { getFrame, getPlayer, useStore } from '../lib/store';
import { addMarker, copySelection, deleteSelection, duplicateSelection, jumpEdit, pasteAtPlayhead, splitAt, toggleLink, trimToPlayhead, zoomHere } from './actions';
import { tx } from '../lib/i18n';

/** source monitor controls, wired up while it is shown */
export const sourceCtl: { markIn?: () => void; markOut?: () => void; insert?: () => void; overlay?: () => void; toggle?: () => void } = {};
/** timeline controls (zoom) */
export const timelineCtl: { zoom?: (k: number) => void; fit?: () => void } = {};

export function focusAssistant() {
  const st = useStore.getState();
  st.setUi({ assistant: true });
  setTimeout(() => (document.querySelector('.cc-text') as HTMLTextAreaElement | null)?.focus(), 60);
}

export function menuAction(a: string) {
  const st = useStore.getState();
  if (a === 'undo') st.undo();
  else if (a === 'redo') st.redo();
  else if (a === 'split') splitAt(getFrame()) || st.notify(tx('Rien à couper sous la tête de lecture'));
  else if (a === 'delete') deleteSelection();
  else if (a === 'duplicate') duplicateSelection();
  else if (a === 'ai') focusAssistant();
  else if (a === 'import') { st.setUi({ workspace: 'edit', lowerTab: 'project' }); setTimeout(() => (document.querySelector('[data-import]') as HTMLButtonElement | null)?.click(), 60); }
  else if (a === 'export') st.setUi({ workspace: 'export' });
  else if (a === 'play') getPlayer()?.toggle();
  else if (a === 'marker') addMarker();
}

let shuttle = 0;

export function useShortcuts() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      const st = useStore.getState();
      const p = st.project;
      if (!p) return;
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
      if (meta && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (meta && k === 'c') { if (copySelection()) e.preventDefault(); return; }
      if (meta && k === 'x') { if (copySelection(true)) e.preventDefault(); return; }
      if (meta && k === 'v') { if (pasteAtPlayhead()) e.preventDefault(); return; }
      if (meta && k === 'k') { e.preventDefault(); focusAssistant(); return; }
      if (meta && k === 'l') { e.preventDefault(); if (!toggleLink()) st.notify(tx('Sélectionne un plan ou un clip vidéo avec du son')); return; }
      if (meta && k === 'e') { e.preventDefault(); st.setUi({ workspace: 'export' }); return; }
      if (meta) return;
      const fps = p.format.fps;
      const pl = getPlayer();
      const srcActive = st.upperTab === 'source' && !!st.sourceId && st.workspace === 'edit';
      if (e.key === ' ') { e.preventDefault(); shuttle = 0; if (srcActive && document.activeElement?.closest('.src-mon')) sourceCtl.toggle?.(); else pl?.toggle(); }
      else if (k === 'k') { shuttle = 0; pl?.pause(); }
      // J / K / L: play backward / pause / forward; pressing repeatedly speeds up (×2, ×4)
      else if (k === 'l') { shuttle = Math.min(4, Math.max(1, shuttle * 2 || 1)); window.dispatchEvent(new CustomEvent('cadre-rate', { detail: shuttle })); pl?.play(); }
      else if (k === 'j') { shuttle = shuttle > 0 ? -1 : Math.max(-4, shuttle * 2 || -1); window.dispatchEvent(new CustomEvent('cadre-rate', { detail: shuttle })); pl?.play(); }
      else if (k === 'q') { if (!trimToPlayhead('start')) st.notify(tx('Rien à rogner sous la tête de lecture')); }
      else if (k === 'w') { if (!trimToPlayhead('end')) st.notify(tx('Rien à rogner sous la tête de lecture')); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); st.seek(getFrame() - (e.shiftKey ? fps : 1)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); st.seek(getFrame() + (e.shiftKey ? fps : 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); jumpEdit(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); jumpEdit(1); }
      else if (e.key === 'Home') st.seek(0);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(e.shiftKey || e.altKey); }
      else if (k === 'i' && srcActive) sourceCtl.markIn?.();
      else if (k === 'o' && srcActive) sourceCtl.markOut?.();
      else if (e.key === ',' && srcActive) sourceCtl.insert?.();
      else if (e.key === '.' && srcActive) sourceCtl.overlay?.();
      else if (k === 'v') st.setUi({ tool: 'select' });
      else if (k === 'c') st.setUi({ tool: 'razor' });
      else if (k === 's') { if (!splitAt(getFrame())) st.notify(tx('Rien à couper ici')); }
      else if (k === 'm') addMarker();
      else if (k === 'z' && e.shiftKey) timelineCtl.fit?.();
      else if (k === 'z') zoomHere();
      else if (e.key === '+' || e.key === '=') timelineCtl.zoom?.(1.4);
      else if (e.key === '-') timelineCtl.zoom?.(1 / 1.4);
      else if (e.key === 'Escape') st.select({});
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
