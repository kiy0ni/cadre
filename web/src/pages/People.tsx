// People: who speaks in the videos (subtitle color, editing instructions, voiceprint for recognition).
import { useEffect, useRef, useState } from 'react';
import { api, followJob } from '../lib/api';
import { Icon } from '../lib/icons';
import { useStore } from '../lib/store';
import { BigText } from '../lib/ui';
import type { Speaker } from '../types';
import { tx } from '../lib/i18n';

export function PeoplePage() {
  const speakers = useStore((s) => s.speakers);
  const setSpeakers = useStore((s) => s.setSpeakers);
  const notify = useStore((s) => s.notify);
  const [selId, setSelId] = useState<string | undefined>(speakers[0]?.id);
  const [draft, setDraft] = useState<Speaker | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setDraft(structuredClone(speakers.find((s) => s.id === selId) || null)); setDirty(false); }, [selId, speakers]);

  const reload = async (keep?: string) => {
    const s = await api.speakers();
    setSpeakers(s);
    if (keep) setSelId(keep);
  };
  const edit = (p: Partial<Speaker>) => { if (draft) { setDraft({ ...draft, ...p }); setDirty(true); } };
  const save = async () => {
    if (!draft) return;
    await api.saveSpeaker(draft);
    await reload(draft.id);
    notify(tx('Enregistré'));
  };
  const add = async () => {
    const name = prompt(tx('Nom de la personne'));
    if (!name) return;
    const colors = ['#F5C542', '#6CC4FF', '#FF8A8A', '#9BE38D', '#D5A6FF', '#FFB86C'];
    const s = await api.createSpeaker({ name, color: colors[speakers.length % colors.length] });
    await reload(s.id);
  };
  const remove = async () => {
    if (!draft || !confirm(tx('Supprimer {0} et son empreinte vocale ?', draft.name))) return;
    await api.deleteSpeaker(draft.id);
    await reload();
    setSelId(undefined);
  };

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <h1 className="grow">{tx('Personnes')}</h1>
        <button className="btn primary" onClick={add}><Icon name="plus" size={14} /> {tx('Ajouter')}</button>
      </div>
      {speakers.length === 0 ? (
        <button className="empty" onClick={add} style={{ padding: 32 }}>
          <b>{tx('Ajoute les personnes qui parlent dans tes vidéos')}</b><br />
          <span className="small">{tx('Leurs sous-titres prennent leur couleur, et Cadre reconnaît qui parle grâce à leur voix.')}</span>
        </button>
      ) : (
        <div className="split2">
          <div className="list">
            {speakers.map((s) => (
              <div key={s.id} className={`list-item ${s.id === selId ? 'on' : ''}`} onClick={() => setSelId(s.id)}>
                <span className="dot" style={{ background: s.color, width: 10, height: 10 }} />
                <span className="grow ellipsis">{s.name}</span>
                {s.hasVoice ? <Icon name="mic" size={12} className="dim" /> : null}
              </div>
            ))}
          </div>
          {draft ? (
            <div className="col" style={{ gap: 14 }}>
              <div className="card col" style={{ gap: 12 }}>
                <div className="row">
                  <input type="color" value={draft.color} onChange={(e) => edit({ color: e.target.value })} title={tx('Couleur des sous-titres')} />
                  <input className="input grow" style={{ fontWeight: 600, height: 30, fontSize: 14 }} value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
                </div>
                <div style={{ background: '#2a2d33', borderRadius: 5, padding: '14px 16px', textAlign: 'center' }}>
                  <span style={{ fontFamily: 'Montserrat, sans-serif', fontWeight: 800, fontSize: 20, color: draft.color, WebkitTextStroke: '3px black', paintOrder: 'stroke fill' }}>
                    Exemple de sous-titre
                  </span>
                </div>
                <label className="field"><span>{tx('Autres noms (séparés par des virgules)')}</span>
                  <input className="input" value={draft.aliases.join(', ')} onChange={(e) => edit({ aliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="field"><span>{tx('Qui c\'est (contexte pour l\'IA)')}</span>
                  <BigText title={tx('Qui c\'est')} value={draft.description} onChange={(v) => edit({ description: v })} placeholder={tx('ex. invitée récurrente, parle vite, humour pince-sans-rire')} /></label>
                <label className="field"><span>{tx('Consignes de montage pour cette personne')}</span>
                  <BigText title={tx('Consignes de montage')} value={draft.preferences} onChange={(v) => edit({ preferences: v })} placeholder={tx('ex. zoom au centre quand elle rit ; garder ses réactions en entier')} /></label>
                <div className="row">
                  <button className="btn ghost danger" onClick={remove}>{tx('Supprimer')}</button>
                  <span className="spacer" />
                  <button className="btn primary" onClick={save} disabled={!dirty}>{tx('Enregistrer')}</button>
                </div>
              </div>
              <VoiceCard sp={draft} onDone={() => reload(draft.id)} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function VoiceCard({ sp, onDone }: { sp: Speaker; onDone: () => void }) {
  const notify = useStore((s) => s.notify);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = async () => {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); }
    catch { notify(tx('Micro inaccessible')); return; }
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => chunks.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearInterval(timer.current);
      setBusy(true);
      try {
        const { job } = await api.record(sp.id, new Blob(chunks.current, { type: r.mimeType }));
        const j = await followJob(job);
        if (j.status === 'error') notify(j.error || 'erreur');
        else notify(tx('Voix enregistrée'));
        onDone();
      } finally { setBusy(false); }
    };
    r.start();
    setRec(r);
    setSecs(0);
    timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
  };
  const stop = () => { rec?.stop(); setRec(null); };
  const reset = async () => {
    if (!confirm(tx('Effacer toutes les empreintes vocales de cette personne ?'))) return;
    await api.resetVoice(sp.id);
    onDone();
  };

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row"><h2 className="grow">{tx('Voix')}</h2>{sp.hasVoice ? <span className="badge ok">{tx('enregistrée ·')} {sp.samples.length} extrait{sp.samples.length > 1 ? 's' : ''}</span> : <span className="badge">{tx('aucune')}</span>}</div>
      <p className="small muted">
        {sp.hasVoice ? tx('Ajoute d\'autres extraits (voix calme, voix forte) pour une reconnaissance plus fiable.')
          : tx('Enregistre 20 secondes de parole, ou sélectionne un passage où elle parle seule dans l\'onglet Paroles d\'un projet.')}
      </p>
      <div className="row">
        {rec ? <button className="btn danger" onClick={stop}><Icon name="stop" size={12} /> {tx('Arrêter ·')} {secs} s</button>
          : <button className="btn" onClick={start} disabled={busy}><Icon name="mic" size={13} /> {tx('Enregistrer au micro')}</button>}
        {busy ? <span className="muted small row"><span className="spin" /> {tx('analyse')}</span> : null}
        <span className="spacer" />
        {sp.hasVoice ? <button className="btn sm ghost danger" onClick={reset}>{tx('Effacer la voix')}</button> : null}
      </div>
    </div>
  );
}
