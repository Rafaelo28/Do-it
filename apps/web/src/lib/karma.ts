import { completionPoints, type KarmaSummary } from '@do-it/shared';
import { api } from './api';
import { createStore, toast } from './store';
import { syncState } from './sync';

/** Karma vom Server; nach jeder Synchronisierung (gebremst) aufgefrischt. */
export const karmaState = createStore<KarmaSummary | null>(null);

let inflight = false;
let lastFetch = 0;
let timer: number | null = null;

export async function refreshKarma(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const next = await api<KarmaSummary>('GET', '/api/karma');
    const prev = karmaState.get();
    karmaState.set(next);
    if (prev && next.enabled) {
      if (next.level.level > prev.level.level) toast(`Neue Karma-Stufe: ${next.level.name} (Stufe ${next.level.level})`, {}, 7000);
      else if (next.today.reached && !prev.today.reached && next.today.date === prev.today.date) toast(`Tagesziel geschafft – ${next.today.done} erledigt`, {}, 6000);
      else if (next.week.reached && !prev.week.reached && next.week.from === prev.week.from) toast('Wochenziel geschafft', {}, 6000);
    }
  } catch {
    /* offline: alter Stand bleibt */
  } finally {
    inflight = false;
    lastFetch = Date.now();
  }
}

export function startKarmaUpdates(): () => void {
  let last = syncState.get().lastSync;
  void refreshKarma();
  const unsubscribe = syncState.subscribe(() => {
    const s = syncState.get();
    if (s.lastSync === last) return;
    last = s.lastSync;
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => void refreshKarma(), Math.max(600, 3000 - (Date.now() - lastFetch)));
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

/** Punkte, die das Erledigen gerade bringt (für die Rückmeldung beim Abhaken). */
export function pointsFor(task: { priority: number; dueDate: string | null; parentId: string | null }, today: string): number | null {
  const me = syncState.get().me;
  if (!me?.settings.karmaEnabled) return null;
  return completionPoints(task, today);
}
