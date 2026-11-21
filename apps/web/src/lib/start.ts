import { START_PAGE_PATTERN, type UserSettings } from '@do-it/shared';
import type { Data } from './data';

/** Pfad der Startseite – fällt auf "Heute" zurück, wenn Projekt oder Filter nicht mehr existieren. */
export function startPath(settings: Partial<UserSettings> | undefined, data: Pick<Data, 'projectMap'>): string {
  const p = settings?.startPage ?? '/today';
  if (!START_PAGE_PATTERN.test(p)) return '/today';
  const project = /^\/project\/([\w-]+)$/.exec(p)?.[1];
  if (project) {
    const pr = data.projectMap.get(project);
    return pr && !pr.archived ? p : '/today';
  }
  const filter = /^\/f\/([\w-]+)$/.exec(p)?.[1];
  if (filter) return settings?.filters?.some((f) => f.id === filter) ? p : '/today';
  return p;
}

/** Adresse beim Start der App (bevor die App selbst navigiert) */
export const LAUNCH_PATH = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
