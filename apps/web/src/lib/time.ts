import { zonedParts, type PlainDate, type PlainTime } from '@do-it/shared';
import { useSyncExternalStore } from 'react';

let tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
}

export function nowLocal(): { date: PlainDate; time: PlainTime } {
  const p = zonedParts(new Date(), tz);
  return { date: p.date, time: p.time };
}

/** Kalendertag eines Zeitpunkts (ISO) in der Zeitzone des Nutzers. */
export function localDateOf(iso: string): PlainDate {
  return zonedParts(new Date(iso), tz).date;
}

export function todayLocal(): PlainDate {
  return nowLocal().date;
}

// Eine gemeinsame Uhr für die ganze App – statt eines eigenen Intervalls in jeder Aufgabe.
let current = nowLocal();
const listeners = new Set<() => void>();
let timer: number | null = null;

function tick(): void {
  const n = nowLocal();
  if (n.date === current.date && n.time === current.time) return;
  current = n;
  for (const l of listeners) l();
}

function onVisible(): void {
  if (document.visibilityState === 'visible') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    tick();
    timer = window.setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function setTimeZone(zone: string): void {
  tz = zone;
  tick();
}

/** Aktuelles Datum/Uhrzeit in der Zeitzone des Nutzers, aktualisiert sich minütlich. */
export function useNow(): { date: PlainDate; time: PlainTime } {
  return useSyncExternalStore(subscribe, () => current);
}
