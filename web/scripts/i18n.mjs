// Extracts the texts to translate (tx('…') calls) and reports what is missing in each language.
//   node scripts/i18n.mjs            -> missing keys per language
//   node scripts/i18n.mjs --keys     -> writes src/lib/locales/_keys.json (all keys, for translation)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const keys = new Set();
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(tsx?|mjs)$/.test(f.name)) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/\btx\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
      for (const m of s.matchAll(/\btx\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1].replace(/\\"/g, '"'));
    }
  }
};
walk(src);
// labels from the effects catalog and the looks (translated at display time)
for (const f of ['remotion/effects.tsx', 'remotion/look.tsx']) {
  const s = fs.readFileSync(path.join(src, f), 'utf8');
  for (const m of s.matchAll(/label: '((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
  for (const m of s.matchAll(/\['[\w.]+', '((?:[^'\\]|\\.)*)'\]/g)) keys.add(m[1]);
}
const all = [...keys].sort();
if (process.argv.includes('--keys')) { fs.writeFileSync(path.join(src, 'lib/locales/_keys.json'), JSON.stringify(all, null, 1)); console.log(all.length, 'keys'); }
for (const l of ['en', 'es', 'de', 'it', 'pt', 'ja']) {
  const d = JSON.parse(fs.readFileSync(path.join(src, `lib/locales/${l}.json`), 'utf8'));
  const miss = all.filter((k) => !(k in d));
  console.log(`${l} : ${all.length - miss.length}/${all.length}${miss.length ? ` — ${miss.length} missing` : ''}`);
}
