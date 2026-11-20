import type { Me } from '@do-it/shared';
import { useEffect, useState } from 'react';
import { Redirect, Route, Switch, useLocation, useSearch } from 'wouter';
import { IconMenu, IconPlus } from './components/Icons';
import { QuickAdd } from './components/QuickAdd';
import { Sidebar } from './components/Sidebar';
import { Modal, Toasts } from './components/ui';
import { api, setUnauthorizedHandler } from './lib/api';
import { DataProvider } from './lib/data';
import { db } from './lib/db';
import { toast } from './lib/store';
import { sync, syncState, wipeLocalData } from './lib/sync';
import { setTimeZone } from './lib/time';
import { AuthView } from './views/Auth';
import { FilterView, LabelView, SearchView } from './views/Lists';
import { ProjectView } from './views/ProjectView';
import { SettingsView } from './views/Settings';
import { TaskDetail } from './views/TaskDetail';
import { TodayView, UpcomingView } from './views/Today';

type Phase = 'loading' | 'setup' | 'login' | 'ready';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [location, navigate] = useLocation();
  const search = useSearch();

  async function start(me: Me) {
    const cached = await db.getMeta<Me>('me');
    if (cached && cached.id !== me.id) {
      // anderer Nutzer auf diesem Gerät: alte Daten verwerfen
      await wipeLocalData();
      location === '/' ? window.location.reload() : (window.location.href = '/today');
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
  if (phase === 'setup') return <AuthView mode="setup" onDone={(me) => void start(me).then(() => navigate('/today'))} />;
  if (phase === 'login') {
    if (invite) return <AuthView mode="register" token={invite} onDone={(me) => void start(me).then(() => navigate('/today'))} />;
    const next = new URLSearchParams(search).get('next');
    return (
      <AuthView
        mode="login"
        onDone={(me) =>
          void start(me).then(() => {
            if (next?.startsWith('/')) navigate(next);
            else if (location === '/login' || location === '/') navigate('/today');
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

function Shell() {
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const projectId = /^\/project\/([\w-]+)/.exec(location)?.[1];

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
            <Redirect to="/today" />
          </Route>
          <Route path="/today" component={TodayView} />
          <Route path="/upcoming" component={UpcomingView} />
          <Route path="/search" component={SearchView} />
          <Route path="/settings" component={SettingsView} />
          <Route path="/project/:id">{(p) => <ProjectView id={p.id} key={p.id} />}</Route>
          <Route path="/label/:name">{(p) => <LabelView name={decodeURIComponent(p.name)} />}</Route>
          <Route path="/task/:id">{(p) => <TaskDetail id={p.id} />}</Route>
          <Route path="/filter/:name">{(p) => <FilterView name={p.name} />}</Route>
          <Route path="/invite/:token">{(p) => <InviteAccept token={p.token} />}</Route>
          <Route path="/share">
            <ShareTarget onOpen={setAdding} />
          </Route>
          <Route>
            <Redirect to="/today" />
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
