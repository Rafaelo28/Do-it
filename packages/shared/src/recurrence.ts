import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  fromParts,
  isoWeekday,
  maxDate,
  MONTHS_LONG,
  nthWeekdayOfMonth,
  startOfIsoWeek,
  diffDays,
  toParts,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  type PlainDate,
} from './dates';
import type { Recurrence } from './model';

function clampDay(y: number, m: number, day: number): PlainDate {
  const dim = daysInMonth(y, m);
  return fromParts(y, m, day === -1 ? dim : Math.min(day, dim));
}

function monthCandidate(r: Recurrence, y: number, m: number, fallbackDay: number): PlainDate | null {
  if (r.nthWeekday) return nthWeekdayOfMonth(y, m, r.nthWeekday.weekday, r.nthWeekday.n);
  return clampDay(y, m, r.monthDay ?? fallbackDay);
}

/**
 * Erster passender Termin nach dem Plan. Ist `inclusive` gesetzt, darf `from` selbst passen.
 * Wird genutzt, um für eine neue Wiederholung ohne Datum den ersten Termin zu finden.
 */
export function firstOccurrence(r: Recurrence, from: PlainDate): PlainDate {
  if (r.freq === 'week' && r.weekdays?.length) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i);
      if (r.weekdays.includes(isoWeekday(d))) return d;
    }
  }
  if (r.freq === 'month' && (r.monthDay !== undefined || r.nthWeekday)) {
    const [y, m] = toParts(from);
    for (let k = 0; k < 24; k++) {
      const total = y * 12 + (m - 1) + k;
      const c = monthCandidate(r, Math.floor(total / 12), (total % 12) + 1, 1);
      if (c && c >= from) return c;
    }
  }
  if (r.freq === 'year' && r.month) {
    const [y] = toParts(from);
    for (let k = 0; k < 9; k++) {
      const c = r.nthWeekday
        ? nthWeekdayOfMonth(y + k, r.month, r.nthWeekday.weekday, r.nthWeekday.n)
        : clampDay(y + k, r.month, r.monthDay ?? 1);
      if (c && c >= from) return c;
    }
  }
  return from;
}

/**
 * Nächster Termin nach Erledigung.
 * @param current bisheriges Fälligkeitsdatum (falls vorhanden)
 * @param completedOn Tag der Erledigung (lokal)
 * @returns neues Datum oder null, wenn die Serie zu Ende ist
 */
export function nextOccurrence(r: Recurrence, current: PlainDate | undefined | null, completedOn: PlainDate): PlainDate | null {
  const interval = Math.max(1, Math.floor(r.interval || 1));
  let next: PlainDate | null;

  if (r.afterCompletion) {
    next = step(completedOn, r.freq, interval);
  } else {
    const start = current ?? completedOn;
    // Nie in der Vergangenheit landen: überfällige Serien springen hinter "heute".
    const anchor = maxDate(start, completedOn);
    next = scheduleAfter(r, start, anchor, interval);
  }

  if (next && r.until && next > r.until) return null;
  return next;
}

function step(d: PlainDate, freq: Recurrence['freq'], n: number): PlainDate {
  switch (freq) {
    case 'day':
      return addDays(d, n);
    case 'week':
      return addDays(d, 7 * n);
    case 'month':
      return addMonths(d, n);
    case 'year':
      return addYears(d, n);
  }
}

/** Erster Termin der Serie (mit Startpunkt `start`), der strikt nach `anchor` liegt. */
function scheduleAfter(r: Recurrence, start: PlainDate, anchor: PlainDate, interval: number): PlainDate | null {
  const [sy, sm, sd] = toParts(start);

  if (r.freq === 'day') {
    const gap = diffDays(start, anchor);
    const k = Math.floor(gap / interval) + 1;
    return addDays(start, k * interval);
  }

  if (r.freq === 'week') {
    const days = r.weekdays?.length ? [...r.weekdays].sort() : [isoWeekday(start)];
    const startWeek = startOfIsoWeek(start);
    let d = addDays(anchor, 1);
    for (let i = 0; i < 7 * interval * 2 + 14; i++, d = addDays(d, 1)) {
      if (!days.includes(isoWeekday(d))) continue;
      const weeks = Math.round(diffDays(startWeek, startOfIsoWeek(d)) / 7);
      if (weeks % interval === 0) return d;
    }
    return null;
  }

  if (r.freq === 'month') {
    for (let k = 1; k <= 12 * interval * 50; k++) {
      if (k % interval !== 0) continue;
      const total = sy * 12 + (sm - 1) + k;
      const c = monthCandidate(r, Math.floor(total / 12), (total % 12) + 1, sd);
      if (c && c > anchor) return c;
    }
    return null;
  }

  // year
  const month = r.month ?? sm;
  for (let k = 1; k <= 200; k++) {
    if (k % interval !== 0) continue;
    const y = sy + k;
    const c = r.nthWeekday
      ? nthWeekdayOfMonth(y, month, r.nthWeekday.weekday, r.nthWeekday.n)
      : clampDay(y, month, r.monthDay ?? sd);
    if (c && c > anchor) return c;
  }
  return null;
}

const ORD = (n: number) => (n === -1 ? 'letzten' : `${n}.`);

/** Beschreibung auf Deutsch, z. B. "jeden Montag", "alle 3 Tage nach Erledigung". */
export function describeRecurrence(r: Recurrence): string {
  const n = Math.max(1, r.interval || 1);
  let text: string;
  switch (r.freq) {
    case 'day':
      text = n === 1 ? 'täglich' : `alle ${n} Tage`;
      break;
    case 'week': {
      const wd = r.weekdays ? [...r.weekdays].sort() : [];
      let days = '';
      if (wd.join() === '1,2,3,4,5') days = 'werktags';
      else if (wd.join() === '6,7') days = 'am Wochenende';
      else if (wd.length === 1) days = WEEKDAYS_LONG[wd[0]! - 1]!;
      else if (wd.length > 1) days = wd.map((d) => WEEKDAYS_SHORT[d - 1]).join(', ');
      if (n === 1) {
        if (!days) text = 'wöchentlich';
        else if (days === 'werktags' || days === 'am Wochenende') text = days;
        else text = `jeden ${days}`;
      } else {
        text = `alle ${n} Wochen${days ? (days.startsWith('am') || days === 'werktags' ? ` ${days}` : ` am ${days}`) : ''}`;
      }
      break;
    }
    case 'month': {
      const what = r.nthWeekday
        ? `${ORD(r.nthWeekday.n)} ${WEEKDAYS_LONG[r.nthWeekday.weekday - 1]}`
        : r.monthDay === -1
          ? 'Monatsletzten'
          : r.monthDay
            ? `${r.monthDay}.`
            : '';
      if (r.nthWeekday) text = n === 1 ? `jeden ${what} im Monat` : `alle ${n} Monate am ${what}`;
      else text = n === 1 ? `monatlich${what ? ` am ${what}` : ''}` : `alle ${n} Monate${what ? ` am ${what}` : ''}`;
      break;
    }
    case 'year': {
      const month = r.month ? MONTHS_LONG[r.month - 1] : '';
      const what = r.nthWeekday
        ? `${ORD(r.nthWeekday.n)} ${WEEKDAYS_LONG[r.nthWeekday.weekday - 1]} im ${month}`
        : r.monthDay && month
          ? `${r.monthDay === -1 ? 'letzten Tag im' : `${r.monthDay}.`} ${month}`
          : '';
      text = n === 1 ? `jährlich${what ? ` am ${what}` : ''}` : `alle ${n} Jahre${what ? ` am ${what}` : ''}`;
      break;
    }
  }
  if (r.afterCompletion) text += ' nach Erledigung';
  return text;
}

/**
 * Alle Termine einer (nicht von Erledigung abhängigen) Wiederholung im Zeitraum, beginnend bei `start`.
 * Ohne Wiederholung nur `start` selbst, falls im Zeitraum.
 */
export function occurrencesBetween(start: PlainDate, r: Recurrence | null | undefined, from: PlainDate, to: PlainDate, max = 800): PlainDate[] {
  const out: PlainDate[] = [];
  if (start >= from && start <= to) out.push(start);
  if (!r || r.afterCompletion) return out;
  let d = start;
  for (let i = 0; i < max; i++) {
    const n = nextOccurrence(r, d, d);
    if (!n || n > to || n <= d) break;
    if (n >= from) out.push(n);
    d = n;
  }
  return out;
}

/** Wiederholung als iCalendar-RRULE (ohne "nach Erledigung", das kennt iCalendar nicht). */
export function toRRule(r: Recurrence): string | null {
  if (r.afterCompletion) return null;
  const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const parts = [`FREQ=${({ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as const)[r.freq]}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.weekdays?.length) parts.push(`BYDAY=${r.weekdays.map((w) => DAYS[w - 1]).join(',')}`);
  if (r.nthWeekday) parts.push(`BYDAY=${r.nthWeekday.n}${DAYS[r.nthWeekday.weekday - 1]}`);
  else if (r.monthDay !== undefined) parts.push(`BYMONTHDAY=${r.monthDay}`);
  if (r.month) parts.push(`BYMONTH=${r.month}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, '')}`);
  return parts.join(';');
}
