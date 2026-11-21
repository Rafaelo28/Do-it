import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { IconSettings, IconUser } from '../components/Icons';
import { QuickAdd } from '../components/QuickAdd';
import { TaskList } from '../components/TaskList';
import { Modal } from '../components/ui';
import { createSection, deleteProject, updateProject } from '../lib/actions';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { dragState, type DragState } from '../lib/dnd';
import type { Project } from '../lib/db';
import { toast } from '../lib/store';
import { sync, syncState } from '../lib/sync';
import { useViewPref } from '../lib/views';
import { useNow } from '../lib/time';
import { addDays, formatDateRelative } from '@do-it/shared';
import { AgendaList, useEvents } from '../components/Agenda';
import { LayoutSwitch } from '../components/LayoutSwitch';
import { LayoutBody } from './Layouted';
import { Select } from '../components/Select';

const COLORS = ['#0f8b6c', '#3e63dd', '#e5484d', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#978365', '#5b5bd6', '#30a46c'];

export function ProjectView({ id }: { id: string }) {
  const { projectMap, tasks, sections, loaded } = useData();
  const { members, me } = syncState.use();
  const project = projectMap.get(id);
  const [showDone, setShowDone] = useState(false);
  const [settings, setSettings] = useState(false);
  const [newSection, setNewSection] = useState<string | null>(null);
  const [addIn, setAddIn] = useState<string | null>(null);
  const drag = dragState.use();
  const [pref, setPref] = useViewPref(`project:${id}`, { layout: 'list', group: 'section' });
  const today = useNow().date;
  const upcomingEvents = useEvents(today, addDays(today, 60), (t) => t.projectId === id);
  const nextEvents = upcomingEvents.filter((e, i) => upcomingEvents.findIndex((x) => x.task.id === e.task.id) === i).slice(0, 8);
  const layout = pref.layout ?? 'list';

  if (!project) return <div className="page">{loaded && <div className="empty">Projekt nicht gefunden.</div>}</div>;

  const projectTasks = tasks.filter((t) => t.projectId === id && !t.isEvent && (showDone || !t.completedAt));
  const projectSections = sections.filter((s) => s.projectId === id);
  const unsectioned = projectTasks.filter((t) => !t.sectionId || !projectSections.some((s) => s.id === t.sectionId));
  const projectMembers = members.filter((m) => m.projectId === id);
  const myRole = projectMembers.find((m) => m.userId === me?.id)?.role;
  const doneCount = tasks.filter((t) => t.projectId === id && t.completedAt).length;

  return (
    <div className={`page ${layout !== 'list' ? 'wide' : ''}`}>
      <div className="page-head">
        {!project.isInbox && <span className="dot" style={{ background: project.color ?? 'var(--accent)', width: 14, height: 14 }} />}
        <h1>{project.name}</h1>
        {projectMembers.length > 1 && (
          <span className="sub row" style={{ gap: 4 }}>
            <IconUser size={14} /> {projectMembers.map((m) => m.name.split(' ')[0]).join(', ')}
          </span>
        )}
        <div className="actions">
          <LayoutSwitch value={layout} onChange={(l) => setPref({ layout: l })} />
          {!project.isInbox && (
            <button className="icon-btn" aria-label="Projekt-Einstellungen" onClick={() => setSettings(true)}>
              <IconSettings />
            </button>
          )}
        </div>
      </div>

      {myRole !== 'viewer' && <QuickAdd projectId={id} key={id} />}

      {layout !== 'list' && (
        <LayoutBody
          prefKey={`project:${id}`}
          pref={{ ...pref, layout }}
          setPref={setPref}
          tasks={tasks.filter((t) => t.projectId === id && !t.completedAt)}
          groups={['section', 'priority', 'date']}
          projectId={id}
          showProject={false}
          list={null}
        />
      )}

      {layout === 'list' && (
      <>
      {nextEvents.length > 0 && (
        <section>
          <div className="group-head">
            Nächste Termine <span className="muted">{nextEvents.length}</span>
          </div>
          <AgendaList items={nextEvents} showDate={(d) => formatDateRelative(d, today)} />
        </section>
      )}
      <div data-drop-section="" className={dropZoneClass(drag, '')}>
        <TaskList tasks={unsectioned} showProject={false} sortable={myRole !== 'viewer'} />
      </div>

      {projectSections.map((s) => (
        <section key={s.id}>
          <div className="group-head">
            {s.name} <span className="muted">{projectTasks.filter((t) => t.sectionId === s.id && !t.parentId).length || ''}</span>
          </div>
          <div data-drop-section={s.id} className={dropZoneClass(drag, s.id)}>
            <TaskList tasks={projectTasks.filter((t) => t.sectionId === s.id)} showProject={false} sortable={myRole !== 'viewer'} />
          </div>
          {myRole !== 'viewer' &&
            (addIn === s.id ? (
              <div style={{ margin: '8px 0' }}>
                <QuickAdd projectId={id} sectionId={s.id} autoFocus onDone={() => setAddIn(null)} />
              </div>
            ) : (
              <button className="btn ghost small muted" onClick={() => setAddIn(s.id)}>
                + Aufgabe
              </button>
            ))}
        </section>
      ))}

      <div className="row" style={{ marginTop: 20 }}>
        {myRole !== 'viewer' &&
          (newSection === null ? (
            <button className="btn ghost small" onClick={() => setNewSection('')}>
              + Abschnitt
            </button>
          ) : (
            <input
              className="input"
              autoFocus
              placeholder="Name des Abschnitts"
              value={newSection}
              style={{ maxWidth: 320 }}
              onChange={(e) => setNewSection(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSection.trim()) {
                  void createSection(id, newSection);
                  setNewSection(null);
                }
                if (e.key === 'Escape') setNewSection(null);
              }}
              onBlur={() => setNewSection(null)}
            />
          ))}
        {doneCount > 0 && (
          <button className="btn ghost small" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Erledigte ausblenden' : `${doneCount} erledigte anzeigen`}
          </button>
        )}
      </div>
      </>
      )}

      {settings && <ProjectSettings project={project} role={myRole} onClose={() => setSettings(false)} />}
    </div>
  );
}

function dropZoneClass(drag: DragState, section: string): string {
  return drag.id ? `drop-zone ${drag.overSection === section && !drag.overId ? 'active' : ''}` : '';
}

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
}

function ProjectSettings({ project, role, onClose }: { project: Project; role: string | undefined; onClose: () => void }) {
  const { me } = syncState.use();
  const [, navigate] = useLocation();
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color ?? COLORS[0]!);
  const [aliases, setAliases] = useState(project.aliases.join(', '));
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [activity, setActivity] = useState<{ id: number; summary: string; at: string }[]>([]);
  const owner = role === 'owner';

  const load = () => {
    api<{ members: MemberRow[] }>('GET', `/api/projects/${project.id}/members`)
      .then((r) => setMembers(r.members))
      .catch(() => {});
    api<{ activity: { id: number; summary: string; at: string }[] }>('GET', `/api/projects/${project.id}/activity`)
      .then((r) => setActivity(r.activity.slice(0, 15)))
      .catch(() => {});
  };
  useEffect(load, [project.id]);

  async function save() {
    await updateProject(project.id, {
      name: name.trim() || project.name,
      color,
      aliases: aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
        .slice(0, 30),
    });
    toast('Gespeichert');
    onClose();
  }

  async function createInvite() {
    try {
      const r = await api<{ url: string }>('POST', '/api/invites', { projectId: project.id, role: inviteRole });
      setInvite(r.url);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }

  async function share(url: string) {
    if (navigator.share) await navigator.share({ title: `Einladung zu „${project.name}“`, url }).catch(() => {});
    else {
      await navigator.clipboard.writeText(url);
      toast('Link kopiert');
    }
  }

  async function changeRole(userId: string, newRole: string) {
    try {
      await api('PATCH', `/api/projects/${project.id}/members/${userId}`, { role: newRole });
      load();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }

  async function remove(userId: string) {
    const self = userId === me?.id;
    if (!confirm(self ? 'Projekt wirklich verlassen?' : 'Mitglied entfernen?')) return;
    try {
      await api('DELETE', `/api/projects/${project.id}/members/${userId}`);
      if (self) {
        navigate('/today');
        void sync.sync();
      } else load();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }

  async function remove_() {
    if (!confirm(`„${project.name}“ mit allen Aufgaben löschen?`)) return;
    await deleteProject(project.id);
    navigate('/today');
  }

  return (
    <Modal onClose={onClose} label="Projekt-Einstellungen">
      <h2 style={{ marginTop: 0 }}>Projekt</h2>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} disabled={!owner} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="small muted" style={{ fontWeight: 600 }}>
            Farbe
          </span>
          <div className="row">
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={c}
                disabled={!owner}
                onClick={() => setColor(c)}
                style={{ width: 26, height: 26, borderRadius: '50%', background: c, border: c === color ? '3px solid var(--text)' : '0', cursor: 'pointer' }}
              />
            ))}
          </div>
        </div>
        <label className="field">
          <span>Andere Wörter für dieses Projekt</span>
          <input className="input" value={aliases} disabled={!owner} placeholder="z. B. Rasen, Hecke, Beet" onChange={(e) => setAliases(e.target.value)} />
          <span className="small">Kommt eines dieser Wörter in einer neuen Aufgabe vor, landet sie automatisch hier.</span>
        </label>
        {owner && (
          <div className="row">
            <button className="btn primary" onClick={() => void save()}>
              Speichern
            </button>
            <button className="btn" onClick={() => void updateProject(project.id, { archived: !project.archived }).then(onClose)}>
              {project.archived ? 'Wiederherstellen' : 'Archivieren'}
            </button>
          </div>
        )}
      </div>

      <h2>Mitglieder</h2>
      <ul className="list-plain">
        {members.map((m) => (
          <li key={m.userId}>
            <span style={{ flex: 1 }}>
              {m.name} <span className="small muted">{m.email}</span>
            </span>
            {owner && m.userId !== me?.id ? (
              <Select
                label={`Rolle von ${m.name}`}
                size="sm"
                value={m.role}
                options={[
                  { value: 'owner', label: 'Besitzer' },
                  { value: 'editor', label: 'Bearbeiten' },
                  { value: 'viewer', label: 'Nur lesen' },
                ]}
                onChange={(v) => void changeRole(m.userId, v)}
              />
            ) : (
              <span className="small muted">{m.role === 'owner' ? 'Besitzer' : m.role === 'editor' ? 'Bearbeiten' : 'Nur lesen'}</span>
            )}
            {(owner || m.userId === me?.id) && (
              <button className="btn ghost small danger" onClick={() => void remove(m.userId)}>
                {m.userId === me?.id ? 'Verlassen' : 'Entfernen'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <div className="card" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div className="row">
            <strong>Jemanden einladen</strong>
            <span style={{ marginLeft: 'auto' }} />
            <Select
              label="Rechte"
              size="sm"
              value={inviteRole}
              options={[
                { value: 'editor', label: 'darf bearbeiten' },
                { value: 'viewer', label: 'darf nur lesen' },
              ]}
              onChange={(v) => setInviteRole(v as 'editor' | 'viewer')}
            />
            <button className="btn" onClick={() => void createInvite()}>
              Link erstellen
            </button>
          </div>
          {invite && (
            <div className="row">
              <input className="input" readOnly value={invite} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
              <button className="btn primary" onClick={() => void share(invite)}>
                Teilen
              </button>
            </div>
          )}
          <span className="small muted">Der Link gilt 7 Tage und einmalig. Wer noch kein Konto hat, kann sich damit registrieren.</span>
        </div>
      )}

      {activity.length > 0 && (
        <>
          <h2>Verlauf</h2>
          <ul className="list-plain small">
            {activity.map((a) => (
              <li key={a.id}>
                <span className="muted" style={{ minWidth: 92 }}>
                  {new Date(a.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
                {a.summary}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        {owner && (
          <button className="btn danger" onClick={() => void remove_()}>
            Projekt löschen
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>
          Schließen
        </button>
      </div>
    </Modal>
  );
}
