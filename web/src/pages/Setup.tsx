// First launch: checks the AI, offers to add a media library. Two screens; everything can be changed later.
import { useEffect, useState } from 'react';
import { api, type SystemInfo } from '../lib/api';
import { desktop } from '../lib/desktop';
import { Icon, Logo } from '../lib/icons';
import { useStore } from '../lib/store';
import { tx } from '../lib/i18n';

export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [path, setPath] = useState('');
  const notify = useStore((s) => s.notify);
  useEffect(() => { api.system().then(setSys).catch(() => undefined); }, [step]);

  const finish = async () => {
    await api.saveSettings({ onboarded: true }).catch(() => undefined);
    useStore.setState({ settings: { ...(useStore.getState().settings || {}), onboarded: true } });
    onDone();
  };
  const addLib = async (p: string) => {
    if (!p.trim()) return;
    try { await api.addLibrary(p.trim()); setPath(''); setSys(await api.system()); } catch (e) { notify((e as Error).message); }
  };
  const ai = sys?.ai;

  return (
    <div className="modal-bg">
      <div className="modal" style={{ width: 'min(520px, 100%)' }}>
        <div className="modal-body" style={{ padding: 24, gap: 16 }}>
          {step === 0 ? (
            <>
              <div className="row" style={{ gap: 10 }}><Logo size={28} /><h1>{tx('Bienvenue dans Cadre')}</h1></div>
              <p className="muted">{tx('Importe tes rushs, choisis un style : l\'assistant fait le montage, tu retouches tout dans la timeline.')}</p>
              <div className="card col" style={{ gap: 8, padding: 12 }}>
                <div className="row"><span className="dot" style={{ background: ai?.provider ? 'var(--ok)' : 'var(--warn)' }} />
                  <b className="grow">{tx('Assistant IA')}</b>
                  <span className="small muted">{!sys ? '…' : ai?.provider === 'claude-code' ? tx('Claude Code (abonnement)') : ai?.provider === 'api' ? tx('API Anthropic') : tx('non configuré')}</span></div>
                {sys && !ai?.provider ? (
                  <p className="small muted">{tx('Installe Claude Code et connecte-toi une fois (')}<code className="md-code">claude</code> {tx('dans un terminal), ou définis')} <code className="md-code">ANTHROPIC_API_KEY</code>. {tx('Tu peux continuer sans : le montage manuel fonctionne.')}</p>
                ) : null}
                <div className="row"><span className="dot" style={{ background: sys?.ffmpeg ? 'var(--ok)' : 'var(--warn)' }} /><b className="grow">{tx('Lecture des vidéos')}</b><span className="small muted">{sys?.ffmpeg ? tx('prête') : '…'}</span></div>
                <div className="row"><span className="dot" style={{ background: 'var(--ok)' }} /><b className="grow">{tx('Transcription')}</b><span className="small muted ellipsis" style={{ maxWidth: 220 }}>{sys?.transcription || '…'}</span></div>
              </div>
            </>
          ) : (
            <>
              <h1>{tx('Tes médias réutilisables')}</h1>
              <p className="muted">{tx("Un dossier de musiques, bruitages, logos ou vidéos à réutiliser ? L'assistant s'en servira pour habiller tes montages. Facultatif.")}</p>
              {sys?.libraries.map((l) => <div key={l.id} className="row small"><Icon name="folder" size={13} /><span className="grow ellipsis">{l.path}</span><Icon name="check" size={13} style={{ color: 'var(--ok)' }} /></div>)}
              <div className="row">
                {desktop()?.pickFolder ? <button className="btn" onClick={async () => { const p = await desktop()!.pickFolder!(); if (p) addLib(p); }}><Icon name="folder" size={13} /> {tx('Choisir un dossier…')}</button> : (
                  <><input className="input grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder={tx('Chemin du dossier')} onKeyDown={(e) => e.key === 'Enter' && addLib(path)} />
                    <button className="btn" onClick={() => addLib(path)}>{tx('Ajouter')}</button></>
                )}
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <span className="small dim" style={{ alignSelf: 'center' }}>{step + 1} / 2</span>
          <span className="spacer" />
          {step === 0 ? <button className="btn primary" onClick={() => setStep(1)}>{tx('Continuer')}</button>
            : <><button className="btn ghost" onClick={finish}>{tx('Plus tard')}</button><button className="btn primary" onClick={finish}>{tx('Commencer')}</button></>}
        </div>
      </div>
    </div>
  );
}
