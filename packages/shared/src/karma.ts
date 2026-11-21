import { addDays, isoWeekday, startOfIsoWeek, type PlainDate } from './dates';

/**
 * Karma: Punkte fürs Erledigen, Bonus für Tages- und Wochenziele und für Serien.
 * Die Stufen wachsen wie eine Pflanze – passend zum Grün von Do-it.
 */

export interface KarmaLevel {
  level: number;
  name: string;
  /** Punkte, ab denen die Stufe erreicht ist */
  min: number;
}

export const KARMA_LEVELS: readonly KarmaLevel[] = [
  { level: 1, name: 'Samenkorn', min: 0 },
  { level: 2, name: 'Keimling', min: 30 },
  { level: 3, name: 'Spross', min: 100 },
  { level: 4, name: 'Jungpflanze', min: 250 },
  { level: 5, name: 'Strauch', min: 500 },
  { level: 6, name: 'Baum', min: 1000 },
  { level: 7, name: 'Eiche', min: 2000 },
  { level: 8, name: 'Hain', min: 3500 },
  { level: 9, name: 'Wald', min: 6000 },
  { level: 10, name: 'Urwald', min: 10000 },
];

export const KARMA_RULES = {
  /** fürs Erledigen einer Aufgabe */
  done: 2,
  /** fürs Erledigen einer Unteraufgabe */
  subtask: 1,
  /** zusätzlich nach Priorität (P1 … P4) */
  priority: { 1: 3, 2: 2, 3: 1, 4: 0 } as Record<1 | 2 | 3 | 4, number>,
  /** zusätzlich, wenn spätestens am Fälligkeitstag erledigt */
  onTime: 1,
  /** Tagesziel erreicht */
  dailyGoal: 5,
  /** zusätzlich je Tag Serie (höchstens) */
  streakMax: 10,
  /** Wochenziel erreicht */
  weeklyGoal: 20,
} as const;

export interface KarmaPrefs {
  dailyGoal: number;
  weeklyGoal: number;
  /** freie Wochentage (1 = Montag … 7 = Sonntag): unterbrechen keine Serie */
  daysOff: number[];
  /** Urlaub: unterbricht keine Serie */
  vacations: { from: PlainDate; to: PlainDate | null }[];
}

export function karmaLevel(points: number): { current: KarmaLevel; next: KarmaLevel | null; progress: number } {
  let i = 0;
  while (i + 1 < KARMA_LEVELS.length && points >= KARMA_LEVELS[i + 1]!.min) i++;
  const current = KARMA_LEVELS[i]!;
  const next = KARMA_LEVELS[i + 1] ?? null;
  const progress = next ? Math.max(0, Math.min(1, (points - current.min) / (next.min - current.min))) : 1;
  return { current, next, progress };
}

/** Punkte fürs Erledigen – mit den Daten der Aufgabe vor dem Abhaken. */
export function completionPoints(task: { priority: number; dueDate: PlainDate | null; parentId: string | null }, day: PlainDate): number {
  let points = task.parentId ? KARMA_RULES.subtask : KARMA_RULES.done;
  points += KARMA_RULES.priority[task.priority as 1 | 2 | 3 | 4] ?? 0;
  if (task.dueDate && day <= task.dueDate) points += KARMA_RULES.onTime;
  return points;
}

export function isRestDay(day: PlainDate, prefs: Pick<KarmaPrefs, 'daysOff' | 'vacations'>): boolean {
  if (prefs.daysOff.includes(isoWeekday(day))) return true;
  return prefs.vacations.some((v) => day >= v.from && (v.to === null || day <= v.to));
}

export const weekStart = startOfIsoWeek;

/**
 * Serie: aufeinanderfolgende Tage mit erreichtem Tagesziel. Freie Tage und Urlaub zählen nicht,
 * unterbrechen aber auch nicht. Heute unterbricht nie (der Tag läuft ja noch).
 */
export function karmaStreak(
  counts: ReadonlyMap<PlainDate, number>,
  today: PlainDate,
  prefs: KarmaPrefs,
  firstDay: PlainDate | null,
): { current: number; best: number } {
  if (!firstDay) return { current: 0, best: 0 };
  const reached = (d: PlainDate) => (counts.get(d) ?? 0) >= prefs.dailyGoal;
  let current = 0;
  for (let d = today, guard = 0; d >= firstDay && guard < 3660; d = addDays(d, -1), guard++) {
    if (reached(d)) current++;
    else if (d === today || isRestDay(d, prefs)) continue;
    else break;
  }
  let best = 0;
  let run = 0;
  for (let d = firstDay, guard = 0; d <= today && guard < 3660; d = addDays(d, 1), guard++) {
    if (reached(d)) best = Math.max(best, ++run);
    else if (d !== today && !isRestDay(d, prefs)) run = 0;
  }
  return { current, best: Math.max(best, current) };
}

export interface KarmaDay {
  date: PlainDate;
  done: number;
  points: number;
  goal: boolean;
  rest: boolean;
}

export interface KarmaEvent {
  at: string;
  kind: 'done' | 'daily_goal' | 'weekly_goal';
  points: number;
  title: string | null;
}

export interface KarmaSummary {
  enabled: boolean;
  points: number;
  level: { level: number; name: string; min: number; next: { level: number; name: string; min: number } | null; progress: number };
  today: { date: PlainDate; done: number; goal: number; points: number; reached: boolean };
  week: { from: PlainDate; done: number; goal: number; reached: boolean };
  streak: { current: number; best: number };
  /** die letzten 28 Tage, ältester zuerst */
  days: KarmaDay[];
  recent: KarmaEvent[];
}
