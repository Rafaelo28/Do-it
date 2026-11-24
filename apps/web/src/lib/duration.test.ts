import { parseTask } from '@do-it/parser';
import { describe, expect, it } from 'vitest';
import type { Task } from './db';
import { DURATION_PRESETS, durationText, suggestDuration } from './duration';

const task = (id: string, title: string, durationMin: number | null, createdAt = '2026-11-01T10:00:00Z') => ({ id, title, durationMin, createdAt }) as Task;

describe('Dauer-Vorschläge', () => {
  const tasks = [
    task('1', 'Joggen', 45, '2026-11-01T10:00:00Z'),
    task('2', 'Joggen', 60, '2026-11-08T10:00:00Z'),
    task('3', 'Joggen', 45, '2026-11-15T10:00:00Z'),
    task('4', 'Wochenbericht schreiben', 90),
    task('5', 'Bericht für Kunde schreiben', 120),
    task('6', 'Einkaufen', null),
  ];

  it('gleicher Titel: Median der bisherigen Dauern', () => {
    expect(suggestDuration('joggen', tasks)).toEqual({ min: 45, from: 'Joggen' });
  });

  it('ähnlicher Titel (mindestens die Hälfte der Wörter gemeinsam)', () => {
    expect(suggestDuration('Wochenbericht schreiben für Chef', tasks)?.min).toBe(90);
    expect(suggestDuration('Bericht Kunde schreiben', tasks)?.min).toBe(120);
  });

  it('nichts Ähnliches oder keine Dauer: kein Vorschlag', () => {
    expect(suggestDuration('Einkaufen', tasks)).toBeNull();
    expect(suggestDuration('Zahnarzt anrufen', tasks)).toBeNull();
    expect(suggestDuration('ab', tasks)).toBeNull();
    // die eigene Aufgabe zählt nicht
    expect(suggestDuration('Wochenbericht schreiben', [tasks[3]!], '4')).toBeNull();
  });

  it('eingefügte Dauer erkennt der Parser wieder', () => {
    for (const m of [...DURATION_PRESETS, 240]) {
      const r = parseTask(`Joggen morgen 7 Uhr ${durationText(m)}`, { today: '2026-11-24', now: '10:00' });
      expect([m, r.durationMin, r.title]).toEqual([m, m, 'Joggen']);
    }
  });
});
