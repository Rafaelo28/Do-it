import { useEffect, useRef, useState } from 'react';
import { toggleTask } from '../lib/actions';
import type { Task } from '../lib/db';
import { syncState } from '../lib/sync';
import { IconCheck } from './Icons';
import { PRIORITY_COLOR } from './ui';

const ROW = '.task, .board-card';
/** Kreis gefüllt zeigen, bevor die Zeile wegklappt */
const SHOW_MS = 320;
const COLLAPSE_MS = 180;

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Abhaken mit kurzer Rückmeldung: Kreis füllt sich, Titel wird durchgestrichen, die Zeile klappt weg –
 * erst dann wird gespeichert. So rutscht die nächste Aufgabe nicht unbemerkt unter den Finger.
 */
export function CheckButton({ task, size = 13 }: { task: Task; size?: number }) {
  const me = syncState.select((s) => s.me);
  const [completing, setCompleting] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const timers = useRef<number[]>([]);

  const restore = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const row = btn.current?.closest<HTMLElement>(ROW);
    if (row) {
      row.classList.remove('collapsing');
      row.style.height = '';
    }
    setCompleting(false);
  };

  // Zeile bleibt sichtbar (Wiederholung, Rückgängig, Ansicht mit Erledigten): wieder normal anzeigen
  useEffect(() => {
    if (completing) restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.completedAt, task.dueDate]);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!me || completing) return;
    if (task.completedAt) {
      void toggleTask(task, me);
      return;
    }
    setCompleting(true);
    try {
      navigator.vibrate?.(10);
    } catch {
      // nicht überall erlaubt
    }
    const motion = !reducedMotion();
    const save = () => void toggleTask(task, me);
    timers.current.push(
      window.setTimeout(
        () => {
          const row = btn.current?.closest<HTMLElement>(ROW);
          // Wiederholungen bleiben in der Liste (neues Datum): nicht wegklappen
          if (motion && row && !task.recurrence) {
            row.style.height = `${row.offsetHeight}px`;
            void row.offsetHeight;
            row.classList.add('collapsing');
            row.style.height = '0px';
            timers.current.push(window.setTimeout(save, COLLAPSE_MS));
          } else save();
        },
        motion ? SHOW_MS : 0,
      ),
    );
  };

  return (
    <button
      ref={btn}
      className={`check ${task.completedAt || completing ? 'done' : ''} ${completing ? 'completing' : ''}`}
      style={{ '--pc': PRIORITY_COLOR[task.priority] } as React.CSSProperties}
      aria-label={task.completedAt ? 'Als offen markieren' : 'Erledigt'}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <IconCheck size={size} />
    </button>
  );
}
