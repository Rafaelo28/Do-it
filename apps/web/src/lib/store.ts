import { useSyncExternalStore } from 'react';

/** Winziger globaler Zustand ohne Bibliothek. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const get = () => state;
  return {
    get,
    set(next: T | ((s: T) => T)) {
      const value = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      if (value === state) return;
      state = value;
      for (const l of listeners) l();
    },
    subscribe,
    /** ganzen Zustand abonnieren */
    use(): T {
      return useSyncExternalStore(subscribe, get, get);
    },
    /**
     * Nur einen Ausschnitt abonnieren: neu gezeichnet wird nur, wenn sich dieser ändert.
     * Der Selektor muss einen einfachen Wert oder eine stabile Referenz liefern.
     */
    select<S>(selector: (s: T) => S): S {
      return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
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
