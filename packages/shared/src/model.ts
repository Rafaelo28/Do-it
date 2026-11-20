import { z } from 'zod';
import { isPlainDate, isPlainTime } from './dates';
import { UUID_RE } from './ids';

export const idSchema = z.string().regex(UUID_RE, 'ungültige ID');
const dateSchema = z.string().refine(isPlainDate, 'ungültiges Datum');
const timeSchema = z.string().refine(isPlainTime, 'ungültige Uhrzeit');
const isoSchema = z.string().max(40);
const weekday = z.number().int().min(1).max(7);

export const recurrenceSchema = z.strictObject({
  freq: z.enum(['day', 'week', 'month', 'year']),
  interval: z.number().int().min(1).max(999),
  weekdays: z.array(weekday).max(7).optional(),
  monthDay: z.number().int().min(-1).max(31).optional(),
  nthWeekday: z.strictObject({ n: z.number().int().min(-1).max(5), weekday }).optional(),
  month: z.number().int().min(1).max(12).optional(),
  afterCompletion: z.boolean().optional(),
  until: dateSchema.optional(),
});

export const projectSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  color: z.string().max(20).nullable(),
  isInbox: z.boolean(),
  parentId: idSchema.nullable(),
  sortKey: z.string().max(100),
  archived: z.boolean(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(30),
});

export const sectionSchema = z.strictObject({
  projectId: idSchema,
  name: z.string().trim().min(1).max(120),
  sortKey: z.string().max(100),
});

export const taskSchema = z.strictObject({
  projectId: idSchema,
  sectionId: idSchema.nullable(),
  parentId: idSchema.nullable(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20000),
  priority: z.number().int().min(1).max(4),
  dueDate: dateSchema.nullable(),
  dueTime: timeSchema.nullable(),
  deadline: dateSchema.nullable(),
  durationMin: z.number().int().min(1).max(10080).nullable(),
  recurrence: recurrenceSchema.nullable(),
  assigneeId: idSchema.nullable(),
  rotation: z.array(idSchema).max(20),
  labels: z.array(z.string().trim().min(1).max(60)).max(30),
  completedAt: isoSchema.nullable(),
  completedBy: idSchema.nullable(),
  lastCompletedAt: isoSchema.nullable(),
  lastCompletedBy: idSchema.nullable(),
  sortKey: z.string().max(100),
  createdBy: idSchema.nullable(),
  createdAt: isoSchema,
});

export const labelSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  color: z.string().max(20).nullable(),
});

export const reminderSchema = z.strictObject({
  taskId: idSchema,
  kind: z.enum(['relative', 'absolute']),
  /** Minuten vor Fälligkeit (relative) */
  offsetMin: z.number().int().min(0).max(525600).nullable(),
  /** fester Zeitpunkt in lokaler Zeit (absolute) */
  date: dateSchema.nullable(),
  time: timeSchema.nullable(),
});

export const commentSchema = z.strictObject({
  taskId: idSchema,
  body: z.string().trim().min(1).max(10000),
  authorId: idSchema,
  createdAt: isoSchema,
});

export const OBJECT_SCHEMAS = {
  project: projectSchema,
  section: sectionSchema,
  task: taskSchema,
  label: labelSchema,
  reminder: reminderSchema,
  comment: commentSchema,
} as const;

export type ObjectType = keyof typeof OBJECT_SCHEMAS;
export const OBJECT_TYPES = Object.keys(OBJECT_SCHEMAS) as ObjectType[];

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

export const settingsSchema = z.strictObject({
  morningTime: timeSchema,
  noonTime: timeSchema,
  afternoonTime: timeSchema,
  eveningTime: timeSchema,
  nightTime: timeSchema,
  workEndTime: timeSchema,
  briefingEnabled: z.boolean(),
  briefingTime: timeSchema,
  autoReminderMin: z.number().int().min(0).max(10080).nullable(),
});

export type Role = 'owner' | 'editor' | 'viewer';

export interface Me {
  id: string;
  name: string;
  email: string;
  timezone: string;
  isAdmin: boolean;
  settings: UserSettings;
}

export interface MemberInfo {
  projectId: string;
  userId: string;
  role: Role;
  name: string;
}
