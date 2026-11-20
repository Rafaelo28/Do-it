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
}

export interface MemberInfo {
  projectId: string;
  userId: string;
  role: Role;
  name: string;
}
