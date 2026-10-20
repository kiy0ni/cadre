// Empaquette la composition (src/remotion) pour l'appli autonome : node scripts/bundle.mjs <dossier de sortie>
import { bundle } from '@remotion/bundler';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('usage : node scripts/bundle.mjs <dossier>'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
await bundle({ entryPoint: path.join(here, '..', 'src', 'remotion', 'index.ts'), outDir: path.resolve(out) });
console.log(`composition empaquetée : ${out}`);
