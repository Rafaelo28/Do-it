import { formatDateLong, KARMA_LEVELS, KARMA_RULES } from '@do-it/shared';
import { useEffect } from 'react';
import { Link } from 'wouter';
import { Avatar } from '../components/Avatar';
import { IconCheckCircle, IconFlame, IconSparkle } from '../components/Icons';
import { karmaState, refreshKarma } from '../lib/karma';
import { syncState } from '../lib/sync';

/** Kreis-Fortschritt mit Stufenzahl in der Mitte */
function Ring({ progress, level }: { progress: number; level: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <svg className="karma-ring" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label={`Stufe ${level}, ${Math.round(progress * 100)} Prozent bis zur nächsten`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${c * progress} ${c}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="56" textAnchor="middle" className="karma-ring-label">
        Stufe
      </text>
      <text x="60" y="82" textAnchor="middle" className="karma-ring-level">
        {level}
      </text>
    </svg>
  );
}

function Bar({ value, goal }: { value: number; goal: number }) {
  return (
    <div className="karma-bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={value}>
      <span style={{ width: `${Math.min(100, (value / Math.max(1, goal)) * 100)}%` }} />
    </div>
  );
}

const KIND_TEXT = { done: 'Erledigt', daily_goal: 'Tagesziel', weekly_goal: 'Wochenziel' } as const;

export function KarmaView() {
  const k = karmaState.use();
  const me = syncState.select((s) => s.me);
  useEffect(() => void refreshKarma(), []);

  if (!k || !me) return <div className="page muted">Lade …</div>;
  if (!k.enabled) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Karma</h1>
        </div>
        <p className="muted">
          Karma ist ausgeschaltet. In den <Link href="/settings/karma">Einstellungen</Link> kannst du es wieder einschalten – gesammelte Punkte bleiben erhalten.
        </p>
      </div>
    );
  }
  const max = Math.max(k.today.goal, ...k.days.map((d) => d.done), 1);
  const toNext = k.level.next ? k.level.next.min - k.points : 0;

  return (
    <div className="page karma">
      <div className="page-head">
        <h1>Karma</h1>
        <span className="sub">{k.points.toLocaleString('de-DE')} Punkte</span>
      </div>

      <section className="card karma-hero">
        <Ring progress={k.level.progress} level={k.level.level} />
        <div className="karma-hero-text">
          <div className="row" style={{ gap: 10 }}>
            <Avatar name={me.name} src={me.avatar} size={28} seed={me.id} />
            <strong className="karma-level-name">{k.level.name}</strong>
          </div>
          <span className="muted">
            {k.level.next
              ? `Noch ${toNext.toLocaleString('de-DE')} ${toNext === 1 ? 'Punkt' : 'Punkte'} bis ${k.level.next.name} (Stufe ${k.level.next.level})`
              : 'Höchste Stufe erreicht. Respekt!'}
          </span>
          <ol className="karma-path" aria-label="Stufen">
            {KARMA_LEVELS.map((l) => (
              <li key={l.level} className={l.level < k.level.level ? 'past' : l.level === k.level.level ? 'now' : ''} title={`${l.name} ab ${l.min.toLocaleString('de-DE')} Punkten`} />
            ))}
          </ol>
        </div>
      </section>

      <div className="karma-grid">
        <section className="card karma-stat">
          <span className="small muted">Heute</span>
          <strong>
            {k.today.done} von {k.today.goal}
          </strong>
          <Bar value={k.today.done} goal={k.today.goal} />
          <span className="small muted">{k.today.reached ? 'Tagesziel geschafft' : `Noch ${k.today.goal - k.today.done} bis zum Tagesziel`}</span>
        </section>
        <section className="card karma-stat">
          <span className="small muted">Diese Woche</span>
          <strong>
            {k.week.done} von {k.week.goal}
          </strong>
          <Bar value={k.week.done} goal={k.week.goal} />
          <span className="small muted">{k.week.reached ? 'Wochenziel geschafft' : `Noch ${k.week.goal - k.week.done} bis zum Wochenziel`}</span>
        </section>
        <section className="card karma-stat">
          <span className="small muted">Serie</span>
          <strong className="row" style={{ gap: 6 }}>
            <IconFlame size={18} /> {k.streak.current} {k.streak.current === 1 ? 'Tag' : 'Tage'}
          </strong>
          <span className="small muted">Rekord: {k.streak.best} {k.streak.best === 1 ? 'Tag' : 'Tage'}</span>
          <span className="small muted">Tage mit erreichtem Tagesziel in Folge</span>
        </section>
      </div>

      <section className="card">
        <strong>Die letzten 4 Wochen</strong>
        <div className="karma-chart" role="img" aria-label="Erledigte Aufgaben pro Tag in den letzten 28 Tagen">
          <div className="goal-line" style={{ bottom: `${(k.today.goal / max) * 100}%` }} title={`Tagesziel: ${k.today.goal}`} />
          {k.days.map((d) => (
            <div key={d.date} className={`day ${d.goal ? 'goal' : ''} ${d.rest ? 'rest' : ''}`} title={`${formatDateLong(d.date)}: ${d.done} erledigt, ${d.points} Punkte`}>
              <span style={{ height: `${(d.done / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="karma-axis small muted">
          {k.days.map((d, i) => (
            <span key={d.date}>{(k.days.length - 1 - i) % 7 === 0 ? (i === k.days.length - 1 ? 'heute' : `${Number(d.date.slice(8))}.${Number(d.date.slice(5, 7))}.`) : ''}</span>
          ))}
        </div>
      </section>

      <div className="karma-grid two">
        <section className="card">
          <strong>Zuletzt</strong>
          {!k.recent.length && <p className="small muted">Noch nichts. Hake deine erste Aufgabe ab!</p>}
          <ul className="karma-events">
            {k.recent.map((e, i) => (
              <li key={i}>
                <span className="karma-points">+{e.points}</span>
                <span className="karma-event-text">
                  {e.kind === 'done' ? (e.title ?? 'Aufgabe') : (e.title ?? KIND_TEXT[e.kind])}
                  <span className="small muted"> · {new Date(e.at).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card karma-rules">
          <strong>So wächst dein Karma</strong>
          <ul>
            <li>
              <IconCheckCircle size={16} /> Aufgabe erledigt: +{KARMA_RULES.done} (Unteraufgabe +{KARMA_RULES.subtask})
            </li>
            <li>
              <IconCheckCircle size={16} /> Priorität 1 / 2 / 3: +{KARMA_RULES.priority[1]} / +{KARMA_RULES.priority[2]} / +{KARMA_RULES.priority[3]}
            </li>
            <li>
              <IconCheckCircle size={16} /> Pünktlich (spätestens am Fälligkeitstag): +{KARMA_RULES.onTime}
            </li>
            <li>
              <IconSparkle size={16} /> Tagesziel: +{KARMA_RULES.dailyGoal}, dazu +1 je Tag Serie (bis +{KARMA_RULES.streakMax})
            </li>
            <li>
              <IconSparkle size={16} /> Wochenziel: +{KARMA_RULES.weeklyGoal}
            </li>
          </ul>
          <span className="small muted">
            Wieder geöffnete Aufgaben geben ihre Punkte zurück. Freie Tage und Urlaub unterbrechen keine Serie. Ziele und freie Tage stellst du in den{' '}
            <Link href="/settings/karma">Einstellungen</Link> ein.
          </span>
        </section>
      </div>
    </div>
  );
}
