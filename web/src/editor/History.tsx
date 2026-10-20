// Historique : toutes les étapes du montage (y compris celles de l'assistant). Clic : revenir à cette étape (rien n'est perdu
// tant qu'on ne modifie pas : les étapes suivantes restent en grisé, ⌘⇧Z pour les retrouver).
import { useEffect, useRef, useState } from 'react';
import { ago } from '../lib/format';
import { histMeta, useStore } from '../lib/store';
import { tx } from '../lib/i18n';

export function HistoryPanel() {
  const past = useStore((s) => s.past);
  const project = useStore((s) => s.project);
  const future = useStore((s) => s.future);
  const jump = useStore((s) => s.jumpHistory);
  const aiJob = useStore((s) => s.aiJob);
  const [, tick] = useState(0);
  const cur = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { cur.current?.scrollIntoView({ block: 'nearest' }); }, [past.length]);
  if (!project) return null;
  const all = [...past, project, ...future];
  const k0 = past.length;
  return (
    <div className="pbody">
      {all.map((st, k) => {
        const m = histMeta.get(st);
        const isCur = k === k0;
        return (
          <div key={k} ref={isCur ? cur : undefined} className={`list-item ${isCur ? 'on' : ''}`}
            style={{ borderRadius: 0, opacity: k > k0 ? 0.45 : 1, cursor: aiJob ? 'default' : 'pointer' }} onClick={() => jump(k)}>
            <span className="mono dim" style={{ width: 24 }}>{k + 1}</span>
            <span className="grow ellipsis">{m?.label || (k === 0 ? tx('État initial') : tx('Modification'))}</span>
            {m ? <span className="tiny dim">{ago(m.t / 1000)}</span> : null}
          </div>
        );
      })}
      <div className="tiny dim" style={{ padding: 10 }}>{tx('100 étapes gardées. Clic : revenir à une étape.')}</div>
    </div>
  );
}
