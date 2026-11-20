import type { ReactNode } from 'react';

/** Kleiner, sicherer Markdown-Renderer (Überschriften, Listen, **fett**, *kursiv*, `code`) – kein HTML. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let pos = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    pos = m.index + t.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;
  const flush = () => {
    if (!list.length) return;
    const items = list.map((l, i) => <li key={i}>{inline(l, `li${blocks.length}-${i}`)}</li>);
    blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      if (list.length && ordered !== !!num) flush();
      ordered = !!num;
      list.push((bullet ?? num)![1]!);
      continue;
    }
    flush();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) blocks.push(<div key={blocks.length} className={`md-h md-h${h[1]!.length}`}>{inline(h[2]!, `h${blocks.length}`)}</div>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line, `p${blocks.length}`)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}
