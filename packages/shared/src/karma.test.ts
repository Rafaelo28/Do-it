import { describe, expect, it } from 'vitest';
import { completionPoints, karmaLevel, karmaStreak, KARMA_LEVELS, type KarmaPrefs } from './karma';

const prefs: KarmaPrefs = { dailyGoal: 3, weeklyGoal: 15, daysOff: [], vacations: [] };

describe('Karma', () => {
  it('Stufen und Fortschritt', () => {
    expect(karmaLevel(0)).toMatchObject({ current: { level: 1, name: 'Samenkorn' }, next: { level: 2 }, progress: 0 });
    expect(karmaLevel(29).current.level).toBe(1);
    expect(karmaLevel(30).current).toMatchObject({ level: 2, name: 'Keimling' });
    expect(karmaLevel(65).progress).toBeCloseTo(0.5);
    expect(karmaLevel(1_000_000)).toMatchObject({ current: { level: 10, name: 'Urwald' }, next: null, progress: 1 });
    // Schwellen steigen streng
    for (let i = 1; i < KARMA_LEVELS.length; i++) expect(KARMA_LEVELS[i]!.min).toBeGreaterThan(KARMA_LEVELS[i - 1]!.min);
  });

  it('Punkte fürs Erledigen', () => {
    expect(completionPoints({ priority: 4, dueDate: null, parentId: null }, '2026-11-21')).toBe(2);
    expect(completionPoints({ priority: 1, dueDate: '2026-11-21', parentId: null }, '2026-11-21')).toBe(6);
    expect(completionPoints({ priority: 2, dueDate: '2026-11-20', parentId: null }, '2026-11-21')).toBe(4);
    expect(completionPoints({ priority: 3, dueDate: '2026-11-30', parentId: 'x' }, '2026-11-21')).toBe(3);
  });

  it('Serie: Heute zählt erst, wenn erreicht, unterbricht aber nicht', () => {
    const counts = new Map([
      ['2026-11-18', 3],
      ['2026-11-19', 4],
      ['2026-11-20', 3],
    ]);
    expect(karmaStreak(counts, '2026-11-21', prefs, '2026-11-18')).toEqual({ current: 3, best: 3 });
    counts.set('2026-11-21', 3);
    expect(karmaStreak(counts, '2026-11-21', prefs, '2026-11-18')).toEqual({ current: 4, best: 4 });
  });

  it('Serie: verpasster Tag unterbricht, freie Tage und Urlaub nicht', () => {
    // Mo 16., Di 17. erreicht; Mi 18. verpasst; Do 19., Fr 20. erreicht; Sa 21. frei; So 22. heute
    const counts = new Map([
      ['2026-11-16', 3],
      ['2026-11-17', 3],
      ['2026-11-19', 5],
      ['2026-11-20', 3],
    ]);
    expect(karmaStreak(counts, '2026-11-22', { ...prefs, daysOff: [6, 7] }, '2026-11-16')).toEqual({ current: 2, best: 2 });
    expect(karmaStreak(counts, '2026-11-22', prefs, '2026-11-16')).toEqual({ current: 0, best: 2 });
    const vacation = { ...prefs, daysOff: [6, 7], vacations: [{ from: '2026-11-18', to: '2026-11-18' }] };
    expect(karmaStreak(counts, '2026-11-22', vacation, '2026-11-16')).toEqual({ current: 4, best: 4 });
    expect(karmaStreak(new Map(), '2026-11-22', prefs, null)).toEqual({ current: 0, best: 0 });
  });
});
