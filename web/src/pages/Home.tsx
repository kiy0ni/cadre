// Accueil : projets récents (vignettes), création d'un projet en choisissant un style de montage et un format.
import { useEffect, useMemo, useState } from 'react';
import { api, type ProjectRow } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from '../lib/icons';
import { useStore } from '../lib/store';
import { Dropdown, Modal } from '../lib/ui';
import { getPrefs } from '../lib/prefs';
import type { Pack } from '../types';
import { tx } from '../lib/i18n';

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

export function NewProject({ onClose }: { onClose: () => void }) {
  const packs = useStore((s) => s.packs);
  const [name, setName] = useState('');
  const prefs = getPrefs();
  const [packId, setPackId] = useState((prefs.defaultPack && packs.find((p) => p.id === prefs.defaultPack)?.id) || packs.find((p) => p.id === 'youtube')?.id || packs[0]?.id || '');
  const pack = packs.find((p) => p.id === packId);
  const [ratio, setRatio] = useState<string | null>(prefs.defaultFormat || null);
  const [busy, setBusy] = useState(false);
  const fmtOf = (p?: Pack) => (p ? FORMATS.find((f) => f[2] === p.format.width && f[3] === p.format.height)?.[0] || '16:9' : '16:9');
  const cur = ratio || fmtOf(pack);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject({ name: name.trim() || tx('Sans titre'), packId, speakers: pack?.speakers || [] });
      const f = FORMATS.find((x) => x[0] === cur);
      if (f && (f[2] !== p.format.width || f[3] !== p.format.height)) await api.saveProject({ ...p, format: { ...p.format, width: f[2], height: f[3] } });
      window.location.hash = `#/p/${p.id}`;
    } catch (e) { useStore.getState().notify((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={tx('Nouveau projet')} onClose={onClose} wide
      foot={<><a className="btn ghost" href="#/styles" onClick={onClose}>{tx('Gérer les styles')}</a><span className="spacer" /><button className="btn" onClick={onClose}>{tx('Annuler')}</button><button className="btn primary" onClick={create} disabled={busy || !packId}>{tx('Créer')}</button></>}>
      <label className="field"><span>{tx('Nom')}</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tx('Sans titre')} onKeyDown={(e) => e.key === 'Enter' && create()} /></label>
      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">{tx('Style de montage')}</span>
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
      </div>
      <div className="row">
        <span className="small muted" style={{ width: 60 }}>{tx('Format')}</span>
        <div className="seg">
          {FORMATS.map(([k, l]) => <button key={k} className={cur === k ? 'on' : ''} onClick={() => setRatio(k)} title={l}>{k}</button>)}
        </div>
        <span className="small dim">{FORMATS.find((f) => f[0] === cur)?.slice(2).join(' × ')}</span>
      </div>
    </Modal>
  );
}
