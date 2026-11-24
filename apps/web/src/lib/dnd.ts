import { generateKeyBetween, generateNKeysBetween } from '@do-it/shared';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { db } from './db';
import { createStore } from './store';
import { sync } from './sync';

export interface DragState {
  id: string | null;
  overId: string | null;
  pos: 'before' | 'after';
  /** Ziel-Abschnitt ('' = ohne Abschnitt), undefined = kein Ziel */
  overSection: string | undefined;
}

const idle: DragState = { id: null, overId: null, pos: 'before', overSection: undefined };
export const dragState = createStore<DragState>(idle);

/** Ziehen am Griff starten (Maus und Touch). */
export function startDrag(e: ReactPointerEvent<HTMLElement>, taskId: string, projectId: string): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  dragState.set({ ...idle, id: taskId });

  const move = (ev: PointerEvent) => {
    const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const li = target?.closest<HTMLElement>('[data-sortable="1"]');
    if (li && li.dataset.taskId !== taskId) {
      const r = li.getBoundingClientRect();
      dragState.set((s) => ({ ...s, overId: li.dataset.taskId!, pos: ev.clientY < r.top + r.height / 2 ? 'before' : 'after', overSection: li.dataset.sectionId ?? '' }));
    } else {
      const zone = target?.closest<HTMLElement>('[data-drop-section]');
      if (zone) dragState.set((s) => ({ ...s, overId: null, overSection: zone.dataset.dropSection ?? '' }));
    }
    if (ev.clientY < 70) window.scrollBy(0, -14);
    else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
  };
  const finish = (drop: boolean) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    const s = dragState.get();
    dragState.set(idle);
    if (drop && s.overSection !== undefined) void dropTask(taskId, projectId, s);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
}

/** Neue Position berechnen und speichern. Bei doppelten Schlüsseln werden die Geschwister neu durchnummeriert. */
async function dropTask(taskId: string, projectId: string, s: DragState): Promise<void> {
  const sectionId = s.overSection || null;
  const siblings = (await db.tasks.where('projectId').equals(projectId).toArray())
    .filter((t) => !t.parentId && !t.completedAt && (t.sectionId ?? null) === sectionId && t.id !== taskId)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  let index = siblings.length;
  if (s.overId) {
    const i = siblings.findIndex((t) => t.id === s.overId);
    if (i >= 0) index = s.pos === 'before' ? i : i + 1;
  }
  const prev = siblings[index - 1]?.sortKey ?? null;
  const next = siblings[index]?.sortKey ?? null;
  try {
    const key = generateKeyBetween(prev, next);
    await sync.mutate('task', taskId, 'put', { sortKey: key, sectionId }, { ifExists: true });
  } catch {
    // gleiche Schlüssel (z. B. offline auf zwei Geräten angelegt): alles neu verteilen
    const order = [...siblings];
    order.splice(index, 0, { id: taskId } as (typeof siblings)[number]);
    const keys = generateNKeysBetween(null, null, order.length);
    for (let i = 0; i < order.length; i++) {
      await sync.mutate('task', order[i]!.id, 'put', order[i]!.id === taskId ? { sortKey: keys[i], sectionId } : { sortKey: keys[i] }, { ifExists: true });
    }
  }
}
