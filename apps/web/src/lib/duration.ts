import { fold } from '@do-it/parser';
import type { Task } from './db';

/** Schnellauswahl für die Dauer (Minuten) */
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120, 180];

const STOP = new Set(['und', 'oder', 'mit', 'fuer', 'von', 'vom', 'zum', 'zur', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einen', 'beim', 'bei', 'auf', 'aus', 'nach']);

function words(title: string): Set<string> {
  return new Set(
    fold(title)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)),
  );
}

export interface DurationSuggestion {
  min: number;
  /** Beispiel, woher der Vorschlag kommt */
  from: string;
}

/**
 * Gelernter Vorschlag (keine KI): Dauer ähnlicher Aufgaben, die schon eine Dauer hatten.
 * Ähnlich = gleicher Titel oder mindestens die Hälfte der Wörter gemeinsam; bei mehreren der Median.
 */
export function suggestDuration(title: string, tasks: Task[], exceptId?: string): DurationSuggestion | null {
  const mine = words(title);
  if (!mine.size) return null;
  const key = fold(title.trim());
  let best = 0;
  let hits: Task[] = [];
  for (const t of tasks) {
    if (!t.durationMin || t.id === exceptId) continue;
    let score: number;
    if (fold(t.title.trim()) === key) score = 2;
    else {
      const other = words(t.title);
      if (!other.size) continue;
      let common = 0;
      for (const w of mine) if (other.has(w)) common++;
      score = common / new Set([...mine, ...other]).size;
    }
    if (score < 0.5) continue;
    if (score > best + 1e-9) {
      best = score;
      hits = [t];
    } else if (Math.abs(score - best) < 1e-9) hits.push(t);
  }
  if (!hits.length) return null;
  const sorted = hits.map((t) => t.durationMin!).sort((a, b) => a - b);
  // neueste Beispiele bevorzugen, falls gleich gut
  const example = hits.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  return { min: sorted[Math.floor(sorted.length / 2)]!, from: example.title };
}

/** "45 min", "1,5 h" – so geschrieben, dass der Parser es wieder erkennt */
export function durationText(min: number): string {
  return min < 60 ? `${min} min` : `${String(Math.round((min / 60) * 100) / 100).replace('.', ',')} h`;
}
