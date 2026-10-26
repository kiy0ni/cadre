// Settings: AI, media libraries, transcription and voices, remote access, shortcuts, about.
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api, followJob, type AiStatus, type SystemInfo } from '../lib/api';
import { desktop } from '../lib/desktop';
import { Icon } from '../lib/icons';
import { useStore } from '../lib/store';
import { applyUiScale, Seg } from '../lib/ui';
import { getLang, LANGS, setLang, tx, type Lang } from '../lib/i18n';
import { setPrefs, usePrefs } from '../lib/prefs';
import { mb } from '../lib/format';

const SECTIONS: [string, string, string][] = [
  ['general', tx('Général'), 'settings'], ['montage', tx('Montage'), 'film'], ['import', tx('Import et export'), 'import'],
  ['ia', tx('Intelligence artificielle'), 'assistant'], ['bibliotheques', tx('Bibliothèques'), 'folder'], ['analyse', tx('Transcription et voix'), 'mic'],
  ['stockage', tx('Stockage'), 'cpu'], ['distance', tx('Accès à distance'), 'globe'], ['raccourcis', tx('Raccourcis clavier'), 'keyboard'], ['about', tx('À propos'), 'info'],
];

export function SettingsPage() {
  const [sec, setSec] = useState(() => window.location.hash.split('/')[2] || 'general');
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const reload = async () => { const [s, st] = await Promise.all([api.system(), api.settings()]); setSys(s); setSettings(st.settings); };
  useEffect(() => { reload(); }, []);
  const go = (k: string) => { setSec(k); history.replaceState(null, '', `#/reglages/${k}`); };

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <h1>{tx('Réglages')}</h1>
      <div className="split2" style={{ gridTemplateColumns: '210px 1fr' }}>
        <div className="list">
          {SECTIONS.map(([k, l, i]) => <div key={k} className={`list-item ${sec === k ? 'on' : ''}`} onClick={() => go(k)}><Icon name={i} size={14} /> {l}</div>)}
        </div>
        <div className="col" style={{ gap: 14 }}>
          {!sys || !settings ? <span className="spin" /> : sec === 'ia' ? <AiSection ai={sys.ai} onChange={reload} />
            : sec === 'bibliotheques' ? <LibrariesSection sys={sys} onChange={reload} />
            : sec === 'analyse' ? <AnalysisSection sys={sys} settings={settings} onChange={reload} />
            : sec === 'distance' ? <RemoteSection settings={settings} onChange={reload} />
            : sec === 'general' || sec === 'affichage' ? <GeneralSection />
            : sec === 'montage' ? <EditingSection />
            : sec === 'import' ? <ImportExportSection sys={sys} settings={settings} onChange={reload} />
            : sec === 'stockage' ? <StorageSection sys={sys} />
            : sec === 'raccourcis' ? <Shortcuts />
            : <About sys={sys} />}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return <div className="card col" style={{ gap: 12 }}><div className="row"><h2 className="grow">{title}</h2>{right}</div>{children}</div>;
}

function AiSection({ ai, onChange }: { ai: AiStatus; onChange: () => void }) {
  const notify = useStore((s) => s.notify);
  const s = ai.settings;
  const save = async (patch: Partial<AiStatus['settings']>) => {
    const r = await api.saveSettings({ ai: { ...s, ...patch } });
    useStore.setState({ ai: r.ai });
    onChange();
    notify(tx('Enregistré'));
  };
  return (
    <>
      <Card title={tx('Intelligence artificielle')} right={ai.provider ? <span className="badge ok">{tx('active')}</span> : <span className="badge warn">{tx('non configurée')}</span>}>
        <div className="col" style={{ gap: 6 }}>
          <Status ok={!!ai.claudeCode} label={tx('Claude Code')} detail={ai.claudeCode ? tx('installé : utilise ton abonnement Claude') : tx('non installé')} />
          <Status ok={!!ai.api} label={tx('Clé d\'API Anthropic')} detail={ai.api ? tx('détectée ({0})', ai.api) : tx('aucune clé dans l\'environnement')} />
        </div>
        <label className="field"><span>{tx('Utiliser')}</span>
          <select className="input" value={s.provider} onChange={(e) => save({ provider: e.target.value })}>
            <option value="auto">{tx('Automatique')}</option>
            <option value="claude-code">{tx('Claude Code (abonnement)')}</option>
            <option value="api">{tx('API Anthropic (paiement à l\'usage)')}</option>
          </select></label>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          <label className="field"><span>{tx('Modèle (API)')}</span>
            <select className="input" value={s.model} onChange={(e) => save({ model: e.target.value })}>
              <option value="claude-opus-5-5">{tx('Claude Opus 5.5')}</option>
              <option value="claude-sonnet-5-5">{tx('Claude Sonnet 5.5')}</option>
              <option value="claude-fable-5-1">{tx('Claude Fable 5.1')}</option>
            </select></label>
          <label className="field"><span>{tx('Réflexion')}</span>
            <select className="input" value={s.effort} onChange={(e) => save({ effort: e.target.value })}>
              {[['low', tx('Rapide')], ['medium', tx('Normale')], ['high', tx('Approfondie')], ['xhigh', tx('Maximale')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className="field"><span>{tx('Modèle (Claude Code)')}</span>
            <select className="input" value={s.cliModel} onChange={(e) => save({ cliModel: e.target.value })}>
              {[['opus', 'Opus'], ['sonnet', 'Sonnet'], ['fable', 'Fable']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
        </div>
      </Card>
      <Card title={tx('Connexion')}>
        <p className="small muted">
          <b style={{ color: 'var(--text)' }}>{tx('Avec un abonnement Claude')}</b> : {tx('installe Claude Code puis connecte-toi une fois (')}<code className="md-code">claude</code>{tx("dans un terminal). Rien d'autre à faire.")}
        </p>
        <p className="small muted">
          <b style={{ color: 'var(--text)' }}>{tx("Avec une clé d'API")}</b> : {tx('définis')} <code className="md-code">ANTHROPIC_API_KEY</code> {tx("dans l'environnement avant de lancer Cadre. La clé n'est jamais enregistrée par l'application.")}
        </p>
      </Card>
    </>
  );
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return <div className="row"><span className="dot" style={{ background: ok ? 'var(--ok)' : 'var(--text-3)' }} /><b style={{ width: 160 }}>{label}</b><span className="muted small">{detail}</span></div>;
}

function LibrariesSection({ sys, onChange }: { sys: SystemInfo; onChange: () => void }) {
  const notify = useStore((s) => s.notify);
  const [path, setPath] = useState('');
  const add = async (p: string) => {
    if (!p.trim()) return;
    try { await api.addLibrary(p.trim()); setPath(''); onChange(); notify(tx('Bibliothèque ajoutée, analyse en cours')); refreshLibrary(); }
    catch (e) { notify((e as Error).message); }
  };
  const pick = async () => { const d = desktop(); const p = d?.pickFolder ? await d.pickFolder() : null; if (p) add(p); };
  return (
    <Card title={tx('Bibliothèques de médias')} right={sys.libraryReady ? <span className="badge ok">{tx('prête')}</span> : sys.libraries.length ? <span className="badge"><span className="spin" style={{ width: 8, height: 8 }} /> {tx('analyse')}</span> : null}>
      <p className="small muted">{tx('Dossiers de musiques, bruitages, images et vidéos réutilisables. Cadre les classe tout seul et l\'IA s\'en sert pour habiller tes montages.')}</p>
      <div className="col" style={{ gap: 4 }}>
        {sys.libraries.length === 0 ? <span className="small dim">{tx('Aucune bibliothèque.')}</span> : null}
        {sys.libraries.map((l) => (
          <div key={l.id} className="rowi" style={{ cursor: 'default', border: '1px solid var(--border)', borderRadius: 5 }}>
            <Icon name="folder" size={14} />
            <div className="grow" style={{ minWidth: 0 }}><b>{l.name}</b><div className="tiny dim ellipsis" title={l.path}>{l.path}</div></div>
            {l.exists === false ? <span className="badge err">{tx('introuvable')}</span> : l.exists === null ? <span className="badge warn">{tx('accès en attente')}</span> : null}
            <button className="btn icon sm ghost" onClick={async () => { await api.deleteLibrary(l.id); onChange(); refreshLibrary(); }} title={tx('Retirer')}><Icon name="x" size={12} /></button>
          </div>
        ))}
      </div>
      <div className="row">
        {desktop()?.pickFolder ? <button className="btn" onClick={pick}><Icon name="folder" size={13} /> {tx('Ajouter un dossier…')}</button> : null}
        <input className="input grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder={tx('Chemin d\'un dossier')} onKeyDown={(e) => e.key === 'Enter' && add(path)} />
        <button className="btn" onClick={() => add(path)} disabled={!path.trim()}>{tx('Ajouter')}</button>
        <button className="btn ghost" onClick={async () => { await api.rescanLibraries(); refreshLibrary(); notify(tx('Nouvelle analyse lancée')); onChange(); }}>{tx('Réanalyser')}</button>
      </div>
    </Card>
  );
}

/** reloads the library in the editor (the server rebuilds it in the background) */
function refreshLibrary() {
  useStore.setState({ library: null });
  const tryLoad = async (n = 0) => {
    const lib = await api.library().catch(() => null);
    if (lib && !(lib as unknown as { loading?: boolean }).loading) { useStore.setState({ library: lib }); return; }
    if (n < 100) setTimeout(() => tryLoad(n + 1), 3000);
  };
  tryLoad();
}

function AnalysisSection({ sys, settings, onChange }: { sys: SystemInfo; settings: Record<string, unknown>; onChange: () => void }) {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);
  const tr = (settings.transcription as { model?: string }) || {};
  const setModel = async (model: string) => { await api.saveSettings({ transcription: { ...tr, model } }); onChange(); };
  const install = async () => {
    setBusy(tx('Préparation…'));
    try {
      const { job } = await api.installVoices();
      const j = await followJob(job, undefined, (x) => setBusy(x.message || '…'));
      if (j.status !== 'done') throw new Error(j.error || tx('échec'));
      notify(tx('Modules voix installés : relance Cadre pour les activer'));
    } catch (e) { notify((e as Error).message); }
    setBusy(null);
    onChange();
  };
  return (
    <>
      <Card title={tx('Transcription')}>
        <div className="row"><span className="muted small" style={{ width: 120 }}>{tx('Moteur')}</span><span className="small">{sys.transcription}</span></div>
        <label className="field"><span>{tx('Qualité')}</span>
          <select className="input" value={tr.model || 'turbo'} onChange={(e) => setModel(e.target.value)}>
            <option value="turbo">{tx('Précise (recommandé)')}</option>
            <option value="rapide">{tx('Rapide (machines modestes)')}</option>
          </select></label>
      </Card>
      <Card title={tx('Reconnaissance des voix')} right={sys.voices ? <span className="badge ok">{tx('installée')}</span> : <span className="badge">{tx('non installée')}</span>}>
        <p className="small muted">{tx('Reconnaît qui parle et sépare la voix du fond sonore (musique, ambiance, jeu…). Téléchargement d\'environ 2 Go.')}</p>
        {!sys.voices ? (
          <div className="row"><button className="btn" onClick={install} disabled={!!busy}>{busy ? <><span className="spin" /> <span className="ellipsis" style={{ maxWidth: 360 }}>{busy}</span></> : tx('Installer')}</button></div>
        ) : null}
      </Card>
    </>
  );
}

function RemoteSection({ settings, onChange }: { settings: Record<string, unknown>; onChange: () => void }) {
  const [url, setUrl] = useState(String(settings.remoteUrl || ''));
  const [st, setSt] = useState<{ local: boolean; configured: boolean } | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [cur, setCur] = useState('');
  const notify = useStore((s) => s.notify);
  useEffect(() => { api.authStatus().then(setSt).catch(() => undefined); }, []);
  const save = async () => {
    if (pw.length < 8) { notify(tx('8 caractères minimum')); return; }
    if (pw !== pw2) { notify(tx('Les deux mots de passe sont différents')); return; }
    try {
      await api.setPassword(pw, st?.local ? undefined : cur);
      setPw(''); setPw2(''); setCur('');
      notify(tx('Mot de passe enregistré : les autres appareils devront se reconnecter'));
      setSt(await api.authStatus());
      if (!st?.local) window.location.reload();
    } catch (e) { notify((e as Error).message); }
  };
  return (
    <>
      <Card title={tx('Accès à distance')}>
        <p className="small muted">{tx('Ouvre Cadre depuis un téléphone ou un autre ordinateur. Depuis un autre appareil que ce Mac, un mot de passe est toujours demandé.')}</p>
        <label className="field"><span>{tx('Adresse')}</span>
          <div className="row"><input className="input grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://my-computer.tailnet.ts.net" />
            <button className="btn" onClick={async () => { await api.saveSettings({ remoteUrl: url.trim() }); onChange(); notify(tx('Enregistré')); }}>{tx('Enregistrer')}</button>
            {url ? <button className="btn ghost" onClick={() => { navigator.clipboard.writeText(url); notify(tx('Lien copié')); }}><Icon name="copy" size={13} /></button> : null}
          </div></label>
      </Card>
      <Card title={tx('Mot de passe d’accès')} right={st ? (st.configured ? <span className="badge ok">{tx('défini')}</span> : <span className="badge warn">{tx('non défini : accès à distance fermé')}</span>) : null}>
        {st && !st.local ? <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder={tx('Mot de passe actuel')} /> : null}
        <div className="row">
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tx('Nouveau mot de passe (8 caractères min.)')} />
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder={tx('Confirmer')} />
          <button className="btn primary" onClick={save} disabled={!pw}>{tx('Enregistrer')}</button>
        </div>
        {st && !st.local ? <div className="row"><button className="btn ghost" onClick={async () => { await api.logout(); window.location.reload(); }}>{tx('Se déconnecter de cet appareil')}</button></div> : null}
      </Card>
    </>
  );
}

export const SHORTCUTS: [string, string][] = [
  [tx('Espace'), tx('Lecture / pause')], [tx('J  K  L'), tx('Arrière / pause / avant')], ['←  →', tx('Image précédente / suivante (⇧ : 1 s)')], ['↑  ↓', tx('Coupe précédente / suivante')],
  [tx('I  O'), tx('Point d\'entrée / de sortie (moniteur source)')], [',', tx('Insérer dans le montage')], ['.', tx('Ajouter en incrustation')],
  ['²', tx('Agrandir / réduire le panneau survolé')], ['V', tx('Outil sélection')], ['C', tx('Outil lame')], ['S', tx('Couper sous la tête de lecture')], ['M', tx('Marqueur')], ['Z', tx('Zoom sur le visage')],
  [tx('Suppr'), tx('Supprimer la sélection')], ['⌘D', tx('Dupliquer')], [tx('⌘Z  ⇧⌘Z'), tx('Annuler / rétablir')], ['⌘K', tx('Écrire à l\'assistant')], ['+  −', tx('Zoom de la timeline')], ['⇧Z', tx('Timeline entière')],
  ['Q  W', tx('Rogner le début / la fin jusqu\'à la tête de lecture')], [tx('⇧Suppr'), tx('Supprimer en gardant l’espace')],
  [tx('⌘ + glisser'), tx('Insérer un plan entre deux autres')], [tx('⌥ + glisser'), tx('Dupliquer en glissant')], ['⌘L', tx('Délier / rattacher l’audio')], [tx('Échap'), tx('Annuler le glisser en cours')],
];

function Toggle({ label, help, v, on }: { label: string; help?: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="setting-row">
      <span className="col" style={{ gap: 2 }}><b>{label}</b>{help ? <span className="small muted">{help}</span> : null}</span>
      <input type="checkbox" className="switch" checked={v} onChange={(e) => on(e.target.checked)} />
    </label>
  );
}

function Line({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span className="col" style={{ gap: 2 }}><b>{label}</b>{help ? <span className="small muted">{help}</span> : null}</span>
      <div className="row" style={{ gap: 8, flex: 'none' }}>{children}</div>
    </div>
  );
}

function GeneralSection() {
  const prefs = usePrefs();
  const [scale, setScale] = useState(() => { try { return Number(localStorage.getItem('cadre-ui-scale')) || 1; } catch { return 1; } });
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  return (
    <>
      <Card title={tx('Général')}>
        <Line label={tx('Langue')} help={tx('Langue de l’interface et des réponses de l’assistant.')}>
          <select className="input" style={{ width: 180 }} value={getLang()} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Line>
        <Line label={tx('Taille de l’interface')}>
          <div className="seg">
            {[0.9, 1, 1.1, 1.25, 1.4].map((v) => <button key={v} className={Math.abs(scale - v) < 0.01 ? 'on' : ''} onClick={() => setScale(applyUiScale(v))}>{Math.round(v * 100)} %</button>)}
          </div>
        </Line>
        <Toggle label={tx('Notifications')} help={tx('Prévenir quand un export ou une analyse se termine.')} v={prefs.notify && perm !== 'denied'}
          on={async (v) => { if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') setPerm(await Notification.requestPermission()); setPrefs({ notify: v }); }} />
        <Toggle label={tx('Confirmer les suppressions')} help={tx('Demander avant de supprimer un projet ou une piste qui contient des clips.')} v={prefs.confirmDelete} on={(v) => setPrefs({ confirmDelete: v })} />
      </Card>
      <Card title={tx('Nouveaux projets')}>
        <Line label={tx('Style par défaut')}>
          <select className="input" style={{ width: 240 }} value={prefs.defaultPack} onChange={(e) => setPrefs({ defaultPack: e.target.value })}>
            <option value="">{tx('Le premier de la liste')}</option>
            {useStore.getState().packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Line>
        <Line label={tx('Format par défaut')}>
          <select className="input" style={{ width: 240 }} value={prefs.defaultFormat} onChange={(e) => setPrefs({ defaultFormat: e.target.value })}>
            <option value="">{tx('Celui du style')}</option>
            {['16:9', '9:16', '1:1', '4:5'].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Line>
      </Card>
    </>
  );
}

function EditingSection() {
  const p = usePrefs();
  return (
    <>
      <Card title={tx('Timeline')}>
        <Toggle label={tx('Magnétisme')} help={tx('Les clips s’aimantent aux coupes, à la tête de lecture et aux marqueurs.')} v={p.snap} on={(v) => { setPrefs({ snap: v }); useStore.getState().setUi({ snap: v }); }} />
        <Toggle label={tx('Suivre la tête de lecture')} help={tx('La timeline défile pendant la lecture.')} v={p.followPlayhead} on={(v) => setPrefs({ followPlayhead: v })} />
        <Toggle label={tx('Vignettes des plans')} v={p.thumbs} on={(v) => setPrefs({ thumbs: v })} />
        <Toggle label={tx('Formes d’onde')} v={p.waves} on={(v) => setPrefs({ waves: v })} />
      </Card>
      <Card title={tx('Durées par défaut')}>
        <Line label={tx('Image fixe')}><input className="input" type="number" min={0.2} step={0.1} style={{ width: 90 }} value={p.imageDur} onChange={(e) => setPrefs({ imageDur: Number(e.target.value) || 3 })} /><span className="small dim">s</span></Line>
        <Line label={tx('Titre')}><input className="input" type="number" min={0.2} step={0.1} style={{ width: 90 }} value={p.textDur} onChange={(e) => setPrefs({ textDur: Number(e.target.value) || 3 })} /><span className="small dim">s</span></Line>
        <Line label={tx('Transition')}><input className="input" type="number" min={0.05} step={0.05} style={{ width: 90 }} value={p.transitionDur} onChange={(e) => setPrefs({ transitionDur: Number(e.target.value) || 0.4 })} /><span className="small dim">s</span></Line>
      </Card>
      <Card title={tx('Aperçu et assistant')}>
        <Line label={tx('Qualité de l’aperçu')} help={tx('« Allégé » reste fluide sur les gros projets ; « Pleine » montre les fichiers d’origine.')}>
          <Seg value={p.previewFull ? 'full' : 'light'} options={[['light', tx('Allégé')], ['full', tx('Pleine')]]} onChange={(v) => setPrefs({ previewFull: v === 'full' })} />
        </Line>
        <Line label={tx('Mode de l’assistant')} help={tx('Auto : il modifie directement. Demander : il attend ton accord. Plan : il propose sans toucher.')}>
          <Seg value={p.aiMode} options={[['auto', tx('Auto')], ['ask', tx('Demander')], ['plan', tx('Plan|mode')]]} onChange={(v) => { setPrefs({ aiMode: v }); useStore.getState().setAi({ aiMode: v }); }} />
        </Line>
      </Card>
    </>
  );
}

function ImportExportSection({ sys, settings, onChange }: { sys: SystemInfo; settings: Record<string, unknown>; onChange: () => void }) {
  const p = usePrefs();
  const imp = (settings.import as { proxy?: boolean; transcribe?: boolean }) || {};
  const exp = (settings.export as { copyTo?: string }) || {};
  const [dir, setDir] = useState(exp.copyTo || '');
  const save = async (patch: Record<string, unknown>) => { await api.saveSettings(patch); onChange(); };
  return (
    <>
      <Card title={tx('À l’import')}>
        <Toggle label={tx('Créer une copie allégée')} help={tx('Aperçu fluide même avec des vidéos 4K ou très longues. Recommandé.')} v={imp.proxy !== false} on={(v) => save({ import: { ...imp, proxy: v } })} />
        <Toggle label={tx('Transcrire automatiquement')} help={tx('Nécessaire pour les sous-titres et pour que l’assistant comprenne la vidéo.')} v={imp.transcribe !== false} on={(v) => save({ import: { ...imp, transcribe: v } })} />
      </Card>
      <Card title={tx('Export')}>
        <Line label={tx('Préréglage par défaut')}>
          <select className="input" style={{ width: 220 }} value={p.exportPreset} onChange={(e) => setPrefs({ exportPreset: e.target.value })}>
            {Object.entries(sys.presets).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Line>
        <Line label={tx('Copier aussi chaque export dans')} help={tx('Les exports restent dans le dossier du projet ; une copie part ici (facultatif).')}>
          <input className="input" style={{ width: 240 }} value={dir} placeholder={tx('Aucun dossier')} onChange={(e) => setDir(e.target.value)} onBlur={() => save({ export: { ...exp, copyTo: dir.trim() } })} />
          {desktop()?.pickFolder ? <button className="btn" onClick={async () => { const d = await desktop()!.pickFolder!(); if (d) { setDir(d); save({ export: { ...exp, copyTo: d } }); } }}><Icon name="folder" size={13} /></button> : null}
        </Line>
        {desktop() ? <Toggle label={tx('Afficher le fichier à la fin')} v={p.revealExport} on={(v) => setPrefs({ revealExport: v })} /> : null}
      </Card>
    </>
  );
}

function StorageSection({ sys }: { sys: SystemInfo }) {
  const [st, setSt] = useState<Record<string, number> | null>(null);
  const notify = useStore((s) => s.notify);
  useEffect(() => { api.storage().then(setSt).catch(() => setSt({})); }, []);
  const rows: [string, string, string][] = [
    ['previews', tx('Vignettes et formes d’onde'), tx('Recréées à la demande.')], ['features', tx('Empreintes des sons et musiques'), tx('Recalculées à la prochaine analyse de vidéo.')],
    ['stems', tx('Voix séparées'), tx('Recalculées si besoin.')], ['refs', tx('Vidéos d’exemple téléchargées'), tx('Retéléchargées à la prochaine analyse.')], ['ai', tx('Fichiers temporaires de l’assistant'), ''],
  ];
  const clear = async (what: string[]) => { const r = await api.clearStorage(what); setSt(r); notify(tx('Espace libéré')); };
  return (
    <Card title={tx('Stockage')} right={st ? <button className="btn sm" onClick={() => clear(rows.map((r) => r[0]))}>{tx('Tout vider')}</button> : null}>
      {!st ? <span className="spin" /> : (
        <>
          {rows.map(([k, l, h]) => (
            <Line key={k} label={l} help={h}>
              <span className="mono small" style={{ width: 80, textAlign: 'right' }}>{mb(st[k] || 0)}</span>
              <button className="btn sm" disabled={!st[k]} onClick={() => clear([k])}>{tx('Vider')}</button>
            </Line>
          ))}
          <Line label={tx('Projets (médias importés, copies allégées, exports)')}><span className="mono small">{mb(st.projects || 0)}</span></Line>
          <div className="row small dim"><Icon name="folder" size={13} /><span className="mono ellipsis" title={sys.dataDir}>{sys.dataDir}</span>
            {desktop() ? <button className="btn sm ghost" onClick={() => desktop()!.reveal(sys.dataDir)}>{tx('Ouvrir')}</button> : null}</div>
        </>
      )}
    </Card>
  );
}

function Shortcuts() {
  return (
    <Card title={tx('Raccourcis clavier')}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '6px 12px' }}>
        {SHORTCUTS.map(([k, l]) => <Fragment key={k}><span className="row" style={{ gap: 4 }}>{k.split('  ').map((x) => <kbd key={x}>{x}</kbd>)}</span><span className="muted">{l}</span></Fragment>)}
      </div>
    </Card>
  );
}

function About({ sys }: { sys: SystemInfo }) {
  return (
    <Card title={`${sys.app} ${sys.version}`}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '6px 12px' }} className="small">
        <span className="muted">{tx('Système')}</span><span>{sys.platform} · {sys.arch}</span>
        <span className="muted">{tx('Transcription')}</span><span>{sys.transcription}</span>
        <span className="muted">FFmpeg</span><span>{sys.ffmpeg ? 'disponible' : 'absent'}</span>
        <span className="muted">{tx('Données')}</span><span className="mono ellipsis" title={sys.dataDir}>{sys.dataDir}</span>
      </div>
      {desktop() ? <div className="row"><button className="btn" onClick={() => desktop()!.reveal(sys.dataDir)}><Icon name="folder" size={13} /> {tx('Ouvrir le dossier des données')}</button></div> : null}
    </Card>
  );
}
