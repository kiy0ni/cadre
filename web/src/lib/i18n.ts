// UI languages. The source text is French; each language is a "French text -> translation" dictionary
// (src/lib/locales/*.json, generated from the code: scripts/i18n.mjs). An untranslated string stays in French.
// tx('Supprimer « {0} » ?', name): {0}, {1}… are replaced by the arguments.
import en from './locales/en.json';
import es from './locales/es.json';
import de from './locales/de.json';
import it from './locales/it.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';

export const LANGS: [Lang, string][] = [['fr', 'Français'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['it', 'Italiano'], ['pt', 'Português'], ['ja', '日本語']];
export type Lang = 'fr' | 'en' | 'es' | 'de' | 'it' | 'pt' | 'ja';
const DICTS: Record<Lang, Record<string, string>> = { fr: {}, en, es, de, it, pt, ja };

function detect(): Lang {
  try {
    const saved = localStorage.getItem('cadre-lang') as Lang | null;
    if (saved && saved in DICTS) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.language || 'fr').slice(0, 2) as Lang;
  return nav in DICTS ? nav : 'en';
}

let lang: Lang = detect();
document.documentElement.lang = lang;

export const getLang = () => lang;

/** changes the language (the UI is reloaded to translate everything at once) */
export function setLang(l: Lang) {
  try { localStorage.setItem('cadre-lang', l); } catch { /* storage unavailable */ }
  lang = l;
  window.location.reload();
}

export function tx(s: string, ...args: (string | number)[]): string {
  // "text|context": same French text, different meaning (e.g. the assistant's "Plan|mode" vs a "plan" = clip in the timeline)
  const tr = (lang === 'fr' ? null : DICTS[lang][s]) || s.split('|')[0];
  return args.length ? tr.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : tr;
}

/** date / number formatting for the language */
export const locale = () => ({ fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', ja: 'ja-JP' }[lang]);

/** alias (old name) */
export const t = tx;
