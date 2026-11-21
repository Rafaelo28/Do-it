import {
  addDays,
  completionPoints,
  isRestDay,
  karmaLevel,
  karmaStreak,
  KARMA_RULES,
  weekStart,
  zonedParts,
  type KarmaPrefs,
  type KarmaSummary,
  type PlainDate,
} from '@do-it/shared';
import { settingsOf, type UserRow } from './auth';
import type { Queryable } from './db';
import type { Notice } from './sync';

function prefsOf(user: Pick<UserRow, 'settings'>): KarmaPrefs {
  const s = settingsOf(user);
  return { dailyGoal: s.dailyGoal, weeklyGoal: s.weeklyGoal, daysOff: s.daysOff, vacations: s.vacations };
}

async function total(q: Queryable, userId: string): Promise<number> {
  const row = await q.one<{ n: number }>('SELECT coalesce(sum(points), 0)::int AS n FROM karma_events WHERE user_id = $1', [userId]);
  return row?.n ?? 0;
}

async function doneBetween(q: Queryable, userId: string, from: PlainDate, to: PlainDate): Promise<number> {
  const row = await q.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM karma_events WHERE user_id = $1 AND kind = 'done' AND day BETWEEN $2::date AND $3::date`,
    [userId, from, to],
  );
  return row?.n ?? 0;
}

async function dailyCounts(q: Queryable, userId: string): Promise<{ counts: Map<PlainDate, number>; first: PlainDate | null }> {
  const rows = await q.query<{ day: string; n: number }>(
    `SELECT day::text AS day, count(*)::int AS n FROM karma_events WHERE user_id = $1 AND kind = 'done' GROUP BY day ORDER BY day`,
    [userId],
  );
  return { counts: new Map(rows.map((r) => [r.day, r.n])), first: rows[0]?.day ?? null };
}

const GOAL_CONFLICT = `ON CONFLICT (user_id, kind, day) WHERE kind IN ('daily_goal', 'weekly_goal') DO NOTHING`;

/**
 * Erledigt: Punkte gutschreiben, Tages-/Wochenziel prüfen, bei neuer Stufe benachrichtigen.
 * `task` sind die Daten vor dem Abhaken (Fälligkeit zählt für "pünktlich").
 */
export async function recordCompletion(
  q: Queryable,
  user: UserRow,
  taskId: string,
  task: { title: string; priority: number; dueDate: PlainDate | null; parentId: string | null },
  notices: Notice[],
): Promise<void> {
  const prefs = prefsOf(user);
  const day = zonedParts(new Date(), user.timezone).date;
  const before = await total(q, user.id);
  await q.query(`INSERT INTO karma_events(user_id, task_id, kind, points, day, title) VALUES ($1, $2, 'done', $3, $4, $5)`, [
    user.id,
    taskId,
    completionPoints(task, day),
    day,
    task.title.slice(0, 200),
  ]);

  if ((await doneBetween(q, user.id, day, day)) >= prefs.dailyGoal) {
    const exists = await q.one(`SELECT 1 FROM karma_events WHERE user_id = $1 AND kind = 'daily_goal' AND day = $2::date`, [user.id, day]);
    if (!exists) {
      // Serie bis gestern: jeder Tag bringt einen Punkt extra
      const { counts, first } = await dailyCounts(q, user.id);
      counts.delete(day);
      const streak = karmaStreak(counts, addDays(day, -1), prefs, first).current;
      await q.query(`INSERT INTO karma_events(user_id, kind, points, day, title) VALUES ($1, 'daily_goal', $2, $3, $4) ${GOAL_CONFLICT}`, [
        user.id,
        KARMA_RULES.dailyGoal + Math.min(streak, KARMA_RULES.streakMax),
        day,
        streak ? `Tagesziel erreicht – ${streak + 1} Tage in Folge` : 'Tagesziel erreicht',
      ]);
    }
  }
  const monday = weekStart(day);
  if ((await doneBetween(q, user.id, monday, addDays(monday, 6))) >= prefs.weeklyGoal) {
    await q.query(`INSERT INTO karma_events(user_id, kind, points, day, title) VALUES ($1, 'weekly_goal', $2, $3, 'Wochenziel erreicht') ${GOAL_CONFLICT}`, [
      user.id,
      KARMA_RULES.weeklyGoal,
      monday,
    ]);
  }

  const after = await total(q, user.id);
  const was = karmaLevel(before).current;
  const now = karmaLevel(after).current;
  if (now.level > was.level && settingsOf(user).karmaEnabled) {
    notices.push({ userId: user.id, title: `Neue Karma-Stufe: ${now.name}`, body: `${after.toLocaleString('de-DE')} Punkte – Stufe ${now.level} von 10. Weiter so!` });
  }
}

/** Wieder geöffnet: die letzte Gutschrift für diese Aufgabe zurücknehmen (samt Ziel-Bonus, falls er wegfällt). */
export async function revokeCompletion(q: Queryable, taskId: string): Promise<void> {
  const ev = await q.one<{ user_id: string; day: string }>(
    `DELETE FROM karma_events WHERE id = (SELECT id FROM karma_events WHERE task_id = $1 AND kind = 'done' ORDER BY id DESC LIMIT 1)
     RETURNING user_id, day::text AS day`,
    [taskId],
  );
  if (!ev) return;
  const user = await q.one<Pick<UserRow, 'settings'>>('SELECT settings FROM users WHERE id = $1', [ev.user_id]);
  if (!user) return;
  const prefs = prefsOf(user);
  if ((await doneBetween(q, ev.user_id, ev.day, ev.day)) < prefs.dailyGoal) {
    await q.query(`DELETE FROM karma_events WHERE user_id = $1 AND kind = 'daily_goal' AND day = $2::date`, [ev.user_id, ev.day]);
  }
  const monday = weekStart(ev.day);
  if ((await doneBetween(q, ev.user_id, monday, addDays(monday, 6))) < prefs.weeklyGoal) {
    await q.query(`DELETE FROM karma_events WHERE user_id = $1 AND kind = 'weekly_goal' AND day = $2::date`, [ev.user_id, monday]);
  }
}

export async function karmaSummary(q: Queryable, user: UserRow): Promise<KarmaSummary> {
  const settings = settingsOf(user);
  const prefs = prefsOf(user);
  const today = zonedParts(new Date(), user.timezone).date;
  const points = await total(q, user.id);
  const { counts, first } = await dailyCounts(q, user.id);
  const from = addDays(today, -27);
  const pointsByDay = new Map(
    (
      await q.query<{ day: string; p: number }>(
        `SELECT day::text AS day, sum(points)::int AS p FROM karma_events WHERE user_id = $1 AND day >= $2::date GROUP BY day`,
        [user.id, from],
      )
    ).map((r) => [r.day, r.p]),
  );
  const days = Array.from({ length: 28 }, (_, i) => {
    const date = addDays(from, i);
    const done = counts.get(date) ?? 0;
    return { date, done, points: pointsByDay.get(date) ?? 0, goal: done >= prefs.dailyGoal, rest: isRestDay(date, prefs) };
  });
  const monday = weekStart(today);
  let weekDone = 0;
  for (let i = 0; i < 7; i++) weekDone += counts.get(addDays(monday, i)) ?? 0;
  const recent = await q.query<{ at: Date; kind: 'done' | 'daily_goal' | 'weekly_goal'; points: number; title: string | null }>(
    `SELECT created_at AS at, kind, points, title FROM karma_events WHERE user_id = $1 ORDER BY id DESC LIMIT 25`,
    [user.id],
  );
  const level = karmaLevel(points);
  const todayDone = counts.get(today) ?? 0;
  return {
    enabled: settings.karmaEnabled,
    points,
    level: { ...level.current, next: level.next, progress: level.progress },
    today: { date: today, done: todayDone, goal: prefs.dailyGoal, points: pointsByDay.get(today) ?? 0, reached: todayDone >= prefs.dailyGoal },
    week: { from: monday, done: weekDone, goal: prefs.weeklyGoal, reached: weekDone >= prefs.weeklyGoal },
    streak: karmaStreak(counts, today, prefs, first),
    days,
    recent: recent.map((r) => ({ at: new Date(r.at).toISOString(), kind: r.kind, points: r.points, title: r.title })),
  };
}
