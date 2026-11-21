import type { UserSettings, ViewPref } from '@do-it/shared';
import { api } from './api';
import type { Me } from '@do-it/shared';
import { toast } from './store';
import { syncState } from './sync';

/** Einstellungen sofort lokal übernehmen und im Hintergrund speichern (für alle Geräte). */
export async function updateSettings(patch: Partial<UserSettings>): Promise<void> {
  syncState.set((s) => (s.me ? { ...s, me: { ...s.me, settings: { ...s.me.settings, ...patch } } } : s));
  try {
    const r = await api<{ user: Me }>('PATCH', '/api/me', { settings: patch });
    syncState.set((s) => ({ ...s, me: r.user }));
  } catch (e) {
    toast(`Nicht gespeichert: ${(e as Error).message}`, { kind: 'error' });
  }
}

const EMPTY: Record<string, ViewPref> = {};

/** Darstellung einer Ansicht (Liste/Board/Kalender/Tabelle …), pro Person synchronisiert. */
export function useViewPref(key: string, fallback: ViewPref): [ViewPref, (p: Partial<ViewPref>) => void] {
  const views = syncState.select((s) => s.me?.settings.views ?? EMPTY);
  const pref = { ...fallback, ...views[key] };
  const set = (p: Partial<ViewPref>) => {
    const current = syncState.get().me?.settings.views ?? {};
    void updateSettings({ views: { ...current, [key]: { ...current[key], ...p } } });
  };
  return [pref, set];
}
