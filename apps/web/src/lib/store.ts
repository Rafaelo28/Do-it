import { useSyncExternalStore } from 'react';

/** Winziger globaler Zustand ohne Bibliothek. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((s: T) => T)) {
      state = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    use(): T {
      return useSyncExternalStore(this.subscribe, this.get, this.get);
    },
  };
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  kind?: 'info' | 'error';
}

export const toasts = createStore<Toast[]>([]);
let toastId = 0;

export function toast(text: string, opts: Omit<Toast, 'id' | 'text'> = {}, ms = 5000): void {
  const id = ++toastId;
  toasts.set((t) => [...t.slice(-2), { id, text, ...opts }]);
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), ms);
}

export function dismissToast(id: number): void {
  toasts.set((t) => t.filter((x) => x.id !== id));
}
