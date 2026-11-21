import { useSyncExternalStore } from 'react';

/** true, solange die Media-Query zutrifft (z. B. schmaler Bildschirm) */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Handy-Breite: Kalender kompakt, Monat mit Punkten statt Einträgen */
export const NARROW = '(max-width: 600px)';
