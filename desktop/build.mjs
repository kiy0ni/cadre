// Fabrique l'appli Cadre.
//   pnpm package                 Mac, liée à ce dépôt (utilise engine/.venv) et installée dans /Applications
//   pnpm dist:mac                Mac autonome à distribuer (dist/Cadre-mac-<arch>.zip)
//   pnpm dist:win                Windows autonome à distribuer (dist/Cadre-win-x64.zip)
// L'appli autonome contient le moteur (sources), l'interface, le moteur de rendu et uv : au premier lancement, elle installe
// Python et ses dépendances dans les données de l'utilisateur (rien à installer à la main).
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const standalone = !!args.standalone;
const platform = args.platform || process.platform;
const arch = args.arch || process.arch;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const web = path.join(root, 'web');
const engine = path.join(root, 'engine');
const stage = path.join(here, 'stage');
const sh = (cmd, a, cwd = here) => execFileSync(cmd, a, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const UV_VERSION = '0.11.8';

console.log('construction de l’interface…');
sh('pnpm', ['build'], web);

fs.rmSync(stage, { recursive: true, force: true });
const extraResource = [];
if (standalone) {
  fs.rmSync(path.join(here, 'app-path.json'), { force: true });
  const res = path.join(stage, 'cadre');
  console.log('moteur…');
  fs.mkdirSync(path.join(res, 'engine'), { recursive: true });
  for (const f of ['pyproject.toml', 'uv.lock', '.python-version']) fs.copyFileSync(path.join(engine, f), path.join(res, 'engine', f));
  fs.cpSync(path.join(engine, 'cadre_engine'), path.join(res, 'engine', 'cadre_engine'), { recursive: true, filter: (s) => !/__pycache__|\.pyc$/.test(s) });
  console.log('interface…');
  fs.cpSync(path.join(web, 'dist'), path.join(res, 'web', 'dist'), { recursive: true });
  console.log('moteur de rendu…');
  const render = path.join(res, 'render');
  fs.mkdirSync(render, { recursive: true });
  fs.copyFileSync(path.join(web, 'scripts', 'render.mjs'), path.join(render, 'render.mjs'));
  sh('node', [path.join(web, 'scripts', 'bundle.mjs'), path.join(render, 'bundle')], web);
  const remotion = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8')).dependencies['@remotion/renderer'];
  fs.writeFileSync(path.join(render, 'package.json'), JSON.stringify({ name: 'cadre-render', private: true, type: 'module', dependencies: { '@remotion/renderer': remotion } }, null, 1));
  sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', `--os=${platform}`, `--cpu=${arch}`], render);
  console.log('uv…');
  const bin = path.join(stage, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = platform === 'win32' ? 'uv.exe' : 'uv';
  const local = (() => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['uv']).toString().split(/\r?\n/)[0].trim(); } catch { return ''; } })();
  if (local && platform === process.platform && arch === process.arch) fs.copyFileSync(local, path.join(bin, exe));
  else {
    const target = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[`${platform}-${arch}`];
    if (!target) throw new Error(`plateforme non prise en charge : ${platform}-${arch}`);
    const ext = platform === 'win32' ? 'zip' : 'tar.gz';
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.${ext}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-uv-'));
    const arc = path.join(tmp, `uv.${ext}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`téléchargement de uv impossible (${r.status})`);
    fs.writeFileSync(arc, Buffer.from(await r.arrayBuffer()));
    if (ext === 'zip') sh('unzip', ['-o', '-q', arc, '-d', tmp]); else sh('tar', ['-xzf', arc, '-C', tmp]);
    const found = execFileSync('find', [tmp, '-name', exe, '-type', 'f']).toString().trim().split('\n')[0];
    fs.copyFileSync(found, path.join(bin, exe));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (platform !== 'win32') fs.chmodSync(path.join(bin, exe), 0o755);
  extraResource.push(res, bin);
} else {
  if (platform !== 'darwin') throw new Error('le mode lié ne sert que sur ce Mac ; pour Windows : pnpm dist:win');
  fs.writeFileSync(path.join(here, 'app-path.json'), JSON.stringify({ root }, null, 1));
}

console.log('empaquetage Electron…');
const [out] = await packager({
  dir: here,
  name: 'Cadre',
  executableName: platform === 'win32' ? 'Cadre' : 'Cadre',
  platform,
  arch,
  out: path.join(here, 'out'),
  overwrite: true,
  appVersion: version,
  ...(platform === 'darwin' ? { icon: path.join(here, 'icon.icns') } : process.platform === 'win32' && fs.existsSync(path.join(here, 'icon.ico')) ? { icon: path.join(here, 'icon.ico') } : {}),
  appBundleId: 'app.cadre',
  appCategoryType: 'public.app-category.video',
  appCopyright: 'Cadre',
  protocols: [{ name: 'Cadre', schemes: ['cadre'] }],
  extraResource,
  prune: false,
  ignore: [/^\/node_modules($|\/)/, /^\/out($|\/)/, /^\/dist($|\/)/, /^\/stage($|\/)/, /^\/build\.mjs$/, /^\/pnpm-/, /^\/icon\.(icns|ico)$/, /^\/bin($|\/)/, /^\/windows($|\/)/, /^\/entitlements\.plist$/],
  extendInfo: {
    NSDocumentsFolderUsageDescription: 'Cadre lit les médias et bibliothèques rangés dans Documents.',
    NSDesktopFolderUsageDescription: 'Cadre lit les médias posés sur le Bureau.',
    NSDownloadsFolderUsageDescription: 'Cadre lit les médias téléchargés.',
    NSRemovableVolumesUsageDescription: 'Cadre lit les médias sur les disques externes.',
    NSNetworkVolumesUsageDescription: 'Cadre lit les médias sur les disques réseau.',
    NSMicrophoneUsageDescription: 'Cadre enregistre la voix pour reconnaître qui parle dans les vidéos.',
  },
});

const dist = path.join(here, 'dist');
const has = (cmd) => { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
if (platform === 'darwin') {
  const built = path.join(out, 'Cadre.app');
  // Signature : « Developer ID » (si CADRE_SIGN_ID est défini et le certificat installé) avec runtime renforcé, puis
  // notarisation Apple (si APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD) : plus aucun avertissement à l'ouverture.
  // Sinon signature ad hoc (l'appli s'ouvre par clic droit › Ouvrir la première fois).
  const id = process.env.CADRE_SIGN_ID;
  if (process.platform === 'darwin') {
    if (id) sh('codesign', ['--force', '--deep', '--options', 'runtime', '--timestamp', '--entitlements', path.join(here, 'entitlements.plist'), '--sign', id, built]);
    else sh('codesign', ['--force', '--deep', '--sign', '-', built]);
  }
  if (standalone) {
    fs.mkdirSync(dist, { recursive: true });
    const dmg = path.join(dist, `Cadre-mac-${arch === 'arm64' ? 'apple-silicon' : 'intel'}.dmg`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-dmg-'));
    sh('ditto', [built, path.join(tmp, 'Cadre.app')]);
    fs.symlinkSync('/Applications', path.join(tmp, 'Applications'));
    fs.rmSync(dmg, { force: true });
    sh('hdiutil', ['create', '-volname', 'Cadre', '-srcfolder', tmp, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (id) sh('codesign', ['--force', '--timestamp', '--sign', id, dmg]);
    if (id && process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD) {
      sh('xcrun', ['notarytool', 'submit', dmg, '--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_PASSWORD, '--wait']);
      sh('xcrun', ['stapler', 'staple', dmg]);
    }
    console.log(`prêt : ${dmg}`);
  } else {
    let dest = '/Applications/Cadre.app';
    try { fs.accessSync('/Applications', fs.constants.W_OK); } catch { dest = path.join(os.homedir(), 'Applications', 'Cadre.app'); }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    sh('ditto', [built, dest]);
    console.log(`installé : ${dest}`);
  }
} else {
  fs.mkdirSync(dist, { recursive: true });
  // Sur Windows avec Inno Setup (iscc) : vrai installateur (menu Démarrer, raccourci, désinstallation, lien cadre://),
  // signé si CADRE_WIN_CERT (fichier .pfx) et CADRE_WIN_CERT_PASSWORD sont définis. Sinon : archive zip.
  if (process.platform === 'win32' && has('iscc')) {
    const cert = process.env.CADRE_WIN_CERT;
    if (cert) sh('signtool', ['sign', '/f', cert, '/p', process.env.CADRE_WIN_CERT_PASSWORD || '', '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', path.join(out, 'Cadre.exe')]);
    sh('iscc', [`/DAppVersion=${version}`, `/DSourceDir=${out}`, `/DOutputDir=${dist}`, `/DArch=${arch}`, path.join(here, 'windows', 'cadre.iss')]);
    const setup = path.join(dist, `Cadre-Setup-${arch}.exe`);
    if (cert) sh('signtool', ['sign', '/f', cert, '/p', process.env.CADRE_WIN_CERT_PASSWORD || '', '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', setup]);
    console.log(`prêt : ${setup}`);
  } else {
    const zip = path.join(dist, `Cadre-win-${arch}.zip`);
    fs.rmSync(zip, { force: true });
    if (process.platform === 'win32') sh('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${out}\\*" -DestinationPath "${zip}"`]);
    else sh('zip', ['-q', '-r', '-X', zip, path.basename(out)], path.dirname(out));
    console.log(`prêt : ${zip} (installateur .exe : lancer « pnpm dist:win » sur Windows avec Inno Setup)`);
  }
}
fs.rmSync(path.join(here, 'out'), { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });
