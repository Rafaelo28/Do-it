import { describeRecurrence, formatDateRelative, type Recurrence } from '@do-it/shared';
import { useEffect, type ReactNode } from 'react';
import { dismissToast, toasts } from '../lib/store';

export const PRIORITY_COLOR: Record<number, string> = { 1: 'var(--p1)', 2: 'var(--p2)', 3: 'var(--p3)', 4: 'var(--p4)' };

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function dueLabel(date: string | null, time: string | null, today: string): string {
  if (!date) return '';
  const d = formatDateRelative(date, today);
  return time ? `${d} ${time}` : d;
}

export function recurrenceLabel(r: Recurrence | null): string {
  return r ? describeRecurrence(r) : '';
}

export function durationLabel(min: number | null): string {
  if (!min) return '';
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

export function reminderLabel(offsetMin: number | null): string {
  if (!offsetMin) return 'zur Fälligkeit';
  if (offsetMin % 1440 === 0) return offsetMin === 1440 ? '1 Tag vorher' : `${offsetMin / 1440} Tage vorher`;
  if (offsetMin % 60 === 0) return offsetMin === 60 ? '1 Std. vorher' : `${offsetMin / 60} Std. vorher`;
  return `${offsetMin} Min. vorher`;
}

export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const list = toasts.use();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
