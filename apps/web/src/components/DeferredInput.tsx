import { isPlainDate, isPlainTime } from '@do-it/shared';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onCommit: (value: string) => void;
  /** Speichern so viele ms nach der letzten Änderung (zusätzlich beim Verlassen und mit Enter) */
  delay?: number;
};

/** Nur vollständige, gültige Werte speichern (z. B. kein Jahr 122026 beim Tippen) */
function valid(type: string | undefined, v: string): boolean {
  if (v === '') return true;
  if (type === 'date') return isPlainDate(v) && v >= '1900-01-01' && v <= '2199-12-31';
  if (type === 'time') return isPlainTime(v);
  if (type === 'number') return Number.isFinite(Number(v));
  return true;
}

/**
 * Eingabefeld (Datum, Uhrzeit, Zahl), das seinen Wert behält, solange man darin tippt.
 * Würde jeder Zwischenstand sofort gespeichert und neu gesetzt, springt der Browser beim
 * Uhrzeit-Feld aus dem Minutenteil – aus "16:30" wurde "16:00".
 */
export function DeferredInput({ value, onCommit, delay = 800, onFocus, onBlur, onKeyDown, ...rest }: Props) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };

  const flush = () => {
    window.clearTimeout(timer.current);
    const v = pending.current;
    pending.current = null;
    if (v !== null && v !== latest.current.value && valid(rest.type, v)) latest.current.onCommit(v);
  };

  // Änderungen von außen (anderes Gerät, Schnellauswahl) übernehmen – aber nicht mitten im Tippen
  useEffect(() => {
    if (!focused.current && pending.current === null) setLocal(value);
  }, [value]);

  // beim Verlassen der Seite nichts verlieren
  useEffect(() => () => flush(), []);

  return (
    <input
      {...rest}
      value={local}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        pending.current = e.target.value;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, delay);
      }}
      onBlur={(e) => {
        focused.current = false;
        // ungültig oder unverändert: wieder den gespeicherten Wert zeigen
        if (pending.current === null || !valid(rest.type, pending.current)) setLocal(latest.current.value);
        flush();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush();
        onKeyDown?.(e);
      }}
    />
  );
}
