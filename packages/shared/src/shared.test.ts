import { describe, expect, it } from 'vitest';
import {
  addMonths,
  completeTaskChanges,
  describeRecurrence,
  easterSunday,
  formatDateRelative,
  HybridClock,
  isoWeekday,
  nextOccurrence,
  nthWeekdayOfMonth,
  parseHlc,
  uuidv7,
  UUID_RE,
  zonedParts,
  zonedToUtc,
  type Recurrence,
} from './index';

describe('Datum', () => {
  it('Wochentage und Monatsrechnung', () => {
    expect(isoWeekday('2026-11-20')).toBe(5);
    expect(isoWeekday('2026-11-22')).toBe(7);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('n-ter Wochentag', () => {
    expect(nthWeekdayOfMonth(2026, 11, 5, -1)).toBe('2026-11-27');
    expect(nthWeekdayOfMonth(2026, 12, 1, 1)).toBe('2026-12-07');
    expect(nthWeekdayOfMonth(2026, 2, 1, 5)).toBeNull();
  });

  it('Ostern', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2024)).toBe('2024-03-31');
  });

  it('Zeitzonen inkl. Zeitumstellung', () => {
    expect(zonedToUtc('2026-11-20', '15:00', 'Europe/Berlin').toISOString()).toBe('2026-11-20T14:00:00.000Z');
    expect(zonedToUtc('2027-07-01', '08:00', 'Europe/Berlin').toISOString()).toBe('2027-07-01T06:00:00.000Z');
    expect(zonedToUtc('2027-03-28', '03:30', 'Europe/Berlin').toISOString()).toBe('2027-03-28T01:30:00.000Z');
    expect(zonedParts(new Date('2026-11-20T23:30:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-11-21', time: '00:30', second: 0 });
  });

  it('relative Anzeige', () => {
    expect(formatDateRelative('2026-11-20', '2026-11-20')).toBe('Heute');
    expect(formatDateRelative('2026-11-21', '2026-11-20')).toBe('Morgen');
    expect(formatDateRelative('2026-11-24', '2026-11-20')).toBe('Dienstag');
    expect(formatDateRelative('2026-12-24', '2026-11-20')).toBe('Do., 24. Dez.');
    expect(formatDateRelative('2027-01-05', '2026-11-20')).toBe('5. Jan. 2027');
  });
});

describe('Wiederholung', () => {
  const r = (x: Partial<Recurrence> & Pick<Recurrence, 'freq'>): Recurrence => ({ interval: 1, ...x });

  it('täglich und nach Erledigung', () => {
    expect(nextOccurrence(r({ freq: 'day' }), '2026-11-20', '2026-11-20')).toBe('2026-11-21');
    expect(nextOccurrence(r({ freq: 'day', interval: 3 }), '2026-11-10', '2026-11-20')).toBe('2026-11-22');
    expect(nextOccurrence(r({ freq: 'day', interval: 3, afterCompletion: true }), '2026-11-10', '2026-11-20')).toBe('2026-11-23');
  });

  it('wöchentlich an Tagen, auch überfällig', () => {
    const mo = r({ freq: 'week', weekdays: [1] });
    expect(nextOccurrence(mo, '2026-11-16', '2026-11-16')).toBe('2026-11-23');
    expect(nextOccurrence(mo, '2026-11-02', '2026-11-20')).toBe('2026-11-23');
    const werktags = r({ freq: 'week', weekdays: [1, 2, 3, 4, 5] });
    expect(nextOccurrence(werktags, '2026-11-20', '2026-11-20')).toBe('2026-11-23');
    const zweiWochen = r({ freq: 'week', interval: 2, weekdays: [2] });
    expect(nextOccurrence(zweiWochen, '2026-11-17', '2026-11-17')).toBe('2026-12-01');
  });

  it('monatlich und jährlich', () => {
    expect(nextOccurrence(r({ freq: 'month', monthDay: 31 }), '2026-10-31', '2026-10-31')).toBe('2026-11-30');
    expect(nextOccurrence(r({ freq: 'month', monthDay: -1 }), '2026-11-30', '2026-11-30')).toBe('2026-12-31');
    expect(nextOccurrence(r({ freq: 'month', nthWeekday: { n: -1, weekday: 5 } }), '2026-11-27', '2026-11-27')).toBe('2026-12-25');
    expect(nextOccurrence(r({ freq: 'year', month: 2, monthDay: 29 }), '2028-02-29', '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence(r({ freq: 'day', until: '2026-11-21' }), '2026-11-21', '2026-11-21')).toBeNull();
  });

  it('Beschreibung', () => {
    expect(describeRecurrence(r({ freq: 'week', weekdays: [1] }))).toBe('jeden Montag');
    expect(describeRecurrence(r({ freq: 'week', weekdays: [1, 2, 3, 4, 5] }))).toBe('werktags');
    expect(describeRecurrence(r({ freq: 'day', interval: 3, afterCompletion: true }))).toBe('alle 3 Tage nach Erledigung');
    expect(describeRecurrence(r({ freq: 'month', nthWeekday: { n: -1, weekday: 5 } }))).toBe('jeden letzten Freitag im Monat');
    expect(describeRecurrence(r({ freq: 'year', month: 5, monthDay: 3 }))).toBe('jährlich am 3. Mai');
  });

  it('Abhaken mit Rotation', () => {
    const changes = completeTaskChanges(
      { recurrence: r({ freq: 'week', weekdays: [6] }), dueDate: '2026-11-21', deadline: null, rotation: ['a', 'b'], assigneeId: 'a' },
      '2026-11-21',
      'a',
      'now',
    );
    expect(changes).toEqual({ dueDate: '2026-11-28', lastCompletedAt: 'now', lastCompletedBy: 'a', assigneeId: 'b' });
    expect(completeTaskChanges({ recurrence: null, dueDate: null, deadline: null, rotation: [], assigneeId: null }, '2026-11-21', 'a', 'now')).toEqual({
      completedAt: 'now',
      completedBy: 'a',
    });
  });
});

describe('IDs und Uhr', () => {
  it('uuidv7 ist gültig und sortierbar', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a).toMatch(UUID_RE);
    expect(a < b).toBe(true);
  });

  it('HLC ist monoton', () => {
    let t = 1000;
    const c = new HybridClock('n1', () => t);
    const a = c.tick();
    const b = c.tick();
    expect(b > a).toBe(true);
    c.receive('0000000005000-00003-x');
    t = 1001;
    const d = c.tick();
    expect(parseHlc(d)).toEqual({ ms: 5000, counter: 5, node: 'n1' });
  });
});
