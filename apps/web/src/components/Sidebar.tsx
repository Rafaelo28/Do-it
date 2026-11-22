import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { createProject } from '../lib/actions';
import { useData } from '../lib/data';
import { karmaState } from '../lib/karma';
import { syncState } from '../lib/sync';
import { Avatar } from './Avatar';
import { FilterEditor, filterTasks, useFilterContext } from '../views/CustomFilter';
import { useNow } from '../lib/time';
import { IconCalendar, IconNote, IconClock, IconDone, IconFilter, IconFlag, IconInbox, IconPlus, IconSearch, IconSettings, IconSparkle, IconTag, IconToday, IconUser } from './Icons';

function NavLink({ href, icon, label, count, alert, onNavigate }: { href: string; icon: React.ReactNode; label: string; count?: number; alert?: boolean; onNavigate: () => void }) {
  const [location] = useLocation();
  const active = location === href || (href !== '/' && location.startsWith(`${href}/`));
  return (
    <Link href={href} className={`nav-item ${active ? 'active' : ''}`} onClick={onNavigate}>
      {icon}
      <span>{label}</span>
      {!!count && <span className={`count ${alert ? 'alert' : ''}`}>{count}</span>}
    </Link>
  );
}

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { projects, tasks, labels, inbox } = useData();
  const { status, pending, me, members } = syncState.use();
  const now = useNow();
  const [, navigate] = useLocation();
  const [adding, setAdding] = useState(false);
  const [newFilter, setNewFilter] = useState(false);
  const filterCtx = useFilterContext();
  const customFilters = me?.settings.filters ?? [];
  const [name, setName] = useState('');

  const open_ = tasks.filter((t) => !t.completedAt && !t.isEvent);
  const mine = (t: (typeof tasks)[number]) => !t.assigneeId || t.assigneeId === me?.id;
  const todayCount = open_.filter((t) => t.dueDate && t.dueDate <= now.date && mine(t)).length;
  const overdue = open_.some((t) => t.dueDate && t.dueDate < now.date && mine(t));
  // Zahl auf dem App-Symbol (installierte App auf Desktop und iPad)
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (todayCount) void nav.setAppBadge?.(todayCount).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  }, [todayCount]);
  const countIn = (pid: string) => open_.filter((t) => t.projectId === pid && !t.parentId).length;

  async function addProject() {
    if (!name.trim()) return setAdding(false);
    const id = await createProject(name);
    setName('');
    setAdding(false);
    navigate(`/project/${id}`);
    onNavigate();
  }

  const statusText =
    status === 'offline' ? 'Offline – Änderungen werden später übertragen' : status === 'error' ? 'Sync-Fehler' : status === 'syncing' ? 'Synchronisiere …' : pending ? `${pending} ausstehend` : 'Synchron';

  return (
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Navigation">
      <div className="brand">
        <img src="/icons/icon.svg" alt="" />
        Do-it
      </div>
      {inbox && <NavLink href={`/project/${inbox.id}`} icon={<IconInbox />} label="Eingang" count={countIn(inbox.id)} onNavigate={onNavigate} />}
      <NavLink href="/today" icon={<IconToday />} label="Heute" count={todayCount} alert={overdue} onNavigate={onNavigate} />
      <NavLink href="/upcoming" icon={<IconClock />} label="Demnächst" onNavigate={onNavigate} />
      <NavLink href="/calendar" icon={<IconCalendar />} label="Kalender" onNavigate={onNavigate} />
      <NavLink href="/notes" icon={<IconNote />} label="Notizen" onNavigate={onNavigate} />
      <NavLink href="/done" icon={<IconDone />} label="Erledigt" onNavigate={onNavigate} />
      <NavLink href="/search" icon={<IconSearch />} label="Suchen" onNavigate={onNavigate} />
      <NavLink href="/briefings" icon={<IconSparkle />} label="Briefings" onNavigate={onNavigate} />

      <div className="nav-section">
        <span>Projekte</span>
        <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Projekt anlegen" onClick={() => setAdding(true)}>
          <IconPlus size={16} />
        </button>
      </div>
      {projects
        .filter((p) => !p.isInbox && !p.archived)
        .map((p) => (
          <NavLink key={p.id} href={`/project/${p.id}`} icon={<span className="dot" style={{ background: p.color ?? 'var(--accent)' }} />} label={p.name} count={countIn(p.id)} onNavigate={onNavigate} />
        ))}
      {adding && (
        <div style={{ padding: '4px 6px' }}>
          <input
            className="input"
            autoFocus
            placeholder="Projektname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addProject();
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={() => void addProject()}
          />
        </div>
      )}

      <div className="nav-section">
        <span>Filter</span>
        <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Filter anlegen" onClick={() => setNewFilter(true)}>
          <IconPlus size={16} />
        </button>
      </div>
      {customFilters.map((f) => (
        <NavLink
          key={f.id}
          href={`/f/${f.id}`}
          icon={<IconFilter style={{ color: f.color ?? 'var(--accent)' }} />}
          label={f.name}
          count={filterTasks(open_, f.query, filterCtx).tasks.length}
          onNavigate={onNavigate}
        />
      ))}
      {members.some((m) => m.userId !== me?.id) && (
        <NavLink href="/filter/mine" icon={<IconUser />} label="Mir zugewiesen" count={open_.filter((t) => t.assigneeId === me?.id).length} onNavigate={onNavigate} />
      )}
      <NavLink href="/filter/p1" icon={<IconFlag />} label="Priorität 1" count={open_.filter((t) => t.priority === 1).length} onNavigate={onNavigate} />
      <NavLink href="/filter/nodate" icon={<IconClock />} label="Ohne Datum" onNavigate={onNavigate} />
      {open_.some((t) => t.deadline) && <NavLink href="/filter/deadline" icon={<IconFlag />} label="Mit Deadline" count={open_.filter((t) => t.deadline).length} onNavigate={onNavigate} />}
      {newFilter && <FilterEditor onClose={() => setNewFilter(false)} />}

      {labels.length > 0 && <div className="nav-section">Labels</div>}
      {labels.map((l) => (
        <NavLink key={l.id} href={`/label/${encodeURIComponent(l.name)}`} icon={<IconTag />} label={l.name} onNavigate={onNavigate} />
      ))}

      <div className="sidebar-foot">
        {me && <ProfileRow onNavigate={onNavigate} />}
        <NavLink href="/settings" icon={<IconSettings />} label="Einstellungen" onNavigate={onNavigate} />
        <div className="sync-status" title={statusText}>
          <span className={`led ${status}`} />
          {statusText}
        </div>
      </div>
    </nav>
  );
}

/** Unten in der Seitenleiste: Profilbild, Name und Karma-Stufe mit Fortschritt. */
function ProfileRow({ onNavigate }: { onNavigate: () => void }) {
  const me = syncState.select((s) => s.me)!;
  const karma = karmaState.use();
  const [location] = useLocation();
  const show = me.settings.karmaEnabled && karma?.enabled;
  return (
    <Link href={show ? '/karma' : '/settings'} className={`profile-row ${location === '/karma' ? 'active' : ''}`} onClick={onNavigate}>
      <Avatar name={me.name} src={me.avatar} size={32} seed={me.id} />
      <span className="profile-text">
        <span className="profile-name">{me.name}</span>
        {show && karma && (
          <>
            <span className="profile-level">
              Stufe {karma.level.level} · {karma.level.name}
              {karma.streak.current > 1 && ` · ${karma.streak.current} Tage`}
            </span>
            <span className="profile-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(karma.level.progress * 100)}%` }} />
            </span>
          </>
        )}
      </span>
    </Link>
  );
}
