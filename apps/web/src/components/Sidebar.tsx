import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { createProject } from '../lib/actions';
import { useData } from '../lib/data';
import { syncState } from '../lib/sync';
import { useNow } from '../lib/time';
import { IconCalendar, IconInbox, IconPlus, IconSearch, IconSettings, IconTag, IconToday } from './Icons';

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
  const { status, pending, me } = syncState.use();
  const now = useNow();
  const [, navigate] = useLocation();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const open_ = tasks.filter((t) => !t.completedAt);
  const mine = (t: (typeof tasks)[number]) => !t.assigneeId || t.assigneeId === me?.id;
  const todayCount = open_.filter((t) => t.dueDate && t.dueDate <= now.date && mine(t)).length;
  const overdue = open_.some((t) => t.dueDate && t.dueDate < now.date && mine(t));
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
      <NavLink href="/upcoming" icon={<IconCalendar />} label="Demnächst" onNavigate={onNavigate} />
      <NavLink href="/search" icon={<IconSearch />} label="Suchen" onNavigate={onNavigate} />

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

      {labels.length > 0 && <div className="nav-section">Labels</div>}
      {labels.map((l) => (
        <NavLink key={l.id} href={`/label/${encodeURIComponent(l.name)}`} icon={<IconTag />} label={l.name} onNavigate={onNavigate} />
      ))}

      <div className="sidebar-foot">
        <NavLink href="/settings" icon={<IconSettings />} label="Einstellungen" onNavigate={onNavigate} />
        <div className="sync-status" title={statusText}>
          <span className={`led ${status}`} />
          {statusText}
        </div>
      </div>
    </nav>
  );
}
