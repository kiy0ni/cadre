import { locale, tx } from './i18n';

// Formats d'affichage : durées, timecodes (HH:MM:SS:II), dates relatives, tailles.

/** 83.4 -> « 1:23.4 » (heures si besoin) */
export function fmt(sec: number, dec = 1): string {
  if (!isFinite(sec)) return '–';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const rs = r.toFixed(dec).padStart(dec ? 3 + dec : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rs}` : `${m}:${rs}`;
}

/** image -> timecode « 00:01:23:12 » */
export function tc(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const ff = f % fps;
  const s = Math.floor(f / fps);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(ff)}`;
}

/** libellé court de la règle : « 1:05 », « 1:05:00 » (heures) */
export function ruler(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** « 1:23.5 », « 83.5 », « 00:01:23:12 » (avec fps) -> secondes */
export function parseTime(v: string, fps = 30): number | null {
  const t = v.trim().replace(',', '.');
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((x) => isNaN(x))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

export const ago = (t: number) => {
  const d = Date.now() / 1000 - t;
  if (d < 60) return tx("à l'instant");
  if (d < 3600) return tx('il y a {0} min', Math.floor(d / 60));
  if (d < 86400) return tx('il y a {0} h', Math.floor(d / 3600));
  return new Date(t * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
};

export const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} ${tx('Go')}` : `${(n / 1024 / 1024).toFixed(n > 1e8 ? 0 : 1)} ${tx('Mo')}`);

export const nf = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n));

/** libellé d'une tâche du moteur dans la langue de l'interface */
export function jobLabel(j: { kind: string; label: string }) {
  const k: Record<string, string> = {
    proxy: tx('Copie allégée'), transcribe: tx('Transcription'), speakers: tx('Reconnaissance des voix'), stems: tx('Séparation voix / fond'),
    render: tx('Export'), download: tx('Téléchargement'), setup: tx('Installation'), style: tx('Création du style'), ai: tx('Assistant'),
  };
  return k[j.kind] || j.label;
}
