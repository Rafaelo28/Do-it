/**
 * Kalenderdaten ohne Zeitzone ("2026-11-20") und Uhrzeiten ("15:30").
 * Rechnen passiert über UTC, damit Sommer-/Winterzeit keine Rolle spielt.
 */
export type PlainDate = string;
export type PlainTime = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isPlainDate(s: unknown): s is PlainDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  return !!m && isValidDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isPlainTime(s: unknown): s is PlainTime {
  return typeof s === 'string' && TIME_RE.test(s);
}

export function toParts(d: PlainDate): [number, number, number] {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`Ungültiges Datum: ${d}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** Baut ein Datum; Überläufe (z. B. 32. Januar) werden normalisiert. */
export function fromParts(y: number, m: number, d: number): PlainDate {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isValidDate(y: number, m: number, d: number): boolean {
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toUtcMs(d: PlainDate): number {
  const [y, m, day] = toParts(d);
  return Date.UTC(y, m - 1, day);
}

export function addDays(d: PlainDate, n: number): PlainDate {
  const [y, m, day] = toParts(d);
  return fromParts(y, m, day + n);
}

/** Monate addieren; der Tag wird auf das Monatsende begrenzt (31.01. + 1 Monat = 28./29.02.). */
export function addMonths(d: PlainDate, n: number): PlainDate {
  const [y, m, day] = toParts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fromParts(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export function addYears(d: PlainDate, n: number): PlainDate {
  return addMonths(d, n * 12);
}

/** ISO-Wochentag: 1 = Montag … 7 = Sonntag. */
export function isoWeekday(d: PlainDate): number {
  const wd = new Date(toUtcMs(d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Tage von a bis b (b - a). */
export function diffDays(a: PlainDate, b: PlainDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxDate(a: PlainDate, b: PlainDate): PlainDate {
  return a > b ? a : b;
}

export function startOfIsoWeek(d: PlainDate): PlainDate {
  return addDays(d, 1 - isoWeekday(d));
}

export function endOfMonth(d: PlainDate): PlainDate {
  const [y, m] = toParts(d);
  return fromParts(y, m, daysInMonth(y, m));
}

/** Nächster Termin des Wochentags; mit includeToday zählt heute mit. */
export function nextWeekday(from: PlainDate, weekday: number, includeToday = false): PlainDate {
  let delta = (weekday - isoWeekday(from) + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(from, delta);
}

/** n-ter Wochentag im Monat (n = 1..5, -1 = letzter). null, wenn es ihn nicht gibt. */
export function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): PlainDate | null {
  if (n === -1) {
    const last = fromParts(y, m, daysInMonth(y, m));
    const delta = (isoWeekday(last) - weekday + 7) % 7;
    return addDays(last, -delta);
  }
  const first = fromParts(y, m, 1);
  const firstMatch = nextWeekday(first, weekday, true);
  const result = addDays(firstMatch, (n - 1) * 7);
  return toParts(result)[1] === m ? result : null;
}

/** Ostersonntag (gregorianisch, Algorithmus nach Meeus/Jones/Butcher). */
export function easterSunday(year: number): PlainDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fromParts(year, month, day);
}

export function timeToMinutes(t: PlainTime): number {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function minutesToTime(min: number): PlainTime {
  const norm = ((min % 1440) + 1440) % 1440;
  return `${pad(Math.floor(norm / 60))}:${pad(norm % 60)}`;
}

export function makeTime(h: number, m = 0): PlainTime {
  return `${pad(h)}:${pad(m)}`;
}

// ---------- Zeitzonen ----------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  date: PlainDate;
  time: PlainTime;
  second: number;
}

/** Datum und Uhrzeit eines Zeitpunkts in einer Zeitzone. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24;
  return {
    date: fromParts(get('year'), get('month'), get('day')),
    time: makeTime(hour, get('minute')),
    second: get('second'),
  };
}

function offsetMs(instant: number, tz: string): number {
  const p = zonedParts(new Date(instant), tz);
  const [y, m, d] = toParts(p.date);
  const [h, mi] = p.time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, h, mi, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Lokales Datum + Uhrzeit in einer Zeitzone → echter Zeitpunkt. */
export function zonedToUtc(date: PlainDate, time: PlainTime, tz: string): Date {
  const [y, m, d] = toParts(date);
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(guess, tz);
  let result = guess - off1;
  const off2 = offsetMs(result, tz);
  if (off2 !== off1) result = guess - off2;
  return new Date(result);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

// ---------- Anzeige ----------

export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const MONTHS_LONG = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
export const MONTHS_SHORT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

/** "Heute", "Morgen", "Gestern", "Mo., 23. Nov." oder "23. Nov. 2027". */
export function formatDateRelative(d: PlainDate, today: PlainDate): string {
  const diff = diffDays(today, d);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  if (diff === 2) return 'Übermorgen';
  const [y, m, day] = toParts(d);
  const [ty] = toParts(today);
  const wd = WEEKDAYS_SHORT[isoWeekday(d) - 1];
  if (diff > 2 && diff < 7) return WEEKDAYS_LONG[isoWeekday(d) - 1]!;
  const base = `${wd}., ${day}. ${MONTHS_SHORT[m - 1]}`;
  return y === ty ? base : `${day}. ${MONTHS_SHORT[m - 1]} ${y}`;
}

export function formatDateLong(d: PlainDate): string {
  const [y, m, day] = toParts(d);
  return `${WEEKDAYS_LONG[isoWeekday(d) - 1]}, ${day}. ${MONTHS_LONG[m - 1]} ${y}`;
}
