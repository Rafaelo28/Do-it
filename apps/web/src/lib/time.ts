import { zonedParts, type PlainDate, type PlainTime } from '@do-it/shared';
import { useEffect, useState } from 'react';

let tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';

export function setTimeZone(zone: string): void {
  tz = zone;
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
}

export function nowLocal(): { date: PlainDate; time: PlainTime } {
  const p = zonedParts(new Date(), tz);
  return { date: p.date, time: p.time };
}

export function todayLocal(): PlainDate {
  return nowLocal().date;
}

/** Aktuelles Datum/Uhrzeit, aktualisiert jede Minute (für Ansichten wie "Heute"). */
export function useNow(): { date: PlainDate; time: PlainTime } {
  const [now, setNow] = useState(nowLocal);
  useEffect(() => {
    const t = setInterval(() => setNow(nowLocal()), 30_000);
    const vis = () => document.visibilityState === 'visible' && setNow(nowLocal());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return now;
}
