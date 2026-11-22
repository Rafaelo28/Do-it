import type { Me } from '@do-it/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Redirect, Route, Switch, useLocation, useSearch } from 'wouter';
import { IconMenu, IconPlus } from './components/Icons';
import { QuickAdd } from './components/QuickAdd';
import { Sidebar } from './components/Sidebar';
import { Modal, Toasts } from './components/ui';
import { api, setUnauthorizedHandler } from './lib/api';
import { DataProvider, useData } from './lib/data';
import { db } from './lib/db';
import { toast } from './lib/store';
import { sync, syncState, wipeLocalData } from './lib/sync';
import { isStandalone } from './lib/push';
import { LAUNCH_PATH, startPath } from './lib/start';
import { setTimeZone } from './lib/time';
import { AuthView } from './views/Auth';
import { BriefingsView } from './views/Briefings';
import { DoneView } from './views/Done';
import { KarmaView } from './views/Karma';
import { CustomFilterView } from './views/CustomFilter';
import { startKarmaUpdates } from './lib/karma';
import { startAppearance } from './lib/appearance';
import { FilterView, LabelView, SearchView } from './views/Lists';
import { ProjectView } from './views/ProjectView';
import { TaskDetail } from './views/TaskDetail';
import { TodayView, UpcomingView } from './views/Today';

const SettingsView = lazy(() => import('./views/Settings').then((m) => ({ default: m.SettingsView })));
const CalendarPage = lazy(() => import('./views/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const NotesPage = lazy(() => import('./views/Notes').then((m) => ({ default: m.NotesPage })));

type Phase = 'loading' | 'setup' | 'login' | 'ready';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  useEffect(() => startAppearance(), []);
  const [location, navigate] = useLocation();
  const search = useSearch();

  async function start(me: Me) {
    const cached = await db.getMeta<Me>('me');
    if (cached && cached.id !== me.id) {
      // anderer Nutzer auf diesem Gerät: alte Daten verwerfen
      await wipeLocalData();
      location === '/' ? window.location.reload() : (window.location.href = '/');
      return;
    }
    setTimeZone(me.timezone);
    syncState.set((s) => ({ ...s, me }));
    await db.setMeta('me', me);
    void sync.start();
    setPhase('ready');
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      sync.stop();
      setPhase('login');
    });
    (async () => {
      try {
        const s = await api<{ setupRequired: boolean; user: Me | null }>('GET', '/api/auth/status');
        if (s.setupRequired) return setPhase('setup');
        if (s.user) return void (await start(s.user));
        setPhase('login');
      } catch {
        // Offline: mit den lokalen Daten weiterarbeiten
        const me = await db.getMeta<Me>('me');
        if (me) await start(me);
        else setPhase('login');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invite = /^\/invite\/([\w-]+)/.exec(location)?.[1];

  if (phase === 'loading') return <div className="auth muted">Lade …</div>;
  if (phase === 'setup') return <AuthView mode="setup" onDone={(me) => void start(me).then(() => navigate('/'))} />;
  if (phase === 'login') {
    if (invite) return <AuthView mode="register" token={invite} onDone={(me) => void start(me).then(() => navigate('/'))} />;
    const next = new URLSearchParams(search).get('next');
    return (
      <AuthView
        mode="login"
        onDone={(me) =>
          void start(me).then(() => {
            // Freigabe für Claude o. Ä.: zurück zur Server-Seite (keine App-Route)
            if (next?.startsWith('/oauth/')) window.location.href = next;
            else if (next?.startsWith('/')) navigate(next);
            else if (location === '/login' || location === '/') navigate('/', { replace: true });
          })
        }
      />
    );
  }
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  );
}

let launchHandled = false;

/** "/" führt zur gewählten Startseite (Einstellungen → Erscheinungsbild) */
function StartRedirect() {
  const data = useData();
  const settings = syncState.select((s) => s.me?.settings);
  const synced = syncState.select((s) => s.ready || s.status === 'offline' || s.status === 'error');
  // Auf einem neuen Gerät kommen Projekte und Filter erst mit der ersten Synchronisierung:
  // so lange warten, statt gleich auf "Heute" auszuweichen
  const [giveUp, setGiveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGiveUp(true), synced ? 400 : 5000);
    return () => clearTimeout(t);
  }, [synced]);
  if (!data.loaded) return null;
  const target = startPath(settings, data);
  if (target !== (settings?.startPage ?? '/today') && !giveUp) return <div className="page muted">Lade …</div>;
  return <Redirect to={target} replace />;
}

function Shell() {
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const projectId = /^\/project\/([\w-]+)/.exec(location)?.[1];

  useEffect(() => startKarmaUpdates(), []);

  // Als App vom Startbildschirm geöffnet, aber noch mit der alten Startadresse "/today":
  // einmalig zur gewählten Startseite wechseln
  const data = useData();
  useEffect(() => {
    if (!data.loaded || launchHandled) return;
    launchHandled = true;
    if (LAUNCH_PATH !== '/today' || location !== '/today' || !isStandalone()) return;
    const target = startPath(syncState.get().me?.settings, data);
    if (target !== '/today') navigate(target, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loaded]);

  useEffect(() => {
    if (new URLSearchParams(search).get('add') === '1') {
      setAdding('');
      navigate(location, { replace: true });
    }
  }, [search, location, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'q' || e.key === 'n') {
        e.preventDefault();
        setAdding('');
      } else if (e.key === '/') {
        e.preventDefault();
        navigate('/search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="app">
      <Sidebar open={menu} onNavigate={() => setMenu(false)} />
      <div className={`scrim ${menu ? 'open' : ''}`} onClick={() => setMenu(false)} />
      <main>
        <div className="topbar">
          <button className="icon-btn" aria-label="Menü" onClick={() => setMenu(true)}>
            <IconMenu />
          </button>
          <span className="title">Do-it</span>
        </div>
        <Switch>
          <Route path="/">
            <StartRedirect />
          </Route>
          <Route path="/today" component={TodayView} />
          <Route path="/upcoming" component={UpcomingView} />
          <Route path="/search" component={SearchView} />
          <Route path="/settings/:section?">
            {(p) => (
              <Suspense fallback={<div className="page muted">Lade …</div>}>
                <SettingsView section={p.section} />
              </Suspense>
            )}
          </Route>
          <Route path="/project/:id">{(p) => <ProjectView id={p.id} key={p.id} />}</Route>
          <Route path="/label/:name">{(p) => <LabelView name={decodeURIComponent(p.name)} />}</Route>
          <Route path="/task/:id">{(p) => <TaskDetail id={p.id} />}</Route>
          <Route path="/briefings" component={BriefingsView} />
          <Route path="/done" component={DoneView} />
          <Route path="/karma" component={KarmaView} />
          <Route path="/calendar">
            <Suspense fallback={<div className="page muted">Lade …</div>}>
              <CalendarPage />
            </Suspense>
          </Route>
          <Route path="/notes/:id?">
            {(p) => (
              <Suspense fallback={<div className="page muted">Lade …</div>}>
                <NotesPage id={p.id} />
              </Suspense>
            )}
          </Route>
          <Route path="/f/:id">{(p) => <CustomFilterView id={p.id} key={p.id} />}</Route>
          <Route path="/filter/:name">{(p) => <FilterView name={p.name} />}</Route>
          <Route path="/invite/:token">{(p) => <InviteAccept token={p.token} />}</Route>
          <Route path="/share">
            <ShareTarget onOpen={setAdding} />
          </Route>
          <Route>
            <StartRedirect />
          </Route>
        </Switch>
      </main>
      <button className="fab" aria-label="Neue Aufgabe" onClick={() => setAdding('')}>
        <IconPlus size={26} />
      </button>
      {adding !== null && (
        <Modal onClose={() => setAdding(null)} label="Neue Aufgabe">
          <QuickAdd autoFocus initialText={adding} projectId={projectId} onDone={() => setAdding(null)} />
        </Modal>
      )}
      <Toasts />
    </div>
  );
}

function InviteAccept({ token }: { token: string }) {
  const [, navigate] = useLocation();
  const [info, setInfo] = useState<{ valid: boolean; invitedBy?: string; projectName?: string | null } | null>(null);
  useEffect(() => {
    api<{ valid: boolean; invitedBy?: string; projectName?: string | null }>('GET', `/api/invites/${token}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);
  async function accept() {
    try {
      const r = await api<{ projectId: string }>('POST', `/api/invites/${token}/accept`);
      await sync.sync();
      navigate(`/project/${r.projectId}`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }
  return (
    <div className="page">
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <h1>Einladung</h1>
        {!info ? (
          <span className="muted">Lade …</span>
        ) : !info.valid || !info.projectName ? (
          <span className="error-text">Diese Einladung ist ungültig, abgelaufen oder schon benutzt.</span>
        ) : (
          <>
            <p>
              {info.invitedBy} lädt dich zum Projekt <b>„{info.projectName}“</b> ein.
            </p>
            <div>
              <button className="btn primary" onClick={() => void accept()}>
                Annehmen
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Ziel für "Teilen → Do-it" auf Android: geteilter Text wird zur neuen Aufgabe. */
function ShareTarget({ onOpen }: { onOpen: (text: string) => void }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  useEffect(() => {
    const p = new URLSearchParams(search);
    const text = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    navigate('/today', { replace: true });
    onOpen(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
