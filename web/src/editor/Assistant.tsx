// Editing assistant (in the style of Claude Code in VS Code): conversations, Auto / Ask / Plan modes, expandable steps,
// permissions, rewind points, "/" commands and "@" mentions. It sees the project, the selection and the playhead.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ago, fmt, nf } from '../lib/format';
import { Icon } from '../lib/icons';
import { Markdown } from '../lib/md';
import { getFrame, useStore, type LiveTurn } from '../lib/store';
import type { AiMode, Block, ConvMsg, Conversation, PrepStage, Todo } from '../types';
import { useComp } from './comp';
import { tx } from '../lib/i18n';

const MODES: { id: AiMode; label: string; help: string }[] = [
  { id: 'auto', label: 'Auto', help: tx('Modifie le montage directement (⌘Z annule tout)') },
  { id: 'ask', label: tx('Demander'), help: tx('Demande ton accord avant chaque modification') },
  { id: 'plan', label: tx('Plan|mode'), help: tx('Propose un plan sans rien modifier') },
];

export const COMMANDS: { cmd: string; label: string; prompt: string; mode?: AiMode }[] = [
  { cmd: '/monter', label: tx('Monter la vidéo'), prompt: tx('Monte la vidéo complète à partir des médias du projet, en suivant le style de montage : structure, plans, sous-titres vérifiés, rythme, habillage sonore, titres et transitions.') },
  { cmd: '/plan', label: tx('Proposer un plan de montage'), prompt: tx('Propose un plan de montage complet pour cette vidéo, sans rien modifier.'), mode: 'plan' },
  { cmd: '/rythme', label: tx('Resserrer le rythme'), prompt: tx('Resserre le rythme : coupe les temps morts et les répétitions, garde le sens. Dis-moi ce que tu as retiré.') },
  { cmd: '/raccourcir', label: tx('Raccourcir'), prompt: tx('Raccourcis la vidéo d’environ 20 % en gardant les meilleurs passages et une histoire claire.') },
  { cmd: '/soustitres', label: tx('Vérifier les sous-titres'), prompt: tx('Relis tous les sous-titres : mots faux (compare avec la transcription), découpage, qui parle. Corrige ce qui doit l’être.') },
  { cmd: '/musique', label: tx('Choisir la musique'), prompt: tx('Choisis la musique de fond selon l’ambiance de chaque partie, au bon volume sous la voix.') },
  { cmd: '/bruitages', label: tx('Ajouter des bruitages'), prompt: tx('Ajoute des bruitages synchronisés là où ils renforcent l’action, sans en mettre trop.') },
  { cmd: '/couleur', label: tx('Étalonner'), prompt: tx('Étalonne la vidéo avec un look cohérent, adapté à l’ambiance, sans excès. Regarde les images avant.') },
  { cmd: '/titres', label: tx('Ajouter des titres'), prompt: tx('Ajoute des titres à l’écran utiles (parties, noms, infos clés) dans le style du projet.') },
  { cmd: '/transitions', label: tx('Ajouter des transitions'), prompt: tx('Ajoute des transitions entre les parties (pas entre chaque plan), adaptées au rythme.') },
  { cmd: '/verifier', label: tx('Vérifier le montage'), prompt: tx('Regarde le montage du début à la fin (images clés) et liste ce qui cloche : coupes abruptes, sous-titres mal placés, cadrages, niveaux sonores. Corrige ce qui est sûr.') },
  { cmd: '/resume', label: tx('Résumer le montage'), prompt: tx('Résume le montage actuel : structure, durée, ce qui manque. Ne modifie rien.'), mode: 'plan' },
  { cmd: '/titre', label: tx('Proposer des titres de vidéo'), prompt: tx('Propose 5 titres et une description pour cette vidéo, basés sur son contenu réel. Ne modifie pas le montage.'), mode: 'plan' },
];


export function Assistant({ onClose }: { onClose?: () => void }) {
  const { props } = useComp();
  const project = props.project;
  const convs: Conversation[] = project.conversations || [];
  const aiJob = useStore((s) => s.aiJob);
  const aiConv = useStore((s) => s.aiConv);
  const aiMode = useStore((s) => s.aiMode);
  const live = useStore((s) => s.live);
  const setAi = useStore((s) => s.setAi);
  const askAi = useStore((s) => s.askAi);
  const ai = useStore((s) => s.ai);
  const notify = useStore((s) => s.notify);
  const sel = useStore((s) => s.sel);
  const frame = useStore((s) => s.frame);
  const [text, setText] = useState('');
  const [showConvs, setShowConvs] = useState(false);
  const [noCtx, setNoCtx] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conv = convs.find((c) => c.id === aiConv) || null;
  const msgs = conv?.messages || [];

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [msgs.length, live?.blocks, live?.user]);
  useEffect(() => { setNoCtx(false); }, [sel.itemId, sel.clipId]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { const j = useStore.getState().aiJob; if (e.key === 'Escape' && j) api.cancelJob(j); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const send = async (t = text, mode?: AiMode) => {
    let v = t.trim();
    if (!v || aiJob) return;
    if (v === '/nouveau' || v === '/clear') { setAi({ aiConv: null }); setText(''); return; }
    const c = COMMANDS.find((x) => v === x.cmd || v.startsWith(x.cmd + ' '));
    if (c) { v = c.prompt + (v.length > c.cmd.length ? `\n${v.slice(c.cmd.length).trim()}` : ''); mode = mode || c.mode; }
    setText('');
    try { await askAi(v, { mode }); } catch (e) { notify(tx('Assistant : {0}', (e as Error).message)); }
  };
  const cycleMode = () => setAi({ aiMode: MODES[(MODES.findIndex((m) => m.id === aiMode) + 1) % MODES.length].id });
  const selItem = project.timeline.find((x) => x.id === sel.itemId);
  const selLabel = selItem ? `${selItem.type === 'clip' ? tx('Plan') : selItem.type === 'card' ? tx('Carton') : tx('Élément')} ${project.timeline.indexOf(selItem) + 1}${selItem.type === 'clip' && selItem.label ? ` « ${selItem.label} »` : ''}` : sel.clipId ? tx('Clip sélectionné') : null;
  const modeInfo = MODES.find((m) => m.id === aiMode)!;

  if (!ai?.provider) {
    return (
      <div className="cc">
        <Header conv={null} onConvs={() => undefined} onNew={() => undefined} onClose={onClose} disabled />
        <div className="pad" style={{ gap: 10 }}>
          <b>{tx('Aucune IA connectée')}</b>
          <p className="small muted">{tx('Connecte Claude (abonnement Claude Code ou clé d\'API) pour que l\'assistant monte à ta place.')}</p>
          <a className="btn" href="#/reglages/ia" style={{ width: 'fit-content' }}>{tx('Configurer')}</a>
        </div>
      </div>
    );
  }

  return (
    <div className="cc">
      <Header conv={conv} onConvs={() => setShowConvs(!showConvs)} onNew={() => { setAi({ aiConv: null }); setShowConvs(false); input.current?.focus(); }} onClose={onClose} disabled={!!aiJob} />
      {showConvs ? <ConvList convs={convs} current={aiConv} onPick={(id) => { setAi({ aiConv: id }); setShowConvs(false); }} onClose={() => setShowConvs(false)} /> : null}

      <div className="cc-scroll" ref={box}>
        {!conv && !live ? (
          <div className="cc-empty">
            <span className="muted">{tx('Décris ce que tu veux : l\'assistant monte, tu gardes la main sur tout.')}</span>
            <div className="cc-suggest">
              {[COMMANDS[0], COMMANDS[2], COMMANDS[4], COMMANDS[10]].map((c) => (
                <button key={c.cmd} onClick={() => send(c.cmd)} disabled={!!aiJob}><span className="mono dim" style={{ width: 84 }}>{c.cmd}</span><span>{c.label}</span></button>
              ))}
            </div>
          </div>
        ) : null}
        {msgs.map((m, i) => <Message key={m.id} m={m} last={i === msgs.length - 1 && !live} onRun={(mode) => send(tx('Exécute le plan ci-dessus, étape par étape.'), mode)} />)}
        {live ? (
          <>
            {live.user && !msgs.find((m) => m.id === live.user!.id) ? <Message m={live.user} last={false} /> : null}
            <div className="cc-msg">
              {live.stages?.length ? <PrepCard stages={live.stages} /> : null}
              {live.todos?.length ? <TodoList items={live.todos} /> : null}
              <Blocks blocks={live.blocks} live />
              <Spinner live={live} />
            </div>
          </>
        ) : null}
      </div>

      <div className="cc-input-wrap">
        <div className="cc-input">
          {(selLabel && !noCtx) || frame ? (
            <div className="row wrap" style={{ gap: 4, padding: '6px 8px 0' }}>
              {selLabel && !noCtx ? <span className="cc-chip" title={tx('Transmis à l\'assistant')}><Icon name="layers" size={10} /> {selLabel}<button onClick={() => setNoCtx(true)} aria-label={tx('Retirer')}><Icon name="x" size={9} /></button></span> : null}
              {frame ? <span className="cc-chip"><Icon name="marker" size={10} /> {fmt(getFrame() / project.format.fps, 1)}</span> : null}
            </div>
          ) : null}
          <Composer input={input} text={text} setText={setText} onSend={() => send()} onCycle={cycleMode} />
          <div className="cc-bar">
            <button className={`cc-mode ${aiMode}`} onClick={cycleMode} title={`${modeInfo.help} (⇧⇥)`}>{modeInfo.label}</button>
            <span className="spacer" />
            <span className="tiny dim ellipsis">{ai.provider === 'api' ? ai.settings.model.replace('claude-', '').replace(/-/g, ' ') : tx('Claude Code · {0}', ai.settings.cliModel)}</span>
            {aiJob ? <button className="cc-send stop" onClick={() => api.cancelJob(aiJob)} title={tx('Arrêter (Échap)')}><Icon name="stop" size={10} /></button>
              : <button className="cc-send" onClick={() => send()} disabled={!text.trim()} title={tx('Envoyer (↵)')}><Icon name="send" size={13} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ conv, onConvs, onNew, onClose, disabled }: { conv: Conversation | null; onConvs: () => void; onNew: () => void; onClose?: () => void; disabled?: boolean }) {
  return (
    <div className="ptabs" style={{ alignItems: 'center', gap: 2, paddingRight: 4 }}>
      <button className="btn ghost sm" onClick={onConvs} style={{ maxWidth: '70%' }} title={tx('Conversations')}>
        <span className="ellipsis" style={{ fontWeight: 600, color: 'var(--text)' }}>{conv ? conv.title : tx('Assistant')}</span><Icon name="chev" size={11} />
      </button>
      <span className="spacer" />
      <button className="btn icon sm ghost" onClick={onNew} title={tx('Nouvelle conversation')} disabled={disabled}><Icon name="plus" size={14} /></button>
      {onClose ? <button className="btn icon sm ghost" onClick={onClose} title={tx('Masquer (⌘K pour rouvrir)')}><Icon name="x" size={13} /></button> : null}
    </div>
  );
}

// ---------- input with "/" commands and "@" mentions
function Composer({ input, text, setText, onSend, onCycle }: {
  input: React.RefObject<HTMLTextAreaElement | null>; text: string; setText: (s: string) => void; onSend: () => void; onCycle: () => void;
}) {
  const { props } = useComp();
  const speakers = useStore((s) => s.speakers);
  const [pick, setPick] = useState(0);
  const [caret, setCaret] = useState(0);
  const project = props.project;
  const before = text.slice(0, caret);
  const slash = /^\/[\w-]*$/.test(before) ? before : null;
  const at = before.match(/@([\wÀ-ÿ -]{0,24})$/);
  const atQ = at ? at[1] : null;
  const options = useMemo(() => {
    if (slash !== null) return COMMANDS.filter((c) => c.cmd.startsWith(slash)).map((c) => ({ key: c.cmd, label: c.cmd, sub: c.label, insert: c.cmd + ' ' }));
    if (atQ !== null) {
      const q = atQ.toLowerCase();
      const items = [
        ...project.timeline.map((it, i) => ({ key: it.id, label: `${it.type === 'clip' ? tx('Plan') : it.type === 'card' ? tx('Carton') : it.type === 'freeze' ? tx('Arrêt') : tx('Média')} ${i + 1}`,
          sub: it.type === 'clip' ? (it.label || fmt(it.in, 0)) : it.type === 'card' ? it.text.split('\n')[0] : '' })),
        ...project.sources.map((s) => ({ key: s.id, label: s.name, sub: tx('média') })),
        ...speakers.filter((s) => project.speakers.includes(s.id)).map((s) => ({ key: s.id, label: s.name, sub: tx('personne') })),
        ...(project.tracks || []).flatMap((t) => t.clips.map((c) => ({ key: c.id, label: c.type === 'text' ? `« ${c.text.slice(0, 20)} »` : c.name || 'clip', sub: t.name }))),
      ];
      return items.filter((x) => !q || `${x.label} ${x.sub}`.toLowerCase().includes(q)).slice(0, 8)
        .map((x) => ({ key: x.key, label: x.label, sub: x.sub, insert: `@[${x.label}${x.sub && x.sub !== tx('média') && x.sub !== tx('personne') ? ` « ${x.sub.slice(0, 24)} »` : ''}](${x.key}) ` }));
    }
    return [];
  }, [slash, atQ, project, speakers]);
  useEffect(() => { setPick(0); }, [options.length]);
  const apply = (o: { insert: string }) => {
    const start = slash !== null ? 0 : caret - (at ? at[0].length : 0);
    const nt = text.slice(0, start) + o.insert + text.slice(caret);
    setText(nt);
    const pos = start + o.insert.length;
    setCaret(pos);
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };
  return (
    <div style={{ position: 'relative' }}>
      {options.length ? (
        <div className="cc-pop">
          {options.map((o, i) => (
            <button key={o.key} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); apply(o); }}>
              <span className="mono">{o.label}</span><span className="dim ellipsis">{o.sub}</span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea ref={input} className="cc-text" rows={2} value={text} placeholder={tx('Demande une modification…  /  commandes · @ citer')}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          if (options.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setPick((pick + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length); return; }
          if (options.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); apply(options[pick]); return; }
          if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); onCycle(); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }} />
    </div>
  );
}

// ---------- what a request changed (counters before -> after)
const SUMMARY_LABELS: Record<string, () => string> = {
  plans: () => tx('Plans'), cartons: () => tx('Cartons'), duree: () => tx('Durée'), soustitres: () => tx('Sous-titres'), effets: () => tx('Effets'),
  coupes: () => tx('Coupes'), sons: () => tx('Bruitages'), musique: () => tx('Musiques'), incrustations: () => tx('Incrustations'), titres: () => tx('Titres'),
  audio: () => tx('Clips audio'), looks: () => tx('Réglages d’image'),
};
function ChangeSummary({ items }: { items: { k: string; a: number; b: number }[] }) {
  const show = (k: string, v: number) => (k === 'duree' ? fmtDur(v) : String(v));
  return (
    <div className="cc-summary">
      {items.map((x) => {
        const d = x.b - x.a;
        return (
          <span key={x.k} className={`cc-sum ${d > 0 ? 'up' : 'down'}`} title={`${show(x.k, x.a)} → ${show(x.k, x.b)}`}>
            {SUMMARY_LABELS[x.k]?.() || x.k} <b>{x.k === 'duree' ? show(x.k, x.b) : `${d > 0 ? '+' : '−'}${Math.abs(d)}`}</b>
          </span>
        );
      })}
    </div>
  );
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------- messages
function Message({ m, last, onRun }: { m: ConvMsg; last: boolean; onRun?: (mode: AiMode) => void }) {
  const rewindTo = useStore((s) => s.rewindTo);
  const aiJob = useStore((s) => s.aiJob);
  const notify = useStore((s) => s.notify);
  if (m.role === 'user') {
    return (
      <div className="cc-msg cc-user">
        <div className="cc-user-box">
          {m.mode && m.mode !== 'auto' ? <span className="cc-badge">{m.mode === 'plan' ? tx('plan') : tx('demander avant')}</span> : null}
          <Markdown text={m.text} />
          {m.context ? <div className="tiny dim" style={{ marginTop: 4 }}>{m.context}</div> : null}
        </div>
        <div className="cc-actions">
          <button onClick={() => { if (confirm(tx('Remettre le montage comme avant ce message ? (⌘Z pour revenir)'))) rewindTo(m.id); }} disabled={!!aiJob} title={tx('Revenir à l\'état d\'avant ce message')}>{tx('Revenir ici')}</button>
          <button onClick={() => { navigator.clipboard.writeText(m.text); notify(tx('Copié')); }}>{tx('Copier')}</button>
        </div>
      </div>
    );
  }
  const txt = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
  return (
    <div className="cc-msg">
      {m.todos?.length ? <TodoList items={m.todos} done={m.status === 'done'} /> : null}
      <Blocks blocks={m.blocks} />
      {m.status === 'error' ? <div className="cc-error small">{m.error || tx('Erreur')}</div> : null}
      {m.status === 'cancelled' ? <div className="tiny dim">{tx('Arrêté')}</div> : null}
      {m.summary?.length ? <ChangeSummary items={m.summary} /> : null}
      <div className="cc-foot">
        {m.changes ? <span>{m.changes > 1 ? tx('{0} modifications', m.changes) : tx('1 modification')}</span> : null}
        {m.durationMs ? <span>{fmt(m.durationMs / 1000, 0)}</span> : null}
        {m.usage && (m.usage.input || m.usage.output) ? <span>{nf(m.usage.input + (m.usage.cacheRead || 0))} → {nf(m.usage.output)} tokens</span> : null}
        {m.usage?.cost ? <span>{m.usage.cost.toFixed(2).replace('.', ',')} $</span> : null}
        <span className="spacer" />
        {txt ? <button onClick={() => { navigator.clipboard.writeText(txt); notify(tx('Copié')); }}>{tx('Copier')}</button> : null}
      </div>
      {last && m.mode === 'plan' && m.status === 'done' && onRun ? (
        <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
          <button className="btn sm primary" onClick={() => onRun('auto')} disabled={!!aiJob}>{tx('Appliquer le plan')}</button>
          <button className="btn sm" onClick={() => onRun('ask')} disabled={!!aiJob}>{tx('Appliquer en demandant')}</button>
        </div>
      ) : null}
    </div>
  );
}

function Blocks({ blocks, live }: { blocks: Block[]; live?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => b.type === 'tool' && b.name === 'etapes' ? null : b.type === 'text' ? <Markdown key={i} text={b.text} />
        : b.type === 'thinking' ? <Thinking key={i} text={b.text} live={live && i === blocks.length - 1} />
        : <ToolBlock key={b.id} b={b} />)}
    </>
  );
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="cc-think" onClick={() => setOpen(!open)}>
      <span>{open ? tx('Réflexion') : `${live ? tx('Réfléchit : ') : ''}${text.replace(/\s+/g, ' ').slice(0, 90)}${text.length > 90 ? '…' : ''}`}</span>
      {open ? <div className="cc-think-body">{text}</div> : null}
    </div>
  );
}

const TOOL_VERB: Record<string, string> = {
  etat_projet: tx('Lecture'), lire_transcription: tx('Lecture'), chercher_texte: tx('Recherche'), moments_forts: tx('Analyse'), bibliotheque: tx('Bibliothèque'),
  regarder: tx('Regarde'), regarder_montage: tx('Regarde'), regler_style: tx('Style'),
  lire_element: tx('Lecture'), definir_titre: tx('Titre'), ajouter_plan: tx('Ajout'), ajouter_carton: tx('Ajout'), ajouter_arret_image: tx('Ajout'),
  ajouter_media: tx('Ajout'), ajouter_effets: tx('Effets'), supprimer_effets: tx('Suppression'), ecrire_sous_titres: tx('Sous-titres'),
  modifier_sous_titres: tx('Sous-titres'), generer_sous_titres: tx('Sous-titres'), modifier_element: tx('Modification'), supprimer_element: tx('Suppression'),
  deplacer_element: tx('Déplacement'), vider_timeline: tx('Suppression'), musique: tx('Musique'), noter_preference: tx('Mémoire'), ajouter_texte: tx('Titre'),
  ajouter_incrustation: tx('Incrustation'), etalonnage: tx('Couleur'), transition: tx('Transition'), regler_image: tx('Image'),
  modifier_clip_piste: tx('Modification'), supprimer_clips_piste: tx('Suppression'), mixage: tx('Mixage'), effets_image: tx('Effets'), analyser_video: tx('Analyse'), format_projet: tx('Format'), marqueurs: tx('Marqueurs'), exporter: tx('Export'),
};

function ToolBlock({ b }: { b: Extract<Block, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const approve = useStore((s) => s.approve);
  const label = b.label.replace(/^\S+\s+/, '');
  return (
    <div className="cc-tool">
      <div className="cc-tool-row" onClick={() => setOpen(!open)}>
        <span className={`cc-st ${b.status}`}>{b.status === 'running' ? <span className="spin" style={{ width: 8, height: 8, borderWidth: 1.5 }} /> : <i />}</span>
        <b>{TOOL_VERB[b.name] || b.name}</b>
        <span className="ellipsis muted grow">{label}</span>
        <Icon name={open ? 'chev' : 'chevr'} size={11} className="dim" />
      </div>
      {b.status === 'pending' ? (
        <div className="cc-approve">
          <div className="small">{tx('Autoriser :')} <b>{label}</b> ?</div>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm primary" onClick={() => approve(b.id, 'allow')}>{tx('Autoriser')}</button>
            <button className="btn sm" onClick={() => approve(b.id, 'always')}>{tx('Tout autoriser')}</button>
            <button className="btn sm ghost danger" onClick={() => approve(b.id, 'deny')}>{tx('Refuser')}</button>
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="cc-tool-body">
          <span className="tiny dim">{tx('Entrée|outil')}</span>
          <pre>{JSON.stringify(b.input, null, 1)}</pre>
          {b.result ? <><span className="tiny dim">{tx('Résultat')}</span><pre>{b.result}</pre></> : null}
        </div>
      ) : b.status === 'denied' ? <div className="tiny" style={{ color: 'var(--danger)', paddingLeft: 19 }}>{tx('Refusé')}</div> : null}
    </div>
  );
}

/** what the assistant is doing RIGHT NOW (never a decorative word): media preparation, running tool, step, thinking */
function Spinner({ live }: { live: LiveTurn }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  const secs = Math.floor((Date.now() - live.startedAt) / 1000);
  const prep = live.stages?.find((s) => s.kind !== 'proxy' && (s.status === 'running' || s.status === 'queued'));
  const tool = [...live.blocks].reverse().find((b) => b.type === 'tool' && (b.status === 'running' || b.status === 'pending')) as Extract<Block, { type: 'tool' }> | undefined;
  const doing = live.todos?.find((t) => t.status === 'doing');
  const last = live.blocks[live.blocks.length - 1];
  const label = prep ? tx('Préparation des médias : {0}', prepTitle(prep).toLowerCase())
    : tool ? (tool.status === 'pending' ? tx('En attente de ton accord') : `${TOOL_VERB[tool.name] || tool.name} : ${tool.label.replace(/^\S+\s+/, '')}`)
    : last?.type === 'text' ? tx('Écrit sa réponse')
    : doing ? doing.text
    : live.blocks.length ? tx('Réfléchit à la suite') : tx('Lecture du projet');
  const fmtS = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')}` : `${n} s`);
  return (
    <div className="cc-spinner">
      <span className="spin" />
      <span className="ellipsis" style={{ maxWidth: '100%' }}>{label}…</span>
      <span className="dim tiny">{fmtS(secs)}{live.usage?.output ? ` · ${nf(live.usage.output)} tokens` : ''} · {tx('Échap pour arrêter')}</span>
    </div>
  );
}

const PREP_T: Record<string, () => string> = {
  download: () => tx('Téléchargement'), transcribe: () => tx('Transcription'), speakers: () => tx('Qui parle'), proxy: () => tx('Copie allégée (aperçu)'),
};
const prepTitle = (s: PrepStage) => PREP_T[s.kind]?.() || s.title;

/** media preparation before editing: one line per stage, with its actual progress */
function PrepCard({ stages }: { stages: PrepStage[] }) {
  const allDone = stages.every((s) => s.status !== 'running' && s.status !== 'queued');
  const [open, setOpen] = useState(true);
  useEffect(() => { if (allDone) setOpen(false); }, [allDone]);
  return (
    <div className="cc-card">
      <div className="cc-card-head" onClick={() => setOpen(!open)}>
        <b>{allDone ? tx('Médias prêts') : tx('Préparation des médias')}</b>
        <span className="tiny dim">{stages.filter((s) => s.status === 'done').length}/{stages.length}</span>
      </div>
      {open ? stages.map((s) => (
        <div key={s.id} className={`cc-stage ${s.status}`}>
          <span className="cc-stage-ic">{s.status === 'running' ? <span className="spin" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : s.status === 'done' ? <Icon name="check" size={12} /> : s.status === 'error' ? <Icon name="x" size={12} /> : <span className="cc-dot" />}</span>
          <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <span>{prepTitle(s)}</span>
              <span className="tiny dim ellipsis grow">{s.name}</span>
              <span className="tiny mono">{s.status === 'running' ? `${Math.round(s.progress * 100)} %` : s.status === 'queued' ? tx('en attente') : s.status === 'done' ? tx('fait') : s.status === 'error' ? tx('échec') : ''}</span>
            </div>
            {s.status === 'running' ? <div className="cc-bar"><i style={{ width: `${Math.max(2, s.progress * 100)}%` }} /></div> : null}
            {s.detail && (s.status === 'running' || s.status === 'error') ? <span className="tiny dim ellipsis">{s.detail}</span> : null}
          </div>
        </div>
      )) : null}
    </div>
  );
}

/** steps announced by the AI, checked off as they go */
function TodoList({ items, done }: { items: Todo[]; done?: boolean }) {
  return (
    <div className="cc-card">
      <div className="cc-card-head"><b>{tx('Étapes')}</b><span className="tiny dim">{items.filter((i) => i.status === 'done').length}/{items.length}</span></div>
      {items.map((t, i) => {
        const st = done && t.status === 'doing' ? 'done' : t.status;
        return (
          <div key={i} className={`cc-todo ${st}`}>
            <span className="cc-stage-ic">{st === 'doing' ? <span className="spin" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : st === 'done' ? <Icon name="check" size={12} /> : <span className="cc-dot" />}</span>
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function ConvList({ convs, current, onPick, onClose }: { convs: Conversation[]; current: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const { props } = useComp();
  const pid = props.project.id;
  const reload = async () => {
    const r = await api.project(pid);
    useStore.setState({ project: { ...useStore.getState().project!, conversations: r.project.conversations } });
  };
  return (
    <div className="menu" style={{ left: 6, right: 6, top: 32 }} onMouseLeave={onClose}>
      {convs.length === 0 ? <span className="small muted" style={{ padding: 8 }}>{tx('Aucune conversation.')}</span> : null}
      {convs.map((c) => (
        <div key={c.id} className="row" style={{ gap: 2 }}>
          <button className="grow" style={c.id === current ? { background: 'var(--panel-3)' } : undefined} onClick={() => onPick(c.id)}>
            <span className="ellipsis grow">{c.title}</span><span className="tiny dim">{ago(c.updatedAt)}</span>
          </button>
          <button title={tx('Renommer')} onClick={async () => { const t = prompt(tx('Nom'), c.title); if (t) { await api.renameConv(pid, c.id, t); reload(); } }}><Icon name="edit" size={12} /></button>
          <button title={tx('Supprimer')} onClick={async () => { if (confirm(tx('Supprimer « {0} » ?', c.title))) { await api.deleteConv(pid, c.id); if (c.id === current) useStore.getState().setAi({ aiConv: null }); reload(); } }}><Icon name="trash" size={12} /></button>
        </div>
      ))}
    </div>
  );
}
