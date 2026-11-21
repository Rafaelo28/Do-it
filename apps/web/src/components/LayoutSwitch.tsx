import type { ViewLayout } from '@do-it/shared';
import { IconBoard, IconCalendar, IconList, IconTable } from './Icons';

const OPTIONS: { value: ViewLayout; label: string; icon: React.ReactNode }[] = [
  { value: 'list', label: 'Liste', icon: <IconList size={16} /> },
  { value: 'board', label: 'Board', icon: <IconBoard size={16} /> },
  { value: 'calendar', label: 'Kalender', icon: <IconCalendar size={16} /> },
  { value: 'table', label: 'Tabelle', icon: <IconTable size={16} /> },
];

/** Umschalter zwischen Liste, Board, Kalender und Tabelle */
export function LayoutSwitch({ value, onChange }: { value: ViewLayout; onChange: (v: ViewLayout) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Darstellung">
      {OPTIONS.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} title={o.label} onClick={() => onChange(o.value)}>
          {o.icon}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Allgemeiner Umschalter mit Text */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
