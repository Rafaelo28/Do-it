import {
  DEFAULT_SETTINGS,
  formatDateRelative,
  nextOccurrence,
  occurrencesBetween,
  zonedParts,
  zonedToUtc,
  type ReminderData,
  type TaskData,
  type UserSettings,
} from '@do-it/shared';
import type { Db, Queryable } from './db';
import type { PushService } from './push';

/** Zeitpunkt, an dem eine Erinnerung ausgelöst wird, oder null (keine Fälligkeit, erledigt …). */
export function computeFireAt(r: ReminderData, t: TaskData | null, tz: string, settings: Partial<UserSettings>, now = new Date()): Date | null {
  if (r.kind === 'absolute') {
    if (!r.date || !r.time) return null;
    if (t?.completedAt) return null;
    return zonedToUtc(r.date, r.time, tz);
  }
  if (!t || t.completedAt || !t.dueDate) return null;
  const time = t.dueTime ?? settings.morningTime ?? DEFAULT_SETTINGS.morningTime;
  const fireOn = (date: string) => new Date(zonedToUtc(date, time, tz).getTime() - (r.offsetMin ?? 0) * 60_000);
  let fire = fireOn(t.dueDate);
  // Wiederkehrende Termine werden nicht abgehakt: Erinnerung gilt dem nächsten Termin, der noch kommt
  if (t.isEvent && t.recurrence && !t.recurrence.afterCompletion && fire < now) {
    let d: string | null = t.dueDate;
    for (let i = 0; i < 2000 && d && fire < now; i++) {
      const n: string | null = nextOccurrence(t.recurrence, d, d);
      if (!n || n <= d) return null;
      d = n;
      fire = fireOn(d);
    }
  }
  return fire;
}

interface Row {
  id: string;
  owner_id: string;
  rdata: ReminderData;
  rdeleted: boolean;
  task_id: string | null;
  tdata: TaskData | null;
  tdeleted: boolean | null;
  timezone: string;
  settings: Partial<UserSettings>;
}

/** Berechnet die Termine der betroffenen Erinnerungen neu (innerhalb der laufenden Transaktion). */
export async function rescheduleReminders(q: Queryable, filter: { taskIds: string[]; reminderIds: string[] }, now = new Date()): Promise<void> {
  if (!filter.taskIds.length && !filter.reminderIds.length) return;
  const rows = await q.query<Row>(
    `SELECT r.id, r.owner_id, r.data AS rdata, r.deleted AS rdeleted, t.id AS task_id, t.data AS tdata, t.deleted AS tdeleted, u.timezone, u.settings
     FROM objects r
     JOIN users u ON u.id = r.owner_id
     LEFT JOIN objects t ON t.id = (r.data->>'taskId')::uuid AND t.type = 'task'
     WHERE r.type = 'reminder' AND (r.id = ANY($1::uuid[]) OR r.data->>'taskId' = ANY($2::text[]))`,
    [filter.reminderIds, filter.taskIds],
  );
  for (const row of rows) {
    const fire = row.rdeleted || row.tdeleted || !row.task_id ? null : computeFireAt(row.rdata, row.tdata, row.timezone, row.settings, now);
    if (!fire) {
      await q.query('DELETE FROM reminder_schedule WHERE reminder_id = $1', [row.id]);
      continue;
    }
    await q.query(
      `INSERT INTO reminder_schedule(reminder_id, user_id, task_id, fire_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reminder_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, task_id = EXCLUDED.task_id, fire_at = EXCLUDED.fire_at,
         sent_at = CASE WHEN reminder_schedule.fire_at = EXCLUDED.fire_at THEN reminder_schedule.sent_at ELSE NULL END,
         locked_until = NULL`,
      [row.id, row.owner_id, row.task_id, fire],
    );
  }
}

function dueText(t: TaskData, today: string): string {
  if (!t.dueDate) return '';
  const day = formatDateRelative(t.dueDate, today);
  return t.dueTime ? `${day}, ${t.dueTime} Uhr` : day;
}

const MISSED_AFTER_MS = 6 * 3600_000;

/** Fällige Erinnerungen versenden. Mehrere Worker können parallel laufen (SKIP LOCKED). */
export async function processDueReminders(db: Db, push: PushService, now = new Date()): Promise<{ sent: number; missed: number }> {
  const due = await db.query<{ reminder_id: string; user_id: string; task_id: string; fire_at: Date }>(
    `UPDATE reminder_schedule SET locked_until = $1::timestamptz + interval '2 minutes'
     WHERE reminder_id IN (
       SELECT reminder_id FROM reminder_schedule
       WHERE sent_at IS NULL AND fire_at <= $1 AND (locked_until IS NULL OR locked_until < $1)
       ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED
     ) RETURNING reminder_id, user_id, task_id, fire_at`,
    [now],
  );
  let sent = 0;
  const missedByUser = new Map<string, number>();
  for (const r of due) {
    const task = await db.one<{ data: TaskData; timezone: string; visible: boolean }>(
      `SELECT t.data, u.timezone,
         EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = u.id) AS visible
       FROM objects t JOIN users u ON u.id = $2
       WHERE t.id = $1 AND NOT t.deleted`,
      [r.task_id, r.user_id],
    );
    await db.query('UPDATE reminder_schedule SET sent_at = $2 WHERE reminder_id = $1', [r.reminder_id, now]);
    if (!task || !task.visible || task.data.completedAt) continue;
    if (now.getTime() - new Date(r.fire_at).getTime() > MISSED_AFTER_MS) {
      if (task.data.isEvent && task.data.recurrence) await rescheduleReminders(db, { taskIds: [], reminderIds: [r.reminder_id] }, now);
      missedByUser.set(r.user_id, (missedByUser.get(r.user_id) ?? 0) + 1);
      continue;
    }
    const today = zonedParts(now, task.timezone).date;
    if (task.data.isEvent) {
      // Termin: ohne "Erledigt"-Knöpfe; bei Wiederholung gleich den nächsten Termin einplanen
      const local = zonedParts(new Date(new Date(r.fire_at).getTime()), task.timezone);
      const when = task.data.dueTime ? `${formatDateRelative(local.date, today)}, ${task.data.dueTime} Uhr` : dueText(task.data, today);
      await push.sendToUser(r.user_id, { title: task.data.title, body: `Termin · ${when}`, tag: r.task_id, url: `/task/${r.task_id}` });
      if (task.data.recurrence) await rescheduleReminders(db, { taskIds: [], reminderIds: [r.reminder_id] }, now);
    } else {
      await push.sendToUser(r.user_id, {
        title: task.data.title,
        body: dueText(task.data, today) || 'Erinnerung',
        tag: r.task_id,
        url: `/task/${r.task_id}`,
        taskId: r.task_id,
        ...push.taskActions(r.user_id, r.task_id),
      });
    }
    sent++;
  }
  for (const [userId, n] of missedByUser) {
    await push.sendToUser(userId, {
      title: n === 1 ? '1 verpasste Erinnerung' : `${n} verpasste Erinnerungen`,
      body: 'Der Server war eine Weile nicht erreichbar. Schau in „Heute“ nach.',
      tag: 'missed',
      url: '/today',
    });
  }
  return { sent, missed: [...missedByUser.values()].reduce((a, b) => a + b, 0) };
}

/** Morgen-Briefing: einmal am Tag zur eingestellten Zeit, wenn es heute etwas zu tun gibt. */
export async function processBriefings(db: Db, push: PushService, now = new Date()): Promise<number> {
  const users = await db.query<{ id: string; timezone: string; settings: Partial<UserSettings>; last_briefing_date: string | null }>(
    `SELECT id, timezone, settings, last_briefing_date FROM users WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = users.id)`,
  );
  let sent = 0;
  for (const u of users) {
    const s = { ...DEFAULT_SETTINGS, ...u.settings };
    if (!s.briefingEnabled) continue;
    const local = zonedParts(now, u.timezone);
    if (local.time < s.briefingTime || u.last_briefing_date === local.date) continue;
    // Nicht nachholen, wenn der Termin schon Stunden her ist (z. B. nach Server-Ausfall).
    if (local.time > addMinutes(s.briefingTime, 180)) {
      await db.query('UPDATE users SET last_briefing_date = $2 WHERE id = $1', [u.id, local.date]);
      continue;
    }
    const rows = await db.query<{ data: TaskData }>(
      `SELECT t.data FROM objects t
       JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1
       WHERE t.type = 'task' AND NOT t.deleted AND t.data->>'completedAt' IS NULL
         AND t.data->>'dueDate' IS NOT NULL AND t.data->>'dueDate' <= $2
         AND (t.data->>'assigneeId' IS NULL OR t.data->>'assigneeId' = $1::text)
       ORDER BY t.data->>'dueDate', t.data->>'dueTime' NULLS LAST LIMIT 300`,
      [u.id, local.date],
    );
    await db.query('UPDATE users SET last_briefing_date = $2 WHERE id = $1', [u.id, local.date]);
    const tasks = rows.filter((r) => !r.data.isEvent).slice(0, 50);
    const events = rows
      .filter((r) => r.data.isEvent && occurrencesBetween(r.data.dueDate!, r.data.recurrence, local.date, local.date).length > 0)
      .sort((a, b) => (a.data.dueTime ?? '').localeCompare(b.data.dueTime ?? ''));
    if (!tasks.length && !events.length) continue;
    const overdue = tasks.filter((t) => t.data.dueDate! < local.date).length;
    const parts: string[] = [];
    if (tasks.length) parts.push(`${tasks.length} ${tasks.length === 1 ? 'Aufgabe' : 'Aufgaben'} für heute${overdue ? `, ${overdue} überfällig` : ''}`);
    if (events.length) parts.push(`${events.length} ${events.length === 1 ? 'Termin' : 'Termine'}`);
    const lines = [
      ...events.slice(0, 3).map((e) => `• ${e.data.dueTime ? `${e.data.dueTime} ` : ''}${e.data.title}`),
      ...tasks.slice(0, Math.max(0, 3 - Math.min(3, events.length))).map((t) => `• ${t.data.title}`),
    ];
    await push.sendToUser(u.id, {
      title: 'Guten Morgen!',
      body: `${parts.join(' · ')}\n${lines.join('\n')}`,
      tag: `briefing-${local.date}`,
      url: '/today',
    });
    sent++;
  }
  return sent;
}

function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = Math.min(h * 60 + m + min, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

