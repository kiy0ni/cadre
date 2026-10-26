// Bundles the composition (src/remotion) for the standalone app: node scripts/bundle.mjs <output folder>
import { bundle } from '@remotion/bundler';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/bundle.mjs <folder>'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
await bundle({ entryPoint: path.join(here, '..', 'src', 'remotion', 'index.ts'), outDir: path.resolve(out) });
console.log(`composition bundled: ${out}`);
