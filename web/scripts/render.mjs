// Final render: node scripts/render.mjs <props.json> <output> [JSON options | final | draft]
// options: { codec: h264|h265|prores|wav, crf, scale, proresProfile }. The composition (src/remotion) is bundled
// once, then reused as long as it does not change. Progress is reported as JSON on stdout.
import { renderMedia, selectComposition } from '@remotion/renderer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [propsPath, out, rawOpts = 'final'] = process.argv.slice(2);
if (!propsPath || !out) {
  console.error('usage: node scripts/render.mjs props.json output [options]');
  process.exit(2);
}
let opts;
try { opts = JSON.parse(rawOpts); } catch { opts = rawOpts === 'draft' ? { codec: 'h264', crf: 28, scale: 0.5 } : { codec: 'h264', crf: 18, scale: 1 }; }
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const inputProps = JSON.parse(fs.readFileSync(propsPath, 'utf8'));

/** fingerprint of the composition files: only re-bundle when they have changed */
function fingerprint() {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|css)$/.test(f.name)) h.update(p + fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(src, 'remotion'));
  h.update(String(fs.statSync(path.join(src, 'types.ts')).mtimeMs));
  return h.digest('hex').slice(0, 12);
}

let serveUrl = process.env.CADRE_BUNDLE && fs.existsSync(path.join(process.env.CADRE_BUNDLE, 'index.html')) ? process.env.CADRE_BUNDLE : null;
if (!serveUrl) {
  const dir = path.join(os.tmpdir(), `cadre-bundle-${fingerprint()}`);
  if (fs.existsSync(path.join(dir, 'index.html'))) serveUrl = dir;
  else {
    say({ progress: 0, message: 'preparing the renderer…' });
    const { bundle } = await import('@remotion/bundler');
    serveUrl = await bundle({
      entryPoint: path.join(src, 'remotion', 'index.ts'),
      outDir: dir,
      onProgress: (p) => say({ progress: 0.05 * (p / 100), message: `preparing ${p}%` }),
    });
  }
}

const composition = await selectComposition({ serveUrl, id: 'Main', inputProps });
const total = composition.durationInFrames;
say({ progress: 0.05, message: `rendering ${total} frames (${(total / composition.fps / 60).toFixed(1)} min)…` });

const codec = ['h264', 'h265', 'prores', 'wav'].includes(opts.codec) ? opts.codec : 'h264';
let lastPct = -1;
await renderMedia({
  composition,
  serveUrl,
  codec,
  outputLocation: out,
  inputProps,
  ...(codec === 'h264' || codec === 'h265' ? { crf: opts.crf ?? 18 } : {}),
  ...(codec === 'prores' ? { proResProfile: opts.proresProfile || 'hq' } : {}),
  ...(codec !== 'wav' ? { scale: opts.scale || 1 } : {}),
  ...(codec === 'wav' ? {} : codec === 'prores' ? {} : { audioBitrate: '320k' }),
  concurrency: Math.max(2, Math.floor(os.cpus().length * 0.75)),
  offthreadVideoCacheSizeInBytes: 2 * 1024 * 1024 * 1024,
  timeoutInMilliseconds: 120000,
  onProgress: ({ progress, renderedFrames, encodedFrames, stitchStage }) => {
    const pct = Math.floor(progress * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      say({ progress: 0.05 + 0.95 * progress, message: `${stitchStage === 'muxing' ? 'muxing' : 'rendering'} ${pct}% (${renderedFrames}/${total} frames, ${encodedFrames} encoded)` });
    }
  },
});
say({ progress: 1, message: 'render complete' });
