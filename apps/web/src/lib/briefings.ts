import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { syncState } from './sync';

export interface Briefing {
  id: string;
  title: string;
  body: string;
  source: string;
  createdAt: string;
  read: boolean;
}

/** Briefings vom Server; lädt neu, sobald der Sync etwas Neues meldet. */
export function useBriefings(): { list: Briefing[]; reload: () => void; markRead: (id: string) => Promise<void>; remove: (id: string) => Promise<void> } {
  const briefingAt = syncState.select((s) => s.briefingAt);
  const [list, setList] = useState<Briefing[]>([]);
  const reload = useCallback(() => {
    api<{ briefings: Briefing[] }>('GET', '/api/briefings')
      .then((r) => setList(r.briefings))
      .catch(() => {});
  }, []);
  useEffect(reload, [reload, briefingAt]);
  return {
    list,
    reload,
    async markRead(id) {
      setList((l) => l.map((b) => (b.id === id ? { ...b, read: true } : b)));
      await api('POST', `/api/briefings/${id}/read`).catch(() => {});
    },
    async remove(id) {
      setList((l) => l.filter((b) => b.id !== id));
      await api('DELETE', `/api/briefings/${id}`).catch(() => {});
    },
  };
}
