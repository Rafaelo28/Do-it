import { z } from 'zod';
import { isPlainDate, isPlainTime } from './dates';
import { UUID_RE } from './ids';
import { OBJECT_TYPES, type ObjectType } from './model';

// Zod-Schemas zur Prüfung von Eingaben. Nur für den Server (Import: '@do-it/shared/schemas').

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
  /** Termin statt To-do: steht im Kalender, wird nicht abgehakt */
  isEvent: z.boolean().optional(),
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
} as const satisfies Record<ObjectType, z.ZodType>;

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
  karmaEnabled: z.boolean(),
  dailyGoal: z.number().int().min(1).max(100),
  weeklyGoal: z.number().int().min(1).max(700),
  daysOff: z.array(weekday).max(6),
  vacations: z.array(z.strictObject({ from: dateSchema, to: dateSchema.nullable() })).max(24),
  views: z
    .record(
      z.string().max(140),
      z.strictObject({
        layout: z.enum(['list', 'board', 'calendar', 'table']).optional(),
        group: z.enum(['section', 'project', 'priority', 'date']).optional(),
        cal: z.enum(['day', 'week', 'month']).optional(),
      }),
    )
    .refine((v) => Object.keys(v).length <= 500, 'Zu viele gespeicherte Ansichten'),
  filters: z
    .array(
      z.strictObject({
        id: idSchema,
        name: z.string().trim().min(1).max(60),
        query: z.string().trim().min(1).max(500),
        color: z.string().max(20).nullable(),
      }),
    )
    .max(150),
  appearance: z.strictObject({
    mode: z.enum(['system', 'light', 'dark']),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    style: z.enum(['paper', 'clear', 'cool', 'warm', 'oled']),
    density: z.enum(['comfortable', 'compact']),
    radius: z.enum(['round', 'soft', 'square']),
    textSize: z.enum(['normal', 'large']),
  }),
});

export const mutationSchema = z.strictObject({
  /** eindeutige ID der Änderung (Idempotenz) */
  mid: z.string().min(8).max(64),
  type: z.enum(OBJECT_TYPES),
  id: idSchema,
  op: z.enum(['put', 'delete']),
  /** geänderte Felder (bei put) */
  data: z.record(z.string(), z.unknown()).optional(),
  hlc: z.string().max(80),
});

export const pushRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(64),
  mutations: z.array(mutationSchema).max(500),
});

