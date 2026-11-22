import type { Me, UserSettings } from '@do-it/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { DEFAULT_APPEARANCE, type Appearance } from '@do-it/shared';
import { ACCENTS, applyAppearance, STYLES } from '../lib/appearance';
import { updateSettings } from '../lib/views';
import { Segmented } from '../components/LayoutSwitch';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from '../lib/push';
import { toast } from '../lib/store';
import { sync, syncState, wipeLocalData } from '../lib/sync';
import { nowLocal, setTimeZone } from '../lib/time';
import {
  IconBell,
  IconCalendar,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconDone,
  IconDownload,
  IconFilter,
  IconFlag,
  IconInbox,
  IconNote,
  IconInfo,
  IconLeaf,
  IconLink,
  IconPalette,
  IconShield,
  IconTag,
  IconToday,
  IconUser,
  IconUsers,
  IconWarn,
} from '../components/Icons';
import { Sessions, TwoFactor } from './Security';
import { TodoistImport } from './TodoistImport';
import { ProfilePhoto } from '../components/AvatarEditor';
import { addDays, WEEKDAYS_SHORT } from '@do-it/shared';
import { refreshKarma } from '../lib/karma';
import { Dot, projectOptions, Select, type SelectOption } from '../components/Select';
import { startPath } from '../lib/start';

function zones(current: string): string[] {
  const fn = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = fn ? fn('timeZone') : ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  // Die eigene Zeitzone muss immer wählbar sein (z. B. "UTC" fehlt in manchen Browsern)
  return list.includes(current) ? list : [current, ...list];
}

interface Section {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  admin?: boolean;
}

const SECTIONS: Section[] = [
  { id: 'konto', title: 'Konto', desc: 'Profilbild, Name, Zeitzone', icon: <IconUser /> },
  { id: 'darstellung', title: 'Erscheinungsbild', desc: 'Startseite, Akzentfarbe, Hell/Dunkel', icon: <IconPalette /> },
  { id: 'benachrichtigungen', title: 'Benachrichtigungen', desc: 'Push, Morgen-Briefing, Erinnerungen', icon: <IconBell /> },
  { id: 'zeiten', title: 'Tageszeiten', desc: 'Was „früh“ oder „abends“ heißt', icon: <IconClock /> },
  { id: 'karma', title: 'Karma', desc: 'Ziele, freie Tage, Urlaub', icon: <IconLeaf /> },
  { id: 'verbindungen', title: 'Claude & Kalender', desc: 'Claude verbinden, Kalender-Abo', icon: <IconLink /> },
  { id: 'import', title: 'Import', desc: 'Aus Todoist übernehmen', icon: <IconDownload /> },
  { id: 'personen', title: 'Personen', desc: 'Neue Person einladen', icon: <IconUsers />, admin: true },
  { id: 'sicherheit', title: 'Sicherheit', desc: 'Passwort, Zwei-Faktor, Geräte', icon: <IconShield /> },
  { id: 'app', title: 'App & Hilfe', desc: 'Synchronisierung, Tastenkürzel', icon: <IconInfo /> },
];

export function SettingsView({ section }: { section?: string }) {
  const me = syncState.select((s) => s.me);
  if (!me) return null;
  const sections = SECTIONS.filter((s) => !s.admin || me.isAdmin);
  const active = sections.find((s) => s.id === section) ?? sections[0]!;
  return (
    <div className="page settings-page">
      <div className="page-head">
        <h1>Einstellungen</h1>
      </div>
      <div className={`settings-layout ${section ? 'has-section' : ''}`}>
        <nav className="settings-nav" aria-label="Bereiche der Einstellungen">
          {sections.map((s) => (
            <Link key={s.id} href={`/settings/${s.id}`} className={`settings-link ${s.id === active.id ? 'active' : ''}`} aria-current={s.id === active.id ? 'page' : undefined}>
              <span className="settings-link-icon">{s.icon}</span>
              <span className="settings-link-text">
                <span>{s.title}</span>
                <span className="settings-link-desc">{s.desc}</span>
              </span>
              <IconChevronRight size={16} className="settings-link-chevron" />
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          <Link href="/settings" className="settings-back">
            <IconChevronLeft size={16} /> Alle Einstellungen
          </Link>
          <h2 className="settings-title">{active.title}</h2>
          <SectionBody id={active.id} me={me} />
        </div>
      </div>
    </div>
  );
}

function SectionBody({ id, me }: { id: string; me: Me }) {
  switch (id) {
    case 'konto':
      return (
        <>
          <Profile me={me} key={`p-${me.name}-${me.timezone}`} />
          <Logout />
        </>
      );
    case 'darstellung':
      return (
        <>
          <StartPageSetting me={me} />
          <AppearanceSettings me={me} />
        </>
      );
    case 'benachrichtigungen':
      return <Notifications me={me} />;
    case 'zeiten':
      return <Times me={me} key={`t-${JSON.stringify(me.settings)}`} />;
    case 'karma':
      return <KarmaSettings me={me} key={`k-${JSON.stringify([me.settings.dailyGoal, me.settings.weeklyGoal])}`} />;
    case 'verbindungen':
      return (
        <>
          <ClaudeConnect />
          <Calendar />
        </>
      );
    case 'import':
      return <TodoistImport me={me} />;
    case 'personen':
      return <InviteAccount />;
    case 'sicherheit':
      return (
        <>
          <Password />
          <TwoFactor me={me} />
          <Sessions />
        </>
      );
    default:
      return <AppInfo />;
  }
}

function Logout() {
  const pending = syncState.select((s) => s.pending);
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Abmelden</strong>
      <span className="small muted">Meldet dieses Gerät ab und löscht die Daten auf diesem Gerät. Auf dem Server bleibt alles erhalten.</span>
      <div>
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
    </section>
  );
}

function AppInfo() {
  const { lastSync, pending, status } = syncState.use();
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Synchronisierung</strong>
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
      </div>
      <strong style={{ marginTop: 8 }}>Tastenkürzel</strong>
      <p className="small" style={{ margin: 0 }}>
        <kbd>Q</kbd> neue Aufgabe · <kbd>/</kbd> suchen · <kbd>Esc</kbd> schließen
      </p>
      <strong style={{ marginTop: 8 }}>Eingabe-Beispiele</strong>
      <p className="small muted" style={{ margin: 0 }}>
        „morgen 15 Uhr Zahnarzt #Gesundheit“, „jeden Montag 8 Uhr Müll +Ben“, „alle 3 Tage nach Erledigung Pflanzen gießen“, „Steuer bis Ende des Monats !1“,
        „Präsentation Freitag 10 Uhr, erinnere mich 1 Stunde vorher“, „Bericht morgen, Deadline Freitag“, „Meeting 14–15:30 Uhr“.
      </p>
    </section>
  );
}

const PREVIEW_LINES = [70, 45, 58];

/** Erscheinungsbild: Hell/Dunkel, Akzentfarbe, Stil, Ecken, Dichte, Schriftgröße */
/** Seite, die beim Öffnen der App erscheint */
function StartPageSetting({ me }: { me: Me }) {
  const data = useData();
  const { inbox, projects, labels } = data;
  const current = startPath(me.settings, data);
  const shared = syncState.select((s) => s.members.some((m) => m.userId !== me.id)) || me.settings.startPage === '/filter/mine';
  const options: SelectOption<string>[] = [
    { value: '/today', label: 'Heute', icon: <IconToday size={15} /> },
    ...(inbox ? [{ value: `/project/${inbox.id}`, label: 'Eingang', icon: <IconInbox size={15} /> }] : []),
    { value: '/upcoming', label: 'Demnächst', icon: <IconClock size={15} /> },
    { value: '/calendar', label: 'Kalender', icon: <IconCalendar size={15} /> },
    { value: '/notes', label: 'Notizen', icon: <IconNote size={15} /> },
    { value: '/done', label: 'Erledigt', icon: <IconDone size={15} /> },
    ...(me.settings.karmaEnabled ? [{ value: '/karma', label: 'Karma', icon: <IconLeaf size={15} /> }] : []),
    ...projectOptions(projects)
      .filter((o) => o.value !== inbox?.id)
      .map((o) => ({ ...o, value: `/project/${o.value}`, hint: o.depth ? undefined : 'Projekt' })),
    ...(me.settings.filters ?? []).map((f) => ({ value: `/f/${f.id}`, label: f.name, icon: f.color ? <Dot color={f.color} /> : <IconFilter size={15} />, hint: 'Filter' })),
    { value: '/filter/p1', label: 'Priorität 1', icon: <IconFlag size={15} />, hint: 'Filter' },
    { value: '/filter/deadline', label: 'Mit Deadline', icon: <IconFlag size={15} />, hint: 'Filter' },
    { value: '/filter/nodate', label: 'Ohne Datum', icon: <IconClock size={15} />, hint: 'Filter' },
    ...(shared ? [{ value: '/filter/mine', label: 'Mir zugewiesen', icon: <IconUser size={15} />, hint: 'Filter' }] : []),
    ...labels.map((l) => ({ value: `/label/${encodeURIComponent(l.name)}`, label: l.name, icon: <IconTag size={15} />, hint: 'Label' })),
  ];
  // gespeicherte Seite, die es nicht mehr gibt, nicht als leere Auswahl zeigen
  const value = options.some((o) => o.value === current) ? current : '/today';
  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Startseite</strong>
      <span className="small muted">Diese Seite erscheint, wenn du Do-it öffnest – auf allen deinen Geräten.</span>
      <Select label="Startseite" value={value} options={options} searchable onChange={(startPage) => void updateSettings({ startPage })} />
    </section>
  );
}

function AppearanceSettings({ me }: { me: Me }) {
  const a: Appearance = { ...DEFAULT_APPEARANCE, ...me.settings.appearance };
  const timer = useRef<number | null>(null);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';

  const set = (p: Partial<Appearance>, delay = 0) => {
    const next = { ...a, ...p };
    applyAppearance(next);
    syncState.set((s) => (s.me ? { ...s, me: { ...s.me, settings: { ...s.me.settings, appearance: next } } } : s));
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void updateSettings({ appearance: next }), delay);
  };
  const customColor = !ACCENTS.some((x) => x.color === a.accent.toLowerCase());

  return (
    <>
      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <strong>Hell oder dunkel</strong>
        <Segmented
          label="Hell oder dunkel"
          value={a.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'system', label: 'Wie das Gerät' },
            { value: 'light', label: 'Hell' },
            { value: 'dark', label: 'Dunkel' },
          ]}
        />
      </section>

      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <strong>Akzentfarbe</strong>
        <div className="swatch-row">
          {ACCENTS.map((c) => (
            <button
              key={c.color}
              className={`swatch ${a.accent.toLowerCase() === c.color ? 'on' : ''}`}
              style={{ background: c.color }}
              title={c.name}
              aria-label={`Akzentfarbe ${c.name}`}
              aria-pressed={a.accent.toLowerCase() === c.color}
              onClick={() => set({ accent: c.color })}
            >
              {a.accent.toLowerCase() === c.color && <IconCheck size={16} />}
            </button>
          ))}
          <label className={`swatch swatch-custom ${customColor ? 'on' : ''}`} title="Eigene Farbe" aria-label="Eigene Farbe wählen">
            <input type="color" value={a.accent} onChange={(e) => set({ accent: e.target.value }, 500)} />
          </label>
        </div>
        <div className="accent-preview">
          <button className="btn primary" tabIndex={-1}>
            Hinzufügen
          </button>
          <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
            Heute
          </span>
          <span className="check done" style={{ '--pc': 'var(--accent)' } as React.CSSProperties}>
            <IconCheck size={12} />
          </span>
          <span className="small" style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>
            Link in Akzentfarbe
          </span>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <strong>Stil</strong>
        <div className="appearance-grid">
          {STYLES.map((s) => {
            const [bg, side, surface] = dark ? s.dark : s.light;
            const line = dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)';
            return (
              <button key={s.value} className={`style-card ${a.style === s.value ? 'on' : ''}`} aria-pressed={a.style === s.value} onClick={() => set({ style: s.value })}>
                <span className="style-preview" style={{ background: bg }}>
                  <span className="pv-side" style={{ background: side }}>
                    <i style={{ background: 'var(--accent)', width: '70%' }} />
                    <i style={{ background: line, width: '85%' }} />
                    <i style={{ background: line, width: '60%' }} />
                  </span>
                  <span className="pv-main">
                    {PREVIEW_LINES.map((w, i) => (
                      <i key={i} style={{ background: i === 0 ? surface : line, width: `${w}%`, height: i === 0 ? 12 : 5, border: i === 0 ? `1px solid ${line}` : undefined }} />
                    ))}
                  </span>
                </span>
                <span>{s.name}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 14 }}>
        <div className="setting-row">
          <span>
            <strong>Ecken</strong>
            <span className="small muted"> – wie rund Knöpfe und Karten sind</span>
          </span>
          <Segmented
            label="Ecken"
            value={a.radius}
            onChange={(radius) => set({ radius })}
            options={[
              { value: 'square', label: 'Eckig' },
              { value: 'round', label: 'Rund' },
              { value: 'soft', label: 'Weich' },
            ]}
          />
        </div>
        <div className="setting-row">
          <span>
            <strong>Dichte</strong>
            <span className="small muted"> – Abstand in Listen</span>
          </span>
          <Segmented
            label="Dichte"
            value={a.density}
            onChange={(density) => set({ density })}
            options={[
              { value: 'comfortable', label: 'Bequem' },
              { value: 'compact', label: 'Kompakt' },
            ]}
          />
        </div>
        <div className="setting-row">
          <span>
            <strong>Schriftgröße</strong>
          </span>
          <Segmented
            label="Schriftgröße"
            value={a.textSize}
            onChange={(textSize) => set({ textSize })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Groß' },
            ]}
          />
        </div>
      </section>

      <div style={{ marginTop: 12 }}>
        <button className="btn ghost small" onClick={() => set(DEFAULT_APPEARANCE)}>
          Auf Standard zurücksetzen
        </button>
      </div>
    </>
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

async function saveMe(body: { name?: string; timezone?: string; settings?: Partial<UserSettings> }, opts: { quiet?: boolean } = {}) {
  const r = await api<{ user: Me }>('PATCH', '/api/me', body);
  syncState.set((s) => ({ ...s, me: r.user }));
  setTimeZone(r.user.timezone);
  if (!opts.quiet) toast('Gespeichert');
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
        <Select
          label="Automatische Erinnerung"
          block
          value={s.autoReminderMin === null ? 'off' : String(s.autoReminderMin)}
          options={[
            { value: 'off', label: 'Aus' },
            { value: '0', label: 'Zur Fälligkeit' },
            { value: '10', label: '10 Min. vorher' },
            { value: '15', label: '15 Min. vorher' },
            { value: '30', label: '30 Min. vorher' },
            { value: '60', label: '1 Std. vorher' },
          ]}
          onChange={(v) => void saveMe({ settings: { autoReminderMin: v === 'off' ? null : Number(v) } })}
        />
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
      <ProfilePhoto me={me} />
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Zeitzone</span>
          <Select label="Zeitzone" block searchable value={tz} options={zones(me.timezone).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} onChange={setTz} />
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

/** Karma: Ziele, freie Tage, Urlaub – oder ganz ausblenden. */
function KarmaSettings({ me }: { me: Me }) {
  const s = me.settings;
  const [daily, setDaily] = useState(String(s.dailyGoal));
  const [weekly, setWeekly] = useState(String(s.weeklyGoal));
  const today = nowLocal().date;
  const vacation = s.vacations.find((v) => v.to === null || v.to >= today) ?? null;
  // Schalter wirken sofort und sichtbar – dafür braucht es keine extra Meldung
  const save = async (settings: Partial<UserSettings>, quiet = true) => {
    try {
      await saveMe({ settings }, { quiet });
      void refreshKarma();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };
  const goalsChanged = Number(daily) !== s.dailyGoal || Number(weekly) !== s.weeklyGoal;
  const valid = Number(daily) >= 1 && Number(daily) <= 100 && Number(weekly) >= 1 && Number(weekly) <= 700;

  function toggleVacation() {
    if (vacation) {
      // Urlaub endet gestern; hat er heute erst begonnen, fällt er ganz weg
      const end = addDays(today, -1);
      const list = s.vacations.flatMap((v) => (v === vacation ? (v.from > end ? [] : [{ ...v, to: end }]) : [v]));
      void save({ vacations: list });
    } else {
      void save({ vacations: [...s.vacations, { from: today, to: null }].slice(-20) });
    }
  }

  return (
    <section id="karma" className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Karma</strong>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={s.karmaEnabled} onChange={(e) => void save({ karmaEnabled: e.target.checked })} />
        Karma anzeigen (Punkte, Stufen und Serien fürs Erledigen)
      </label>
      {s.karmaEnabled && (
        <>
          <div className="grid2">
            <label className="field">
              <span>Tagesziel (erledigte Aufgaben)</span>
              <input className="input" type="number" min={1} max={100} inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} />
            </label>
            <label className="field">
              <span>Wochenziel</span>
              <input className="input" type="number" min={1} max={700} inputMode="numeric" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
            </label>
          </div>
          {goalsChanged && (
            <div>
              <button className="btn primary" disabled={!valid} onClick={() => void save({ dailyGoal: Number(daily), weeklyGoal: Number(weekly) }, false)}>
                Ziele speichern
              </button>
            </div>
          )}
          <div className="field">
            <span className="small" style={{ fontWeight: 600, color: 'var(--muted)' }}>
              Freie Tage (unterbrechen keine Serie)
            </span>
            <div className="weekday-chips">
              {WEEKDAYS_SHORT.map((d, i) => {
                const day = i + 1;
                const on = s.daysOff.includes(day);
                return (
                  <button
                    key={d}
                    className={`chip ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    disabled={!on && s.daysOff.length >= 6}
                    onClick={() => void save({ daysOff: on ? s.daysOff.filter((x) => x !== day) : [...s.daysOff, day].sort() })}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn" onClick={toggleVacation}>
              {vacation ? 'Urlaub beenden' : 'Urlaub starten'}
            </button>
            <span className="small muted">
              {vacation ? `Im Urlaub seit ${new Date(`${vacation.from}T12:00:00`).toLocaleDateString('de-DE')} – deine Serie pausiert.` : 'Im Urlaub pausiert deine Serie.'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
