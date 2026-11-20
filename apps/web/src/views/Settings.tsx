import type { Me, UserSettings } from '@do-it/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { applyImport, planTodoistImport, type ImportPlan } from '../lib/todoist';
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from '../lib/push';
import { toast } from '../lib/store';
import { sync, syncState, wipeLocalData } from '../lib/sync';
import { nowLocal, setTimeZone } from '../lib/time';
import { IconWarn } from '../components/Icons';
import { Sessions, TwoFactor } from './Security';

function zones(current: string): string[] {
  const fn = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = fn ? fn('timeZone') : ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  // Die eigene Zeitzone muss immer wählbar sein (z. B. "UTC" fehlt in manchen Browsern)
  return list.includes(current) ? list : [current, ...list];
}

export function SettingsView() {
  const { me, lastSync, pending, status } = syncState.use();
  if (!me) return null;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Einstellungen</h1>
      </div>
      <Notifications me={me} />
      <ClaudeConnect />
      <Profile me={me} key={`p-${me.name}-${me.timezone}`} />
      <Times me={me} key={`t-${JSON.stringify(me.settings)}`} />
      <Calendar />
      {me.isAdmin && <InviteAccount />}
      <TodoistImport me={me} />
      <Password />
      <TwoFactor me={me} />
      <Sessions />
      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        <strong>App</strong>
        <span className="small muted">
          Status: {status === 'offline' ? 'offline' : status === 'error' ? 'Fehler' : 'verbunden'}
          {lastSync && ` · zuletzt synchronisiert ${new Date(lastSync).toLocaleTimeString('de-DE')}`}
          {pending > 0 && ` · ${pending} Änderungen warten`}
        </span>
        <div className="row">
          <button className="btn" onClick={() => void sync.sync()}>
            Jetzt synchronisieren
          </button>
          <button className="btn" onClick={() => void sync.resync().then(() => toast('Alles neu geladen'))}>
            Alles neu laden
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (pending && !confirm(`${pending} Änderungen sind noch nicht übertragen. Trotzdem abmelden?`)) return;
              await disablePush().catch(() => {});
              await api('POST', '/api/auth/logout').catch(() => {});
              await wipeLocalData();
              location.href = '/';
            }}
          >
            Abmelden
          </button>
        </div>
        <details className="small">
          <summary>Tastenkürzel und Eingabe-Tipps</summary>
          <p>
            <kbd>Q</kbd> neue Aufgabe · <kbd>/</kbd> suchen · <kbd>Esc</kbd> schließen
          </p>
          <p className="muted">
            Beispiele: „morgen 15 Uhr Zahnarzt #Gesundheit“, „jeden Montag 8 Uhr Müll +Ben“, „alle 3 Tage nach Erledigung Pflanzen gießen“, „Steuer bis Ende des Monats !1“,
            „Präsentation Freitag 10 Uhr, erinnere mich 1 Stunde vorher“, „Bad putzen samstags abwechselnd Anna und Ben“.
          </p>
        </details>
      </section>
    </div>
  );
}

function Notifications({ me }: { me: Me }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  const iosNeedsInstall = isIos() && !isStandalone();

  useEffect(() => {
    void currentSubscription().then((s) => setEnabled(!!s && Notification.permission === 'granted'));
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
      } else {
        await enablePush();
        setEnabled(true);
        toast('Benachrichtigungen sind an');
      }
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    const r = await api<{ delivered: number }>('POST', '/api/push/test');
    toast(r.delivered ? `Test an ${r.delivered} Gerät(e) gesendet` : 'Kein Gerät erreicht', { kind: r.delivered ? 'info' : 'error' });
  }

  return (
    <section className="card" style={{ display: 'grid', gap: 10 }}>
      <strong>Benachrichtigungen auf diesem Gerät</strong>
      {iosNeedsInstall ? (
        <div className="hint">
          Auf dem iPad/iPhone gibt es Benachrichtigungen nur für installierte Web-Apps: Tippe in Safari auf <b>Teilen</b> → <b>Zum Home-Bildschirm</b>, öffne Do-it dann vom
          Home-Bildschirm und schalte hier die Benachrichtigungen ein.
        </div>
      ) : !supported ? (
        <div className="hint">Dieser Browser unterstützt keine Push-Benachrichtigungen.</div>
      ) : (
        <div className="row">
          <button className={`btn ${enabled ? '' : 'primary'}`} disabled={busy || enabled === null} onClick={() => void toggle()}>
            {enabled ? 'Ausschalten' : 'Benachrichtigungen einschalten'}
          </button>
          {enabled && (
            <button className="btn" onClick={() => void test()}>
              Test senden
            </button>
          )}
        </div>
      )}
      <BriefingSettings me={me} key={JSON.stringify(me.settings)} />
    </section>
  );
}

async function saveMe(body: { name?: string; timezone?: string; settings?: Partial<UserSettings> }) {
  const r = await api<{ user: Me }>('PATCH', '/api/me', body);
  syncState.set((s) => ({ ...s, me: r.user }));
  setTimeZone(r.user.timezone);
  toast('Gespeichert');
}

function BriefingSettings({ me }: { me: Me }) {
  const s = me.settings;
  return (
    <div className="grid2">
      <label className="field">
        <span>Morgen-Briefing</span>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={s.briefingEnabled} onChange={(e) => void saveMe({ settings: { briefingEnabled: e.target.checked } })} />
          <input className="input" type="time" value={s.briefingTime} disabled={!s.briefingEnabled} onChange={(e) => e.target.value && void saveMe({ settings: { briefingTime: e.target.value } })} />
        </div>
      </label>
      <label className="field">
        <span>Automatische Erinnerung bei Uhrzeit</span>
        <select className="input" value={s.autoReminderMin ?? 'off'} onChange={(e) => void saveMe({ settings: { autoReminderMin: e.target.value === 'off' ? null : Number(e.target.value) } })}>
          <option value="off">Aus</option>
          <option value="0">Zur Fälligkeit</option>
          <option value="10">10 Min. vorher</option>
          <option value="30">30 Min. vorher</option>
          <option value="60">1 Std. vorher</option>
        </select>
      </label>
    </div>
  );
}

function Profile({ me }: { me: Me }) {
  const [name, setName] = useState(me.name);
  const [tz, setTz] = useState(me.timezone);
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Profil</strong>
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Zeitzone</span>
          <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones(me.timezone).map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
      </div>
      <span className="small muted">{me.email}</span>
      <div>
        <button className="btn primary" disabled={name === me.name && tz === me.timezone} onClick={() => void saveMe({ name, timezone: tz })}>
          Speichern
        </button>
      </div>
    </section>
  );
}

const TIME_FIELDS: [keyof UserSettings, string][] = [
  ['morningTime', 'morgens / früh'],
  ['noonTime', 'mittags'],
  ['afternoonTime', 'nachmittags'],
  ['eveningTime', 'abends'],
  ['nightTime', 'nachts'],
  ['workEndTime', 'nach Feierabend'],
];

function Times({ me }: { me: Me }) {
  const [vals, setVals] = useState(me.settings);
  const changed = TIME_FIELDS.some(([k]) => vals[k] !== me.settings[k]);
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Deine Tageszeiten</strong>
      <span className="small muted">So versteht Do-it Wörter wie „abends“ oder „nach Feierabend“. „morgens“ gilt auch für ganztägige Erinnerungen.</span>
      <div className="grid2">
        {TIME_FIELDS.map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <input className="input" type="time" value={String(vals[k])} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div>
        <button
          className="btn primary"
          disabled={!changed}
          onClick={() => void saveMe({ settings: Object.fromEntries(TIME_FIELDS.map(([k]) => [k, vals[k]])) as Partial<UserSettings> })}
        >
          Speichern
        </button>
      </div>
    </section>
  );
}

function Calendar() {
  const [url, setUrl] = useState<string | null>(null);
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Kalender-Abo</strong>
      <span className="small muted">Zeigt deine Aufgaben mit Datum in Google, Apple oder Thunderbird Kalender an (nur lesend). Wer den Link kennt, sieht die Aufgaben.</span>
      {url && <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} />}
      <div className="row">
        <button className="btn" onClick={() => void api<{ url: string }>('POST', '/api/me/ical').then((r) => setUrl(r.url))}>
          {url ? 'Neuen Link erzeugen' : 'Link erzeugen'}
        </button>
        <button
          className="btn ghost"
          onClick={() =>
            void api('DELETE', '/api/me/ical').then(() => {
              setUrl(null);
              toast('Kalender-Link deaktiviert');
            })
          }
        >
          Deaktivieren
        </button>
      </div>
    </section>
  );
}

function InviteAccount() {
  const [url, setUrl] = useState<string | null>(null);
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Neue Person einladen</strong>
      <span className="small muted">Erzeugt einen Link (7 Tage, einmalig), mit dem sich jemand ein Konto anlegen kann. Projekte teilst du danach in den Projekt-Einstellungen.</span>
      {url && (
        <div className="row">
          <input className="input" readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <button
            className="btn primary"
            onClick={() => {
              if (navigator.share) void navigator.share({ title: 'Einladung zu Do-it', url }).catch(() => {});
              else void navigator.clipboard.writeText(url).then(() => toast('Link kopiert'));
            }}
          >
            Teilen
          </button>
        </div>
      )}
      <div>
        <button className="btn" onClick={() => void api<{ url: string }>('POST', '/api/invites', {}).then((r) => setUrl(r.url))}>
          Einladungslink erstellen
        </button>
      </div>
    </section>
  );
}

const BRIEFING_PROMPT =
  'Nutze den Do-it-Konnektor: Rufe get_overview auf und schreibe mir ein kurzes, freundliches Tagesbriefing auf Deutsch (höchstens 12 Zeilen): ' +
  'Termine heute mit Uhrzeit, Überfälliges, was in den nächsten Tagen ansteht, was gestern erledigt wurde und höchstens drei Prioritäten für heute. ' +
  'Speichere es mit post_briefing.';

interface Connection {
  id: string;
  kind: 'oauth' | 'token';
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast(`${what} kopiert`))
    .catch(() => toast('Kopieren nicht möglich – bitte markieren und kopieren', { kind: 'error' }));
}

function ClaudeConnect() {
  const [data, setData] = useState<{ mcpUrl: string; connections: Connection[] } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const load = () => void api<{ mcpUrl: string; connections: Connection[] }>('GET', '/api/connections').then(setData).catch(() => {});
  useEffect(load, []);
  const url = data?.mcpUrl ?? `${location.origin}/mcp`;

  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Claude</strong>
      <span className="small muted">
        Verbinde Claude mit Do-it. Dann kann Claude deine Aufgaben lesen, neue anlegen, abhaken und dir Zusammenfassungen schreiben, die hier unter „Briefings“ und als
        Benachrichtigung ankommen.
      </span>
      <div className="row">
        <input className="input" readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.target.select()} aria-label="Konnektor-Adresse" />
        <button className="btn" onClick={() => copy(url, 'Adresse')}>
          Kopieren
        </button>
      </div>
      <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
        <li>
          In Claude (Web, Desktop oder App): <b>Einstellungen → Konnektoren → Benutzerdefinierten Konnektor hinzufügen</b>, Name „Do-it“, diese Adresse einfügen.
        </li>
        <li>Auf „Verbinden“ klicken und in Do-it die Freigabe mit „Erlauben“ bestätigen.</li>
        <li>
          Für die tägliche Zusammenfassung in Claude eine geplante Aufgabe anlegen (z. B. jeden Morgen um 7 Uhr) mit diesem Auftrag:{' '}
          <button className="btn ghost small" style={{ minHeight: 0, padding: '0 6px' }} onClick={() => copy(BRIEFING_PROMPT, 'Auftrag')}>
            Auftrag kopieren
          </button>
        </li>
      </ol>
      <details className="small">
        <summary>Claude Code oder andere Programme (Zugangsschlüssel)</summary>
        <p className="muted">Claude Code kann sich ebenfalls per Freigabe verbinden. Alternativ geht es mit einem persönlichen Schlüssel:</p>
        {token ? (
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="hint">Dieser Schlüssel wird nur jetzt angezeigt. Er gewährt vollen Zugriff auf deine Aufgaben.</div>
            <code style={{ wordBreak: 'break-all' }}>{`claude mcp add --transport http do-it ${url} --header "Authorization: Bearer ${token}"`}</code>
            <div>
              <button className="btn" onClick={() => copy(`claude mcp add --transport http do-it ${url} --header "Authorization: Bearer ${token}"`, 'Befehl')}>
                Befehl kopieren
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn"
            onClick={() =>
              void api<{ token: string }>('POST', '/api/tokens', { name: 'Claude Code' }).then((r) => {
                setToken(r.token);
                load();
              })
            }
          >
            Schlüssel erstellen
          </button>
        )}
      </details>
      {data && data.connections.length > 0 && (
        <>
          <strong className="small">Verbunden</strong>
          <ul className="list-plain small">
            {data.connections.map((c) => (
              <li key={c.id}>
                <span style={{ flex: 1 }}>
                  {c.name} <span className="muted">· {c.kind === 'oauth' ? 'Freigabe' : 'Schlüssel'}</span>
                  <span className="muted">
                    {' '}
                    · zuletzt {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'nie'} genutzt
                  </span>
                </span>
                <button
                  className="btn ghost small danger"
                  onClick={() => {
                    if (confirm(`Verbindung „${c.name}“ trennen?`)) void api('DELETE', `/api/connections/${c.id}`).then(load);
                  }}
                >
                  Trennen
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TodoistImport({ me }: { me: Me }) {
  const { projects, labels, inbox } = useData();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    const files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    const now = nowLocal();
    setPlan(planTodoistImport(files, { today: now.date, now: now.time }));
  }

  async function run() {
    if (!plan || !inbox) return;
    setProgress('0');
    const batch: { type: Parameters<typeof sync.mutateMany>[0][number]['type']; id: string; data: Record<string, unknown> }[] = [];
    await applyImport(plan, {
      me,
      inboxId: inbox.id,
      existingProjects: projects,
      existingLabels: labels.map((l) => l.name),
      mutate: async (type, id, data) => void batch.push({ type, id, data }),
    });
    for (let i = 0; i < batch.length; i += 500) {
      await sync.mutateMany(batch.slice(i, i + 500));
      setProgress(`${Math.min(i + 500, batch.length)} / ${batch.length}`);
    }
    toast(`${plan.taskCount} Aufgaben aus Todoist übernommen`);
    setPlan(null);
    setProgress(null);
  }

  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Aus Todoist übernehmen</strong>
      <span className="small muted">
        In Todoist unter Einstellungen → Backups ein Backup herunterladen und entpacken. Dann hier alle CSV-Dateien auf einmal auswählen. Gleichnamige Projekte werden ergänzt, „Inbox“ landet im Eingang.
      </span>
      <input type="file" accept=".csv,text/csv" multiple onChange={(e) => void onFiles(e.target.files)} />
      {plan && (
        <div className="hint" style={{ display: 'grid', gap: 6 }}>
          <span>
            {plan.projects.length} Projekte · {plan.taskCount} Aufgaben · {plan.commentCount} Kommentare
          </span>
          {plan.warnings.slice(0, 5).map((w) => (
            <span key={w} className="small row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <IconWarn size={14} /> {w}
            </span>
          ))}
          {plan.warnings.length > 5 && <span className="small">… und {plan.warnings.length - 5} weitere Hinweise</span>}
          <div className="row">
            <button className="btn primary" disabled={!!progress || !plan.taskCount} onClick={() => void run()}>
              {progress ? `Übernehme … ${progress}` : 'Jetzt übernehmen'}
            </button>
            <button className="btn ghost" disabled={!!progress} onClick={() => setPlan(null)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Passwort ändern</strong>
      <div className="grid2">
        <input className="input" type="password" autoComplete="current-password" placeholder="Aktuelles Passwort" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input" type="password" autoComplete="new-password" placeholder="Neues Passwort (mind. 8 Zeichen)" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div>
        <button
          className="btn"
          disabled={!current || next.length < 8}
          onClick={() =>
            void api('POST', '/api/me/password', { current, next })
              .then(() => {
                setCurrent('');
                setNext('');
                toast('Passwort geändert. Andere Geräte wurden abgemeldet.');
              })
              .catch((e: Error) => toast(e.message, { kind: 'error' }))
          }
        >
          Ändern
        </button>
      </div>
    </section>
  );
}
