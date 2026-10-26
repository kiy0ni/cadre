// Home: recent projects (thumbnails), project creation: media + what the AI should edit (optional), format, style.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ProjectRow } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from '../lib/icons';
import { useStore } from '../lib/store';
import { Dropdown, Modal } from '../lib/ui';
import { getPrefs } from '../lib/prefs';
import type { Pack } from '../types';
import { getLang, tx } from '../lib/i18n';
import { desktop } from '../lib/desktop';

export function HomePage() {
  const packs = useStore((s) => s.packs);
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => { api.projects().then(setRows).catch(() => setRows([])); }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setCreating(true); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const del = async (r: ProjectRow) => {
    if (getPrefs().confirmDelete && !confirm(tx('Supprimer « {0} » ? Les fichiers d\'origine restent sur le disque.', r.name))) return;
    await api.deleteProject(r.id);
    setRows((rows || []).filter((x) => x.id !== r.id));
  };
  const shown = useMemo(() => (rows || []).filter((r) => !q || `${r.name} ${r.title}`.toLowerCase().includes(q.toLowerCase())), [rows, q]);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="grow">{tx('Projets')}</h1>
        {(rows?.length || 0) > 6 ? (
          <div className="row" style={{ width: 220 }}><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('Rechercher')} /></div>
        ) : null}
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> {tx('Nouveau projet')}</button>
      </div>

      {rows === null ? null : (
        <div className="proj-grid">
          <button className="proj" onClick={() => setCreating(true)} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}>
            <div className="proj-thumb proj-new"><Icon name="plus" size={22} /><span>{tx('Nouveau projet')}</span></div>
            <div className="proj-meta"><span className="dim small">⌘N</span></div>
          </button>
          {shown.map((r) => (
            <a key={r.id} className="proj" href={`#/p/${r.id}`}>
              <div className="proj-thumb" style={r.thumb ? { backgroundImage: `url(${r.thumb})` } : undefined}>
                {!r.thumb ? <Icon name="film" size={24} /> : null}
                <div className="proj-actions" onClick={(e) => e.preventDefault()}>
                  <Dropdown align="right" width={160} button={(_, t) => <button className="btn icon sm" onClick={t} aria-label={tx('Options')}><Icon name="more" size={14} /></button>}>
                    {(close) => (
                      <>
                        <button onClick={async () => { close(); const n = prompt(tx('Nouveau nom'), r.name); if (!n) return; const pr = await api.project(r.id); await api.saveProject({ ...pr.project, name: n }); setRows(await api.projects()); }}>{tx('Renommer')}</button>
                        <button onClick={() => { close(); del(r); }}>{tx('Supprimer')}</button>
                      </>
                    )}
                  </Dropdown>
                </div>
              </div>
              <div className="proj-meta">
                <b className="ellipsis">{r.name}</b>
                <span className="small muted ellipsis">{packs.find((p) => p.id === r.packId)?.name || tx('Sans style')} · {ago(r.updatedAt)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      {creating ? <NewProject onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

const FORMATS: [string, string, number, number][] = [['16:9', tx('Horizontal'), 1920, 1080], ['9:16', tx('Vertical'), 1080, 1920], ['1:1', tx('Carré'), 1080, 1080], ['4:5', tx('Portrait'), 1080, 1350]];

type Picked = { name: string; size?: number; path?: string; file?: File };
const DUR: [string, string][] = [['', tx('Libre')], ['30', '30 s'], ['60', '1 min'], ['180', '3 min'], ['600', '10 min']];
/** recipes: a ready-made request + the matching editing style */
const RECIPES: [string, string, string?][] = [
  [tx('Best-of gaming'), tx('Monte un best-of gaming : repère les meilleurs moments (réactions, actions, fails, retournements), garde le contexte juste avant et la réaction jusqu’au bout, coupe les menus et temps morts, laisse le son du jeu audible, sous-titres sur les paroles importantes.'), 'gaming'],
  [tx('Clip gaming vertical'), tx('Fais un clip vertical de 30 à 60 s sur le moment le plus fort de la partie : un peu de contexte, la réaction en entier, recadré sur l’action, sous-titres gros.'), 'gaming-clip'],
  [tx('Vlog dynamique'), tx('Monte un vlog dynamique : garde les meilleurs passages, coupe les silences et les hésitations, ajoute une accroche forte au début, des sous-titres lisibles et une musique discrète.'), 'youtube'],
  [tx('Short des meilleurs moments'), tx('Fais un short vertical avec les moments les plus forts : accroche dans les 2 premières secondes, rythme serré, sous-titres, zooms sur les réactions.'), 'short'],
  [tx('Interview / podcast'), tx('Monte cette interview proprement : retire les silences, les « euh » et les faux départs sans couper les mots, garde le contexte des réponses, sous-titres sobres.'), 'podcast'],
  [tx('Tutoriel clair'), tx('Monte un tutoriel clair : un chapitre par étape avec un titre, coupe les temps morts, zoome sur les détails importants, sous-titres.'), 'tuto'],
  [tx('Montage musical'), tx('Fais un montage rythmé sur la musique : coupes sur les temps forts, transitions légères, pas de sous-titres.')],
];

export function NewProject({ onClose }: { onClose: () => void }) {
  const packs = useStore((s) => s.packs);
  const ai = useStore((s) => s.ai);
  const [name, setName] = useState('');
  const prefs = getPrefs();
  const [packId, setPackId] = useState((prefs.defaultPack && packs.find((p) => p.id === prefs.defaultPack)?.id) || packs.find((p) => p.id === 'youtube')?.id || packs[0]?.id || '');
  const pack = packs.find((p) => p.id === packId);
  const [ratio, setRatio] = useState<string | null>(prefs.defaultFormat || null);
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [link, setLink] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dur, setDur] = useState('');
  const [subs, setSubs] = useState(true);
  const [music, setMusic] = useState(true);
  const [over, setOver] = useState(false);
  const [showStyles, setShowStyles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fmtOf = (p?: Pack) => (p ? FORMATS.find((f) => f[2] === p.format.width && f[3] === p.format.height)?.[0] || '16:9' : '16:9');
  const cur = ratio || fmtOf(pack);
  const hasMedia = files.length > 0 || /^https?:\/\//.test(link.trim());
  const withAi = hasMedia && !!prompt.trim();

  const addFiles = (list: FileList | File[]) => {
    const d = desktop();
    const add: Picked[] = Array.from(list).map((f) => ({ name: f.name, size: f.size, path: d ? d.pathForFile(f) || undefined : undefined, file: d ? undefined : f }));
    setFiles((x) => [...x, ...add]);
  };
  const pick = async () => {
    const d = desktop();
    if (!d) { fileInput.current?.click(); return; }
    const paths = await d.pickFiles();
    setFiles((x) => [...x, ...paths.map((p) => ({ name: p.split(/[\\/]/).pop() || p, path: p }))]);
  };

  const create = async () => {
    setBusy(tx('Création du projet…'));
    try {
      const p = await api.createProject({ name: name.trim() || files[0]?.name.replace(/\.[^.]+$/, '') || tx('Sans titre'), packId, speakers: pack?.speakers || [] });
      const f = FORMATS.find((x) => x[0] === cur);
      if (f && (f[2] !== p.format.width || f[3] !== p.format.height)) await api.saveProject({ ...p, format: { ...p.format, width: f[2], height: f[3] } });
      const paths = files.filter((x) => x.path).map((x) => x.path!);
      if (paths.length) { setBusy(tx('Import des médias…')); await api.addSource(p.id, { paths }); }
      for (const [k, x] of files.filter((y) => y.file).entries()) { setBusy(tx('Envoi {0}/{1}…', k + 1, files.length)); await api.upload(p.id, x.file!); }
      if (/^https?:\/\//.test(link.trim())) await api.addSource(p.id, { url: link.trim() });
      if (withAi) {
        const brief = [
          `${tx('Format')} : ${cur}`,
          dur ? tx('Durée visée : environ {0} s', dur) : null,
          subs ? tx('Sous-titres : oui') : tx('Sous-titres : non'),
          music ? tx('Musique de fond : oui, discrète') : tx('Musique de fond : non'),
        ].filter(Boolean).join(' · ');
        await api.ai(p.id, {
          prompt: `${prompt.trim()}\n\n(${tx('Nouveau projet : fais le premier montage complet à partir des médias importés.')} ${brief})`,
          mode: 'auto', wait: true, context: { lang: getLang() },
        });
      }
      window.location.hash = `#/p/${p.id}`;
    } catch (e) { useStore.getState().notify((e as Error).message); setBusy(null); }
  };

  return (
    <Modal title={tx('Nouveau projet')} onClose={onClose} wide
      foot={<>
        <a className="btn ghost" href="#/styles" onClick={onClose}>{tx('Gérer les styles')}</a>
        <span className="spacer" />
        {busy ? <span className="small muted"><span className="spin" /> {busy}</span> : null}
        <button className="btn" onClick={onClose}>{tx('Annuler')}</button>
        <button className="btn primary" onClick={create} disabled={!!busy || !packId || (!!prompt.trim() && !ai?.provider)}>
          {withAi ? <><Icon name="wand" size={13} /> {tx('Créer et monter avec l’IA')}</> : hasMedia ? tx('Créer et importer') : tx('Créer un projet vide')}
        </button>
      </>}>
      <label className="field"><span>{tx('Nom')}</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={files[0]?.name.replace(/\.[^.]+$/, '') || tx('Sans titre')} /></label>

      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">{tx('Médias')}</span>
        <div className={`np-drop ${over ? 'over' : ''}`} onClick={pick}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
          {files.length ? (
            <div className="np-files" onClick={(e) => e.stopPropagation()}>
              {files.map((x, i) => (
                <span key={i} className="np-file"><Icon name="film" size={12} /> <span className="ellipsis">{x.name}</span>
                  <button className="btn icon sm ghost" onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label={tx('Retirer')}><Icon name="x" size={11} /></button></span>
              ))}
              <button className="btn sm ghost" onClick={pick}><Icon name="plus" size={12} /> {tx('Ajouter')}</button>
            </div>
          ) : <span><Icon name="import" size={16} /> {tx('Glisse tes vidéos, sons ou images ici, ou clique pour choisir')}</span>}
        </div>
        <input ref={fileInput} type="file" multiple accept="video/*,audio/*,image/*" style={{ display: 'none' }} onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder={tx('ou un lien (YouTube, Twitch, fichier en ligne…)')} />
      </div>

      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">{tx('Ce que l’IA doit monter')} <span className="dim">· {tx('facultatif : tu peux aussi monter toi-même')}</span></span>
        <textarea className="input np-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
          placeholder={tx('Ex. : « Fais un short de 45 s avec les meilleurs moments, accroche forte, sous-titres, et une musique calme. Reproduis le style de cette vidéo : https://… »')} />
        <div className="row wrap" style={{ gap: 6 }}>
          {RECIPES.map(([l, t, pk]) => (
            <button key={l} className="chip" onClick={() => { setPrompt(t); if (pk && packs.some((x) => x.id === pk)) { setPackId(pk); setRatio(null); } }}>{l}</button>
          ))}
        </div>
        {prompt.trim() && !ai?.provider ? <span className="small" style={{ color: 'var(--warn)' }}>{tx('L’IA n’est pas configurée : Réglages › Intelligence artificielle.')}</span> : null}
        {prompt.trim() ? (
          <div className="row wrap" style={{ gap: 14 }}>
            <span className="row" style={{ gap: 6 }}><span className="small muted">{tx('Durée')}</span>
              <div className="seg">{DUR.map(([k, l]) => <button key={k} className={dur === k ? 'on' : ''} onClick={() => setDur(k)}>{l}</button>)}</div></span>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" className="switch" checked={subs} onChange={(e) => setSubs(e.target.checked)} /> {tx('Sous-titres')}</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" className="switch" checked={music} onChange={(e) => setMusic(e.target.checked)} /> {tx('Musique')}</label>
          </div>
        ) : null}
      </div>

      <div className="row">
        <span className="small muted" style={{ width: 60 }}>{tx('Format')}</span>
        <div className="seg">
          {FORMATS.map(([k, l]) => <button key={k} className={cur === k ? 'on' : ''} onClick={() => setRatio(k)} title={l}>{k}</button>)}
        </div>
        <span className="small dim">{FORMATS.find((f) => f[0] === cur)?.slice(2).join(' × ')}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setShowStyles(!showStyles)}>{tx('Style')} : <b>{pack?.name || '—'}</b> <Icon name="chev" size={11} style={showStyles ? { transform: 'rotate(180deg)' } : undefined} /></button>
      </div>
      {showStyles ? (
        <div className="style-grid">
          {packs.map((p) => (
            <button key={p.id} className={`style-card ${packId === p.id ? 'on' : ''}`} onClick={() => { setPackId(p.id); setRatio(null); }}>
              <span className="ratio" style={{ aspectRatio: `${p.format.width} / ${p.format.height}` }} />
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <b className="ellipsis">{p.name}</b>
                <span className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
