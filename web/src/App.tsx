import { useEffect, useState } from 'react';
import { useStore } from './lib/store';
import { desktop } from './lib/desktop';
import { Icon, Logo } from './lib/icons';
import { HomePage } from './pages/Home';
import { StylesPage } from './pages/Styles';
import { PeoplePage } from './pages/People';
import { SettingsPage } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { api } from './lib/api';
import { Editor } from './editor/Editor';
import { menuAction } from './editor/shortcuts';
import { applyUiScale, ContextMenuHost } from './lib/ui';
import { tx } from './lib/i18n';

function useHash() {
  const [h, setH] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setH(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

if (window.cadre) document.documentElement.classList.add('desktop');
applyUiScale();

export function App() {
  const hash = useHash();
  const boot = useStore((s) => s.boot);
  const toast = useStore((s) => s.toast);
  const notify = useStore((s) => s.notify);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [auth, setAuth] = useState<null | { configured: boolean }>(null);
  useEffect(() => {
    const on = () => { api.authStatus().then((a) => { if (!a.authenticated) setAuth({ configured: a.configured }); }).catch(() => undefined); };
    window.addEventListener('cadre-auth', on);
    return () => window.removeEventListener('cadre-auth', on);
  }, []);

  useEffect(() => {
    boot().then(() => {
      setReady(true);
      const s = useStore.getState().settings;
      if (s && !s.onboarded) setSetup(true);
    }).catch((e) => setErr(String(e)));
  }, [boot]);
  // desktop app menu: in a text field, undo / redo act on the text; otherwise on the edit
  useEffect(() => desktop()?.onMenu((a) => {
    const el = document.activeElement as HTMLElement | null;
    const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (typing && (a === 'undo' || a === 'redo')) { document.execCommand(a); return; }
    if (typing && (a === 'delete' || a === 'split' || a === 'play')) return;
    if (a === 'settings') { window.location.hash = '#/reglages'; return; }
    if (useStore.getState().project) menuAction(a);
    else if (a === 'undo' || a === 'redo') document.execCommand(a);
  }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => notify(null), 4000);
    return () => clearTimeout(t);
  }, [toast, notify]);

  if (auth) return <Login configured={auth.configured} />;
  if (err) {
    return (
      <div className="overlay-msg" style={{ position: 'fixed' }}>
        <Logo size={32} />
        <b>{tx('Le moteur de Cadre ne répond pas')}</b>
        <span className="muted">{tx('Relance l\'application. Si ça continue, regarde Réglages › À propos.')}</span>
        <span className="dim small mono">{err}</span>
        <button className="btn" onClick={() => window.location.reload()}>{tx('Réessayer')}</button>
      </div>
    );
  }
  if (!ready) return <div className="overlay-msg" style={{ position: 'fixed' }}><span className="spin" /></div>;

  const m = hash.match(/^#\/p\/([\w-]+)/);
  return (
    <>
      {m ? <Editor id={m[1]} /> : (
        <div className="shell">
          <Side hash={hash} />
          <main className="main">
            {hash.startsWith('#/styles') ? <StylesPage /> : hash.startsWith('#/personnes') ? <PeoplePage /> : hash.startsWith('#/reglages') ? <SettingsPage /> : <HomePage />}
          </main>
        </div>
      )}
      {setup ? <Setup onDone={() => setSetup(false)} /> : null}
      <ContextMenuHost />
      {toast ? <div className="toast" onClick={() => notify(null)}>{toast}</div> : null}
    </>
  );
}

function Side({ hash }: { hash: string }) {
  const on = (h: string) => (hash === h || (h !== '#/' && hash.startsWith(h)) || (h === '#/' && hash === '') ? 'nav on' : 'nav');
  return (
    <nav className="side">
      <div className="brand"><Logo size={20} /> Cadre</div>
      <a href="#/" className={on('#/')}><Icon name="grid" /> {tx('Projets')}</a>
      <a href="#/styles" className={on('#/styles')}><Icon name="style" /> {tx('Styles de montage')}</a>
      <a href="#/personnes" className={on('#/personnes')}><Icon name="people" /> {tx('Personnes')}</a>
      <span className="spacer d-only" />
      <a href="#/reglages" className={on('#/reglages')}><Icon name="settings" /> {tx('Réglages')}</a>
    </nav>
  );
}
