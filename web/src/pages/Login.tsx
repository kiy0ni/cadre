// Connexion pour l'accès à distance (navigateur d'un autre appareil). Sur le Mac lui-même, aucun mot de passe.
import { useState } from 'react';
import { api } from '../lib/api';
import { Logo } from '../lib/icons';
import { tx } from '../lib/i18n';

export function Login({ configured }: { configured: boolean }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await api.login(pw); window.location.reload(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="overlay-msg" style={{ position: 'fixed', background: 'var(--bg)' }}>
      <form className="card col" style={{ width: 'min(360px, calc(100vw - 32px))', gap: 14, padding: 24 }} onSubmit={go}>
        <div className="row" style={{ gap: 10 }}><Logo size={26} /><h1>Cadre</h1></div>
        {configured ? (
          <>
            <span className="muted">{tx('Accès à distance : entre le mot de passe défini sur ton Mac.')}</span>
            <input className="input" type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tx('Mot de passe')} />
            {err ? <span className="small" style={{ color: 'var(--danger)' }}>{err}</span> : null}
            <button className="btn primary" disabled={busy || !pw}>{busy ? <span className="spin" /> : tx('Se connecter')}</button>
          </>
        ) : (
          <span className="muted">{tx('L’accès à distance est fermé : définis d’abord un mot de passe sur ton Mac (Réglages › Accès à distance).')}</span>
        )}
      </form>
    </div>
  );
}
