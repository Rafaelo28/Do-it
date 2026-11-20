import { Link } from 'wouter';
import { IconSparkle, IconTrash } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { useBriefings, type Briefing } from '../lib/briefings';

function when(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Ungelesenes Briefing von heute oben in "Heute". */
export function BriefingCard() {
  const { list, markRead } = useBriefings();
  const latest = list.find((b) => !b.read && Date.now() - new Date(b.createdAt).getTime() < 36 * 3600_000);
  if (!latest) return null;
  return (
    <section className="card briefing" style={{ marginBottom: 18 }}>
      <BriefingBody b={latest} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => void markRead(latest.id)}>
          Gelesen
        </button>
        <Link href="/briefings" className="btn ghost small">
          Alle Briefings
        </Link>
      </div>
    </section>
  );
}

function BriefingBody({ b }: { b: Briefing }) {
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <IconSparkle size={16} />
        <strong>{b.title}</strong>
        <span className="small muted">
          {when(b.createdAt)}
          {b.source === 'claude' ? ' · von Claude' : ''}
        </span>
      </div>
      <Markdown text={b.body} />
    </>
  );
}

export function BriefingsView() {
  const { list, remove } = useBriefings();
  return (
    <div className="page">
      <div className="page-head">
        <h1>Briefings</h1>
        <span className="sub">Zusammenfassungen, die Claude für dich in Do-it gespeichert hat</span>
      </div>
      {!list.length && (
        <div className="empty">
          <div className="big">✨</div>
          Noch keine Briefings. Verbinde Claude in den <Link href="/settings">Einstellungen</Link> und lass dir jeden Morgen eine Zusammenfassung schreiben.
        </div>
      )}
      <div style={{ display: 'grid', gap: 12 }}>
        {list.map((b) => (
          <section key={b.id} className="card briefing">
            <BriefingBody b={b} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn" aria-label="Briefing löschen" onClick={() => void remove(b.id)}>
                <IconTrash size={16} />
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
