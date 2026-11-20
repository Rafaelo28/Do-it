import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { db, type Label, type Project, type Reminder, type Section, type Task } from './db';

export interface Data {
  loaded: boolean;
  projects: Project[];
  sections: Section[];
  tasks: Task[];
  labels: Label[];
  reminders: Reminder[];
  inbox: Project | undefined;
  projectMap: Map<string, Project>;
  /** Unteraufgaben je Aufgabe (gesamt / erledigt) */
  childStats: Map<string, { total: number; done: number }>;
  /** Aufgaben mit mindestens einer eigenen Erinnerung */
  remindedTasks: Set<string>;
}

const empty: Data = {
  loaded: false,
  projects: [],
  sections: [],
  tasks: [],
  labels: [],
  reminders: [],
  inbox: undefined,
  projectMap: new Map(),
  childStats: new Map(),
  remindedTasks: new Set(),
};

const DataContext = createContext<Data>(empty);

const byKey = <T extends { sortKey: string }>(a: T, b: T) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);

/** Lädt alle (kleinen) Tabellen reaktiv; Ansichten filtern im Speicher. */
export function DataProvider({ children }: { children: ReactNode }) {
  const projects = useLiveQuery(() => db.projects.toArray(), []);
  const sections = useLiveQuery(() => db.sections.toArray(), []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), []);
  const labels = useLiveQuery(() => db.labels.toArray(), []);
  const reminders = useLiveQuery(() => db.reminders.toArray(), []);
  const value = useMemo<Data>(() => {
    if (!projects || !sections || !tasks || !labels || !reminders) return empty;
    const sortedProjects = [...projects].sort((a, b) => (a.isInbox ? -1 : b.isInbox ? 1 : byKey(a, b)));
    const childStats = new Map<string, { total: number; done: number }>();
    for (const t of tasks) {
      if (!t.parentId) continue;
      const s = childStats.get(t.parentId) ?? { total: 0, done: 0 };
      s.total++;
      if (t.completedAt) s.done++;
      childStats.set(t.parentId, s);
    }
    return {
      loaded: true,
      projects: sortedProjects,
      sections: [...sections].sort(byKey),
      tasks: [...tasks].sort(byKey),
      labels: [...labels].sort((a, b) => a.name.localeCompare(b.name, 'de')),
      reminders,
      inbox: sortedProjects.find((p) => p.isInbox),
      projectMap: new Map(sortedProjects.map((p) => [p.id, p])),
      childStats,
      remindedTasks: new Set(reminders.map((r) => r.taskId)),
    };
  }, [projects, sections, tasks, labels, reminders]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): Data {
  return useContext(DataContext);
}
