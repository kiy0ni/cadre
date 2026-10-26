// Editing styles: what the AI should do (written rules) and the default settings (subtitles, pacing, framing, sound).
// A style is created by describing it (or from a reference video): the AI writes the rules and sets the values.
import { useEffect, useState } from 'react';
import { api, followJob } from '../lib/api';
import { Icon } from '../lib/icons';
import { useStore } from '../lib/store';
import { BigText, Modal, Seg } from '../lib/ui';
import type { Pack, PackStyle } from '../types';
import { mergeStyle } from '../remotion/resolve';
import { FONTS as FONT_FAMILIES, fontFamily } from '../remotion/fonts';
import { tx } from '../lib/i18n';

export function StylesPage() {
  const packs = useStore((s) => s.packs);
  const setPacks = useStore((s) => s.setPacks);
  const notify = useStore((s) => s.notify);
  const [selId, setSelId] = useState(() => (window.location.hash.split('/')[2] || packs[0]?.id));
  const [draft, setDraft] = useState<Pack | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'general' | 'rules' | 'style'>('general');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const p = packs.find((x) => x.id === selId);
    setDraft(p ? { ...structuredClone(p), style: mergeStyle(p.style) } : null);
    setDirty(false);
  }, [selId, packs]);

  const save = async () => {
    if (!draft) return;
    const saved = await api.savePack(draft);
    setPacks(packs.map((p) => (p.id === saved.id ? saved : p)));
    setDirty(false);
    notify(tx('Style enregistré'));
  };
  const duplicate = async () => {
    if (!draft) return;
    const p = await api.createPack({ from: draft.id, name: `${draft.name} (copie)` });
    setPacks([...packs, p]);
    setSelId(p.id);
  };
  const remove = async () => {
    if (!draft || !confirm(tx('Supprimer le style « {0} » ? Les projets qui l\'utilisent gardent leur montage.', draft.name))) return;
    await api.deletePack(draft.id);
    const rest = packs.filter((p) => p.id !== draft.id);
    setPacks(rest);
    setSelId(rest[0]?.id);
  };
  const set = <K extends keyof Pack>(k: K, v: Pack[K]) => { if (draft) { setDraft({ ...draft, [k]: v }); setDirty(true); } };
  const st = <K extends keyof PackStyle>(k: K, v: Partial<PackStyle[K]> | PackStyle[K]) => {
    if (!draft) return;
    setDraft({ ...draft, style: { ...draft.style, [k]: typeof v === 'object' && !Array.isArray(v) ? { ...(draft.style[k] as object), ...v } : v } });
    setDirty(true);
  };

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <h1 className="grow">{tx('Styles de montage')}</h1>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> {tx('Nouveau style')}</button>
      </div>
      <div className="split2">
        <div className="list">
          {packs.map((p) => (
            <div key={p.id} className={`list-item ${p.id === selId ? 'on' : ''}`} onClick={() => setSelId(p.id)}>
              <span className="ratio" style={{ aspectRatio: `${p.format.width} / ${p.format.height}`, height: 16, borderWidth: 1.5 }} />
              <span className="grow ellipsis">{p.name}</span>
              {(p as Pack & { builtin?: boolean }).builtin ? <span className="dim tiny">{tx('inclus')}</span> : null}
            </div>
          ))}
        </div>
        {draft ? (
          <div className="card col" style={{ gap: 14 }}>
            <div className="row">
              <input className="input grow" style={{ fontWeight: 600, fontSize: 14, height: 30 }} value={draft.name} onChange={(e) => set('name', e.target.value)} />
              <Seg value={tab} onChange={setTab} options={[['general', tx('Général')], ['rules', tx('Règles IA')], ['style', tx('Réglages')]]} />
            </div>

            {tab === 'general' ? (
              <>
                <label className="field"><span>{tx('Description (affichée à la création d\'un projet)')}</span>
                  <input className="input" value={draft.description} onChange={(e) => set('description', e.target.value)} /></label>
                <div className="form-grid">
                  <label className="field"><span>{tx('Format')}</span>
                    <select className="input" value={`${draft.format.width}x${draft.format.height}`} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); set('format', { ...draft.format, width: w, height: h }); }}>
                      <option value="1920x1080">{tx('16:9 · 1920×1080')}</option><option value="3840x2160">{tx('16:9 · 3840×2160')}</option>
                      <option value="1080x1920">{tx('9:16 · 1080×1920')}</option><option value="1080x1080">{tx('1:1 · 1080×1080')}</option><option value="1080x1350">{tx('4:5 · 1080×1350')}</option>
                    </select></label>
                  <label className="field"><span>{tx('Images / s')}</span>
                    <select className="input" value={draft.format.fps} onChange={(e) => set('format', { ...draft.format, fps: Number(e.target.value) })}>
                      {[24, 25, 30, 50, 60].map((f) => <option key={f}>{f}</option>)}
                    </select></label>
                  <label className="field"><span>{tx('Langue parlée')}</span>
                    <select className="input" value={draft.whisper.language} onChange={(e) => set('whisper', { ...draft.whisper, language: e.target.value })}>
                      {[['fr', 'Français'], ['en', tx('Anglais')], ['es', tx('Espagnol')], ['de', tx('Allemand')], ['it', tx('Italien')], ['pt', tx('Portugais')], ['ja', tx('Japonais')], ['', tx('Détection auto')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select></label>
                </div>
                <label className="field"><span>{tx('Vocabulaire (noms propres, termes techniques : aide la transcription)')}</span>
                  <input className="input" value={draft.whisper.prompt} onChange={(e) => set('whisper', { ...draft.whisper, prompt: e.target.value })} /></label>
                <label className="field"><span>{tx('Structure type')}</span>
                  <input className="input" value={draft.structure} onChange={(e) => set('structure', e.target.value)} placeholder={tx('Accroche · intro · parties · conclusion')} /></label>
              </>
            ) : null}

            {tab === 'rules' ? (
              <>
                <span className="small muted">{tx('Les consignes de montage que l\'IA suit pour ce style. Quand tu lui dis « retiens… », elle les complète.')}</span>
                <BigText mono title={tx('Règles IA — {0}', draft.name)} minHeight={420} value={draft.rules} onChange={(v) => set('rules', v)} />
              </>
            ) : null}

            {tab === 'style' ? <StyleFields s={draft.style} st={st} /> : null}

            <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <button className="btn" onClick={duplicate}><Icon name="copy" size={13} /> {tx('Dupliquer')}</button>
              <button className="btn ghost danger" onClick={remove}>{tx('Supprimer')}</button>
              <span className="spacer" />
              {dirty ? <span className="small dim">{tx('Modifications non enregistrées')}</span> : null}
              <button className="btn primary" onClick={save} disabled={!dirty}>{tx('Enregistrer')}</button>
            </div>
          </div>
        ) : <p className="muted">{tx('Aucun style.')}</p>}
      </div>
      {creating ? <NewStyle onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelId(id); }} /> : null}
    </div>
  );
}

const FONTS = Object.keys(FONT_FAMILIES);

function StyleFields({ s, st }: { s: PackStyle; st: <K extends keyof PackStyle>(k: K, v: Partial<PackStyle[K]> | PackStyle[K]) => void }) {
  const c = s.captions;
  return (
    <div className="col" style={{ gap: 12 }}>
      <CaptionPreview style={s} />
      <div className="section-title">{tx('Sous-titres')}</div>
      <div className="form-grid">
        <label className="field"><span>{tx('Police')}</span><select className="input" value={c.font} onChange={(e) => st('captions', { font: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></label>
        <Num label={tx('Taille')} v={c.size} on={(v) => st('captions', { size: v })} />
        <Num label={tx('Graisse')} v={c.weight} step={100} on={(v) => st('captions', { weight: v })} />
        <label className="field"><span>{tx('Couleur')}</span><input type="color" value={c.color} onChange={(e) => st('captions', { color: e.target.value })} /></label>
        <Num label={tx('Contour')} v={c.outline} step={0.5} on={(v) => st('captions', { outline: v })} />
        <Num label={tx('Marge bas')} v={c.bottom} on={(v) => st('captions', { bottom: v })} />
        <Num label={tx('Caractères max')} v={c.maxChars} on={(v) => st('captions', { maxChars: v })} />
        <label className="field"><span>{tx('Découpage')}</span><select className="input" value={c.mode} onChange={(e) => st('captions', { mode: e.target.value as 'groups' | 'words' })}><option value="groups">{tx('Groupes de mots')}</option><option value="words">{tx('Mot à mot')}</option></select></label>
      </div>
      <div className="row wrap" style={{ gap: 14 }}>
        <Check label={tx('Majuscules')} v={c.uppercase} on={(v) => st('captions', { uppercase: v })} />
        <Check label={tx('Animation pop')} v={c.pop} on={(v) => st('captions', { pop: v })} />
        <Check label={tx('Fond')} v={!!c.box} on={(v) => st('captions', { box: v })} />
      </div>
      <div className="section-title">{tx('Rythme')}</div>
      <div className="form-grid">
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={s.jumpCuts.enabled} onChange={(e) => st('jumpCuts', { enabled: e.target.checked })} /> {tx('Couper les silences')}</label>
        <Num label={tx('Silence max (s)')} v={s.jumpCuts.gap} step={0.05} on={(v) => st('jumpCuts', { gap: v })} />
        <Num label={tx('Marge avant (s)')} v={s.jumpCuts.pre} step={0.02} on={(v) => st('jumpCuts', { pre: v })} />
        <Num label={tx('Marge après (s)')} v={s.jumpCuts.post} step={0.02} on={(v) => st('jumpCuts', { post: v })} />
        <Num label={tx('Vitesse de base')} v={s.baseSpeed} step={0.01} on={(v) => st('baseSpeed', v)} />
      </div>
      <div className="section-title">{tx('Cadrage')}</div>
      <div className="form-grid">
        <Num label={tx('Zoom visage')} v={s.zoom.face} step={0.05} on={(v) => st('zoom', { face: v })} />
        <Num label={tx('Zoom centre')} v={s.zoom.center} step={0.05} on={(v) => st('zoom', { center: v })} />
        <Num label={tx('Visage x (0–1)')} v={s.face[0]} step={0.01} on={(v) => st('face', [v, s.face[1]])} />
        <Num label={tx('Visage y (0–1)')} v={s.face[1]} step={0.01} on={(v) => st('face', [s.face[0], v])} />
      </div>
      <div className="section-title">{tx('Son')}</div>
      <div className="form-grid">
        <Num label={tx('Musique (dB)')} v={s.music.db} on={(v) => st('music', { db: v })} />
        <Num label={tx('Baisse sous la voix (dB)')} v={s.music.duckDb} on={(v) => st('music', { duckDb: v })} />
        <Num label={tx('Bruitages (dB)')} v={s.sfxDb} on={(v) => st('sfxDb', v)} />
        <Num label={tx('Niveau final (LUFS)')} v={s.loudness} on={(v) => st('loudness', v)} />
      </div>
      <div className="row wrap" style={{ gap: 14 }}>
        <Check label={tx('Censurer les gros mots (texte)')} v={s.censor.captions} on={(v) => st('censor', { captions: v })} />
        <Check label={tx('Bip sur les gros mots')} v={s.censor.audio} on={(v) => st('censor', { audio: v })} />
        <Check label={tx('Séparer voix et fond sonore')} v={s.stems.enabled} on={(v) => st('stems', { enabled: v })} />
      </div>
    </div>
  );
}

export function Num({ label, v, on, step = 1 }: { label: string; v: number; on: (v: number) => void; step?: number }) {
  return <label className="field"><span className="ellipsis">{label}</span><input className="input" type="number" step={step} value={v} onChange={(e) => on(Number(e.target.value))} /></label>;
}

export function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} /> {label}</label>;
}

function CaptionPreview({ style }: { style: PackStyle }) {
  const c = style.captions;
  const k = 0.3;
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', maxWidth: 480, borderRadius: 6, overflow: 'hidden', background: '#2a2d33', border: '1px solid var(--border)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #3b4250 0%, #23262c 100%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: c.bottom * k, textAlign: 'center' }}>
        <span style={{ fontFamily: fontFamily(c.font), fontWeight: c.weight, fontSize: c.size * k, color: c.color,
          WebkitTextStroke: c.outline ? `${c.outline * 2 * k}px black` : undefined, paintOrder: 'stroke fill', textTransform: c.uppercase ? 'uppercase' : undefined,
          background: c.box ? 'rgba(0,0,0,.62)' : undefined, padding: c.box ? '2px 8px' : undefined, borderRadius: c.box ? 4 : undefined }}>
          Voici à quoi ressemblent les sous-titres
        </span>
      </div>
    </div>
  );
}

function NewStyle({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const packs = useStore((s) => s.packs);
  const setPacks = useStore((s) => s.setPacks);
  const ai = useStore((s) => s.ai);
  const notify = useStore((s) => s.notify);
  const [mode, setMode] = useState<'ai' | 'copy'>(ai?.provider ? 'ai' : 'copy');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [ref, setRef] = useState('');
  const [from, setFrom] = useState(packs[0]?.id || '');
  const [busy, setBusy] = useState<string | null>(null);

  const go = async () => {
    try {
      if (mode === 'copy') {
        const p = await api.createPack({ from, name: name.trim() || tx('Nouveau style') });
        setPacks([...packs, p]);
        onCreated(p.id);
        return;
      }
      if (!desc.trim()) return;
      setBusy(tx('Analyse…'));
      const { job } = await api.generatePack({ description: desc.trim(), reference: ref.trim() || undefined, name: name.trim() || undefined });
      const j = await followJob(job, undefined, (x) => setBusy(x.message || tx('Création…')));
      if (j.status !== 'done') throw new Error(j.error || tx('échec'));
      const all = await api.packs();
      setPacks(all);
      onCreated((j.result as { id: string }).id);
    } catch (e) { notify((e as Error).message); setBusy(null); }
  };

  return (
    <Modal title={tx('Nouveau style')} onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>{tx('Annuler')}</button><button className="btn primary" onClick={go} disabled={!!busy || (mode === 'ai' && !desc.trim())}>{busy ? <><span className="spin" /> {busy}</> : tx('Créer')}</button></>}>
      <Seg value={mode} onChange={setMode} options={[['ai', tx('Décrire le style')], ['copy', tx('Partir d\'un style')]]} />
      <label className="field"><span>{tx('Nom')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx('ex. Vlog voyage')} /></label>
      {mode === 'ai' ? (
        <>
          <label className="field"><span>{tx('Comment doit être le montage ?')}</span>
            <textarea className="input" style={{ minHeight: 110 }} value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus
              placeholder={tx('ex. Vlog voyage vertical, rythme rapide, sous-titres mot à mot jaunes, musique lo-fi, transitions whip entre les lieux, pas de gros mots.')} /></label>
          <label className="field"><span>{tx('Vidéo de référence (facultatif : lien YouTube ou chemin d\'un fichier)')}</span>
            <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://…" /></label>
          {!ai?.provider ? <span className="small" style={{ color: 'var(--warn)' }}>{tx('Aucune IA configurée : voir Réglages › Intelligence artificielle.')}</span> : null}
        </>
      ) : (
        <label className="field"><span>{tx('Copier')}</span>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>{packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      )}
    </Modal>
  );
}
