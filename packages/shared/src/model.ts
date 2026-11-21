import type { z } from 'zod';
import type { commentSchema, labelSchema, projectSchema, recurrenceSchema, reminderSchema, sectionSchema, taskSchema } from './schemas';

// Dieses Modul ist bewusst frei von Zod-Laufzeitcode, damit die Web-App die Bibliothek nicht mitladen muss.
// Die Schemas selbst liegen in ./schemas (nur Server).

export const OBJECT_TYPES = ['project', 'section', 'task', 'label', 'reminder', 'comment'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export type Recurrence = z.infer<typeof recurrenceSchema>;
export type ProjectData = z.infer<typeof projectSchema>;
export type SectionData = z.infer<typeof sectionSchema>;
export type TaskData = z.infer<typeof taskSchema>;
export type LabelData = z.infer<typeof labelSchema>;
export type ReminderData = z.infer<typeof reminderSchema>;
export type CommentData = z.infer<typeof commentSchema>;

export interface ObjectDataMap {
  project: ProjectData;
  section: SectionData;
  task: TaskData;
  label: LabelData;
  reminder: ReminderData;
  comment: CommentData;
}

/** Standardwerte für Felder, die beim Anlegen fehlen dürfen. */
export const OBJECT_DEFAULTS: { [K in ObjectType]: Partial<ObjectDataMap[K]> } = {
  project: { color: null, isInbox: false, parentId: null, sortKey: 'a0', archived: false, aliases: [] },
  section: { sortKey: 'a0' },
  task: {
    sectionId: null,
    parentId: null,
    description: '',
    priority: 4,
    dueDate: null,
    dueTime: null,
    deadline: null,
    durationMin: null,
    recurrence: null,
    assigneeId: null,
    rotation: [],
    labels: [],
    completedAt: null,
    completedBy: null,
    lastCompletedAt: null,
    lastCompletedBy: null,
    sortKey: 'a0',
    createdBy: null,
  },
  label: { color: null },
  reminder: { offsetMin: null, date: null, time: null },
  comment: {},
};

/** Objekte, die nur ihrem Besitzer gehören (nicht mit dem Projekt geteilt). */
export const PRIVATE_TYPES: ReadonlySet<ObjectType> = new Set(['label', 'reminder']);

export type ViewLayout = 'list' | 'board' | 'calendar' | 'table';
export type BoardGroup = 'section' | 'project' | 'priority' | 'date';
export type CalendarMode = 'day' | 'week' | 'month';

/** Darstellung einer Ansicht (Projekt, Label, Filter, Kalender) – pro Person gespeichert */
export interface ViewPref {
  layout?: ViewLayout;
  group?: BoardGroup;
  cal?: CalendarMode;
}

/** Eigener Filter mit Abfrage in der Filtersprache */
export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  color: string | null;
}

/** Erscheinungsbild der App (pro Person, auf allen Geräten) */
export interface Appearance {
  mode: 'system' | 'light' | 'dark';
  /** Akzentfarbe als #rrggbb */
  accent: string;
  style: 'paper' | 'clear' | 'cool' | 'warm' | 'oled';
  density: 'comfortable' | 'compact';
  radius: 'round' | 'soft' | 'square';
  textSize: 'normal' | 'large';
}

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', accent: '#0f8b6c', style: 'paper', density: 'comfortable', radius: 'round', textSize: 'normal' };

export interface UserSettings {
  morningTime: string;
  noonTime: string;
  afternoonTime: string;
  eveningTime: string;
  nightTime: string;
  workEndTime: string;
  briefingEnabled: boolean;
  briefingTime: string;
  /** automatische Erinnerung x Minuten vorher für Aufgaben mit Uhrzeit; null = aus */
  autoReminderMin: number | null;
  /** Karma anzeigen */
  karmaEnabled: boolean;
  /** erledigte Aufgaben pro Tag für das Tagesziel */
  dailyGoal: number;
  /** erledigte Aufgaben pro Woche für das Wochenziel */
  weeklyGoal: number;
  /** freie Wochentage (1 = Montag … 7 = Sonntag) */
  daysOff: number[];
  /** Urlaub (unterbricht keine Serie); to = null: läuft noch */
  vacations: { from: string; to: string | null }[];
  /** Darstellung je Ansicht, Schlüssel z. B. "project:<id>", "label:<name>", "calendar" */
  views: Record<string, ViewPref>;
  /** eigene Filter */
  filters: SavedFilter[];
  appearance: Appearance;
}

export const DEFAULT_SETTINGS: UserSettings = {
  morningTime: '08:00',
  noonTime: '12:00',
  afternoonTime: '15:00',
  eveningTime: '19:00',
  nightTime: '21:00',
  workEndTime: '17:00',
  briefingEnabled: true,
  briefingTime: '07:30',
  autoReminderMin: 0,
  karmaEnabled: true,
  dailyGoal: 5,
  weeklyGoal: 25,
  daysOff: [],
  vacations: [],
  views: {},
  filters: [],
  appearance: DEFAULT_APPEARANCE,
};


export type Role = 'owner' | 'editor' | 'viewer';

export interface Me {
  id: string;
  name: string;
  email: string;
  timezone: string;
  isAdmin: boolean;
  settings: UserSettings;
  /** Zwei-Faktor-Anmeldung aktiv */
  twoFactor: boolean;
  /** Adresse des Profilbilds (mit Version), null = keins */
  avatar: string | null;
}

export interface MemberInfo {
  projectId: string;
  userId: string;
  role: Role;
  name: string;
  avatar: string | null;
}
