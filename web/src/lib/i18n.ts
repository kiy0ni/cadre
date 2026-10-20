// Langues de l'interface. Le texte source est en français ; chaque langue est un dictionnaire « texte français -> traduction »
// (src/lib/locales/*.json, généré depuis le code : scripts/i18n.mjs). Une chaîne non traduite reste en français.
// tx('Supprimer « {0} » ?', nom) : {0}, {1}… sont remplacés par les arguments.
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
  } catch { /* stockage indisponible */ }
  const nav = (navigator.language || 'fr').slice(0, 2) as Lang;
  return nav in DICTS ? nav : 'en';
}

let lang: Lang = detect();
document.documentElement.lang = lang;

export const getLang = () => lang;

/** change la langue (l'interface est rechargée pour tout traduire d'un coup) */
export function setLang(l: Lang) {
  try { localStorage.setItem('cadre-lang', l); } catch { /* stockage indisponible */ }
  lang = l;
  window.location.reload();
}

export function tx(s: string, ...args: (string | number)[]): string {
  // « texte|contexte » : même texte français, sens différent (ex. « Plan|mode » de l'assistant vs un plan de la timeline)
  const tr = (lang === 'fr' ? null : DICTS[lang][s]) || s.split('|')[0];
  return args.length ? tr.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : tr;
}

/** format de date / nombre selon la langue */
export const locale = () => ({ fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', ja: 'ja-JP' }[lang]);

/** alias (ancien nom) */
export const t = tx;
