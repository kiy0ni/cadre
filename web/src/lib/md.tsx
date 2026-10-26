// Lightweight Markdown for AI replies: headings, lists, **bold**, *italic*, `code`, code blocks, links.
import type { ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={k} className="md-code">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(/^https?:/.test(mm[2]) ? <a key={k} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a> : <span key={k} className="md-mention" title={mm[2]}>@{mm[1]}</span>);
    } else out.push(<i key={k}>{t.slice(1, -1)}</i>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={i} className="md-pre">{buf.join('\n')}</pre>);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(<div key={i} className={`md-h md-h${h[1].length}`}>{inline(h[2], `h${i}`)}</div>); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''), `li${i}`)}</li>);
        i++;
      }
      out.push(ordered ? <ol key={`o${i}`} className="md-list">{items}</ol> : <ul key={`u${i}`} className="md-list">{items}</ul>);
      continue;
    }
    if (!l.trim()) { out.push(<div key={i} className="md-gap" />); i++; continue; }
    out.push(<p key={i} className="md-p">{inline(l, `p${i}`)}</p>);
    i++;
  }
  return <div className="md">{out}</div>;
}
