import {
  addDays,
  addMonths,
  formatDateLong,
  isoWeekday,
  MONTHS_LONG,
  MONTHS_SHORT,
  minutesToTime,
  nextOccurrence,
  startOfIsoWeek,
  timeToMinutes,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  type CalendarMode,
  type PlainDate,
} from '@do-it/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { updateTask } from '../lib/actions';
import { useData } from '../lib/data';
import type { Task } from '../lib/db';
import { NARROW, useMedia } from '../lib/media';
import { useNow } from '../lib/time';
import { useViewPref } from '../lib/views';
import { IconChevronLeft, IconChevronRight, IconFlag, IconPlus, IconRepeat } from './Icons';
import { Segmented } from './LayoutSwitch';
import { QuickAdd } from './QuickAdd';
import { durationLabel, Modal } from './ui';

const HOUR = 48;
const SNAP = 15;
const DEFAULT_MIN = 30;

interface Occ {
  task: Task;
  date: PlainDate;
  /** spätere Termine einer Wiederholung (nur Vorschau) */
  virtual: boolean;
}

/** Termine im Zeitraum – inklusive künftiger Wiederholungen als Vorschau. */
function occurrences(tasks: Task[], from: PlainDate, to: PlainDate): Occ[] {
  const out: Occ[] = [];
  for (const task of tasks) {
    if (!task.dueDate) continue;
    if (task.dueDate >= from && task.dueDate <= to) out.push({ task, date: task.dueDate, virtual: false });
    const r = task.recurrence;
    if (!r || r.afterCompletion) continue;
    let d: PlainDate = task.dueDate;
    for (let i = 0; i < 800; i++) {
      const n = nextOccurrence(r, d, d);
      if (!n || n > to || n <= d) break;
      if (n >= from) out.push({ task, date: n, virtual: true });
      d = n;
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Text für die Schnell-Eingabe, z. B. "24.11. um 14:00 " */
function addText(date: PlainDate, today: PlainDate, minutes?: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = `${d}.${m}.${String(y) === today.slice(0, 4) ? '' : y}`;
  return minutes === undefined ? `${day} ` : `${day} um ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)} `;
}

function rangeOf(mode: CalendarMode, anchor: PlainDate): { days: PlainDate[]; title: string } {
  if (mode === 'day') return { days: [anchor], title: formatDateLong(anchor) };
  if (mode === 'week') {
    const mon = startOfIsoWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    const [y1, m1, d1] = mon.split('-').map(Number) as [number, number, number];
    const [y2, m2, d2] = days[6]!.split('-').map(Number) as [number, number, number];
    const title =
      m1 === m2 ? `${d1}.–${d2}. ${MONTHS_LONG[m2 - 1]} ${y2}` : `${d1}. ${MONTHS_LONG[m1 - 1]}${y1 !== y2 ? ` ${y1}` : ''} – ${d2}. ${MONTHS_LONG[m2 - 1]} ${y2}`;
    return { days, title };
  }
  const first = `${anchor.slice(0, 7)}-01`;
  const start = startOfIsoWeek(first);
  const [y, m] = first.split('-').map(Number) as [number, number];
  return { days: Array.from({ length: 42 }, (_, i) => addDays(start, i)), title: `${MONTHS_LONG[m - 1]} ${y}` };
}

const partsOf = (d: PlainDate) => d.split('-').map(Number) as [number, number, number];

/** Kurzer Titel fürs Handy, z. B. "Sa, 21. November" oder "16.–22. November" */
function shortTitle(mode: CalendarMode, anchor: PlainDate, days: PlainDate[], today: PlainDate): string {
  const [y, m, d] = partsOf(anchor);
  const year = (yy: number) => (String(yy) === today.slice(0, 4) ? '' : ` ${yy}`);
  if (mode === 'day') return `${WEEKDAYS_SHORT[isoWeekday(anchor) - 1]}, ${d}. ${MONTHS_LONG[m - 1]}${year(y)}`;
  if (mode === 'week') {
    const [, m1, d1] = partsOf(days[0]!);
    const [y2, m2, d2] = partsOf(days[6]!);
    return m1 === m2 ? `${d1}.–${d2}. ${MONTHS_LONG[m2 - 1]}${year(y2)}` : `${d1}. ${MONTHS_SHORT[m1 - 1]} – ${d2}. ${MONTHS_SHORT[m2 - 1]}${year(y2)}`;
  }
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

interface DayDots {
  dots: { color: string; deadline: boolean }[];
  count: number;
}

/** Farbpunkte für einen Tag (Wochenleiste, Monat auf dem Handy) */
function dotsFor(d: PlainDate, occ: Occ[], deadlines: Task[], colorOf: (t: Task) => string): DayDots {
  const dl = deadlines.filter((t) => t.deadline === d).map(() => ({ color: 'var(--danger)', deadline: true }));
  const items = occ
    .filter((o) => o.date === d)
    .sort((a, b) => (a.task.dueTime ?? '').localeCompare(b.task.dueTime ?? ''))
    .map((o) => ({ color: colorOf(o.task), deadline: false }));
  const all = [...dl, ...items];
  return { dots: all.slice(0, 3), count: all.length };
}

function Dots({ dots, count }: DayDots) {
  return (
    <span className="cal-dots" aria-hidden="true">
      {dots.map((x, i) => (
        <i key={i} className={x.deadline ? 'deadline' : ''} style={{ background: x.color }} />
      ))}
      {count > 3 && <i className="more" />}
    </span>
  );
}

const countText = (n: number) => (n ? `, ${n} ${n === 1 ? 'Eintrag' : 'Einträge'}` : '');

/** Überlappende Termine nebeneinander: Spalte und Spaltenzahl je Termin */
function layoutDay<T extends { start: number; end: number }>(items: T[]): (T & { col: number; cols: number })[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: (T & { col: number; cols: number })[] = [];
  let cluster: (T & { col: number; cols: number })[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const c of cluster) c.cols = ends.length;
    cluster = [];
    ends = [];
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) close();
    let col = ends.findIndex((e) => e <= it.start);
    if (col < 0) {
      col = ends.length;
      ends.push(it.end);
    } else ends[col] = it.end;
    const placed = { ...it, col, cols: 1 };
    cluster.push(placed);
    out.push(placed);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  close();
  return out;
}

interface Drop {
  date: PlainDate;
  /** Minuten ab Mitternacht im Zeitraster; null = ganztägig */
  minutes: number | null;
}

interface DragState {
  task: Task;
  kind: 'move' | 'resize';
  offsetMin: number;
  x: number;
  y: number;
  active: boolean;
  drop: Drop | null;
  duration: number;
}

/** Kalender mit Tag, Woche und Monat. Aufgaben mit Uhrzeit und Dauer blocken ihre Zeit. */
export function CalendarView({ tasks, prefKey, projectId, unscheduled = [] }: { tasks: Task[]; prefKey: string; projectId?: string; unscheduled?: Task[] }) {
  const [pref, setPref] = useViewPref(prefKey, { cal: 'week' });
  const mode = pref.cal ?? 'week';
  const narrow = useMedia(NARROW);
  const now = useNow();
  const [anchor, setAnchorState] = useState(now.date);
  /** Richtung des letzten Wechsels (für die kurze Schiebe-Animation) */
  const dir = useRef(0);
  const setAnchor = (d: PlainDate) => {
    dir.current = d > anchor ? 1 : d < anchor ? -1 : 0;
    setAnchorState(d);
  };
  const setMode = (cal: CalendarMode) => {
    dir.current = 0;
    setPref({ cal });
  };
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [, navigate] = useLocation();
  const { projectMap } = useData();

  const { days, title } = rangeOf(mode, anchor);
  const from = days[0]!;
  const to = days[days.length - 1]!;
  // in der Tagesansicht die ganze Woche laden: für die Punkte in der Wochenleiste
  const spanFrom = mode === 'day' ? startOfIsoWeek(anchor) : from;
  const spanTo = mode === 'day' ? addDays(spanFrom, 6) : to;
  const occ = useMemo(() => occurrences(tasks, spanFrom, spanTo), [tasks, spanFrom, spanTo]);
  const deadlines = useMemo(() => tasks.filter((t) => t.deadline && t.deadline >= spanFrom && t.deadline <= spanTo), [tasks, spanFrom, spanTo]);

  const step = (n: number) => setAnchor(mode === 'day' ? addDays(anchor, n) : mode === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  const colorOf = (t: Task) => projectMap.get(t.projectId)?.color ?? 'var(--accent)';
  const toDay = (d: PlainDate) => {
    setAnchor(d);
    setMode('day');
  };

  // Wischen nach links/rechts blättert (Handy, Tablet)
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    const el = e.target as HTMLElement;
    touch.current = e.touches.length === 1 && p && !el.closest('input, textarea, .modal-back, .select-pop') ? { x: p.clientX, y: p.clientY, t: Date.now() } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    const p = e.changedTouches[0];
    touch.current = null;
    if (!s || !p) return;
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.6 * Math.abs(dy) && Date.now() - s.t < 700) step(dx < 0 ? 1 : -1);
  };

  // ---------- Ziehen (Maus/Stift; auf Touch öffnet Tippen die Aufgabe) ----------

  function dropAt(x: number, y: number, d: DragState): Drop | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const col = el?.closest<HTMLElement>('[data-cal-col]');
    if (col) {
      const rect = col.getBoundingClientRect();
      const raw = ((y - rect.top) / HOUR) * 60 - d.offsetMin;
      const minutes = Math.max(0, Math.min(1440 - SNAP, Math.round(raw / SNAP) * SNAP));
      return { date: col.dataset.calDay!, minutes };
    }
    const day = el?.closest<HTMLElement>('[data-cal-allday], [data-cal-cell]');
    if (day) return { date: day.dataset.calDay!, minutes: day.hasAttribute('data-cal-allday') ? null : d.task.dueTime ? timeToMinutes(d.task.dueTime) : null };
    return null;
  }

  function startDrag(e: React.PointerEvent, task: Task, kind: 'move' | 'resize', offsetMin = 0) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    e.stopPropagation();
    const d: DragState = { task, kind, offsetMin, x: e.clientX, y: e.clientY, active: false, drop: null, duration: task.durationMin ?? DEFAULT_MIN };
    dragRef.current = d;
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      if (!cur.active && Math.hypot(ev.clientX - cur.x, ev.clientY - cur.y) < 5) return;
      const next = { ...cur, active: true };
      if (cur.kind === 'resize') {
        const col = document.querySelector<HTMLElement>(`[data-cal-col][data-cal-day="${task.dueDate}"]`);
        if (col && task.dueTime) {
          const end = ((ev.clientY - col.getBoundingClientRect().top) / HOUR) * 60;
          next.duration = Math.max(SNAP, Math.min(1440 - timeToMinutes(task.dueTime), Math.round((end - timeToMinutes(task.dueTime)) / SNAP) * SNAP));
        }
      } else next.drop = dropAt(ev.clientX, ev.clientY, cur);
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur?.active) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (cur.kind === 'resize') {
        if (cur.duration !== task.durationMin) void updateTask(task.id, { durationMin: cur.duration });
      } else if (cur.drop) {
        const changes: Partial<Task> = { dueDate: cur.drop.date, dueTime: cur.drop.minutes === null ? null : minutesToTime(cur.drop.minutes) };
        if (changes.dueDate !== task.dueDate || changes.dueTime !== task.dueTime) void updateTask(task.id, changes);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const open = (t: Task) => {
    if (!suppressClick.current) navigate(`/task/${t.id}`);
  };

  const timeOf = (o: Occ) => (o.task.dueTime ? timeToMinutes(o.task.dueTime) : null);

  return (
    <div className={`cal ${narrow ? 'narrow' : ''}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="cal-bar">
        <strong className="cal-title" aria-live="polite">
          {narrow ? shortTitle(mode, anchor, days, now.date) : title}
        </strong>
        <div className="cal-nav">
          <button className="icon-btn" aria-label="Zurück" onClick={() => step(-1)}>
            <IconChevronLeft />
          </button>
          <button className="btn small" onClick={() => setAnchor(now.date)}>
            Heute
          </button>
          <button className="icon-btn" aria-label="Weiter" onClick={() => step(1)}>
            <IconChevronRight />
          </button>
        </div>
        <div className="cal-modes">
          <Segmented
            label="Kalender-Ansicht"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'day', label: 'Tag' },
              { value: 'week', label: 'Woche' },
              { value: 'month', label: 'Monat' },
            ]}
          />
        </div>
      </div>

      {mode === 'day' && <WeekStrip anchor={anchor} today={now.date} occ={occ} deadlines={deadlines} colorOf={colorOf} onPick={setAnchor} />}

      <div className={`cal-body ${unscheduled.length && mode !== 'month' ? 'with-side' : ''}`}>
        <div key={`${mode}-${from}`} className="cal-anim" data-dir={dir.current}>
          {mode === 'month' ? (
            <MonthGrid
              days={days}
              month={anchor.slice(0, 7)}
              today={now.date}
              occ={occ}
              deadlines={deadlines}
              drag={drag}
              colorOf={colorOf}
              compact={narrow}
              selected={anchor}
              onSelect={setAnchor}
              onDay={toDay}
              onAdd={(d) => !suppressClick.current && setAdding(addText(d, now.date))}
              onOpen={open}
              startDrag={startDrag}
            />
          ) : (
            <TimeGrid
              days={days}
              today={now.date}
              nowMin={timeToMinutes(now.time)}
              occ={occ}
              deadlines={deadlines}
              drag={drag}
              colorOf={colorOf}
              timeOf={timeOf}
              hideHeads={mode === 'day'}
              onDay={toDay}
              onAdd={(d, m) => !suppressClick.current && setAdding(addText(d, now.date, m))}
              onOpen={open}
              startDrag={startDrag}
            />
          )}
        </div>
        {unscheduled.length > 0 && mode !== 'month' && (
          <aside className="cal-side">
            <div className="small muted" style={{ fontWeight: 600 }}>
              Zum Einplanen
            </div>
            <span className="small muted">In den Kalender ziehen, um Zeit zu blocken.</span>
            <ul>
              {unscheduled.slice(0, 40).map((t) => (
                <li
                  key={t.id}
                  className={`cal-chip ${drag?.task.id === t.id ? 'dragging' : ''}`}
                  style={{ '--c': colorOf(t) } as React.CSSProperties}
                  onPointerDown={(e) => startDrag(e, t, 'move', 0)}
                  onClick={() => open(t)}
                >
                  <span className="cal-chip-title">{t.title}</span>
                  {t.durationMin && <span className="muted">{durationLabel(t.durationMin)}</span>}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {mode === 'month' && narrow && (
        <DayAgenda
          date={anchor}
          today={now.date}
          occ={occ}
          deadlines={deadlines}
          colorOf={colorOf}
          onOpen={open}
          onAdd={(d) => setAdding(addText(d, now.date))}
          onDayView={() => toDay(anchor)}
        />
      )}

      {adding !== null && (
        <Modal onClose={() => setAdding(null)} label="Neue Aufgabe">
          <QuickAdd autoFocus asEvent initialText={adding} projectId={projectId} onDone={() => setAdding(null)} />
        </Modal>
      )}
    </div>
  );
}

interface GridProps {
  days: PlainDate[];
  today: PlainDate;
  occ: Occ[];
  deadlines: Task[];
  drag: DragState | null;
  colorOf: (t: Task) => string;
  onDay: (d: PlainDate) => void;
  onOpen: (t: Task) => void;
  startDrag: (e: React.PointerEvent, t: Task, kind: 'move' | 'resize', offsetMin?: number) => void;
}

function TimeGrid({ days, today, nowMin, occ, deadlines, drag, colorOf, timeOf, hideHeads, onDay, onAdd, onOpen, startDrag }: GridProps & {
  nowMin: number;
  timeOf: (o: Occ) => number | null;
  hideHeads?: boolean;
  onAdd: (d: PlainDate, minutes?: number) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);

  // Startposition: heute rund um die aktuelle Uhrzeit, sonst ab dem ersten Termin
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const starts = occ.filter((o) => days.includes(o.date)).flatMap((o) => (timeOf(o) === null ? [] : [timeOf(o)!]));
    const start = days.includes(today) ? nowMin - 90 : Math.min(8 * 60, ...starts) - 30;
    // auf eine volle Stunde, damit oben keine Uhrzeit angeschnitten ist
    const max = Math.floor((el.scrollHeight - el.clientHeight + 10) / HOUR);
    const hour = Math.min(max, Math.floor(Math.max(0, Math.min(start, 17 * 60)) / 60));
    el.scrollTop = hour > 0 ? hour * HOUR - 10 : 0;
    // nur beim ersten Anzeigen bzw. Wechsel des Zeitraums
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], days.length]);

  // Zeitraster bis zum unteren Bildschirmrand, ohne dass die ganze Seite mitscrollt
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    el.style.maxHeight = `${Math.max(320, Math.round(window.innerHeight - top - 16))}px`;
  });
  const [, rerender] = useState(0);
  useEffect(() => {
    const onResize = () => rerender((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="cal-week" data-days={days.length} style={{ '--days': days.length } as React.CSSProperties}>
      {!hideHeads && (
        <div className="cal-row cal-heads">
          <div className="cal-gutter" />
          {days.map((d) => (
            <button key={d} className={`cal-day-head ${d === today ? 'today' : ''}`} aria-label={`${formatDateLong(d)} – Tagesansicht`} onClick={() => onDay(d)}>
              <span>{WEEKDAYS_SHORT[isoWeekday(d) - 1]}</span>
              <b>{Number(d.slice(8))}</b>
            </button>
          ))}
        </div>
      )}
      <div className="cal-row cal-allday-row">
        <div className="cal-gutter cal-allday-label muted">ganz{'\u00AD'}tägig</div>
        {days.map((d) => {
          const items = occ.filter((o) => o.date === d && timeOf(o) === null);
          const dl = deadlines.filter((t) => t.deadline === d);
          const preview = drag?.active && drag.drop?.date === d && drag.drop.minutes === null;
          return (
            <div key={d} className={`cal-allday ${preview ? 'drop' : ''}`} data-cal-day={d} data-cal-allday="" onClick={(e) => e.target === e.currentTarget && onAdd(d)}>
              {dl.map((t) => (
                <button key={`dl-${t.id}`} className="cal-chip deadline" onClick={() => onOpen(t)} title={`Deadline: ${t.title}`}>
                  <IconFlag size={12} />
                  <span className="cal-chip-title">{t.title}</span>
                </button>
              ))}
              {items.map((o) => (
                <button
                  key={`${o.task.id}-${o.date}`}
                  className={`cal-chip ${o.task.isEvent ? 'event' : ''} ${o.virtual ? 'virtual' : ''} ${drag?.task.id === o.task.id && !o.virtual ? 'dragging' : ''}`}
                  style={{ '--c': colorOf(o.task) } as React.CSSProperties}
                  onPointerDown={o.virtual ? undefined : (e) => startDrag(e, o.task, 'move', 0)}
                  onClick={() => onOpen(o.task)}
                >
                  {o.task.recurrence && <IconRepeat size={11} />}
                  <span className="cal-chip-title">{o.task.title}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="cal-scroll" ref={scroll}>
        <div className="cal-row cal-grid" style={{ height: 24 * HOUR }}>
          <div className="cal-gutter cal-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR }}>
                {h ? `${pad(h)}:00` : ''}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const blocks = layoutDay(
              occ
                .filter((o) => o.date === d && timeOf(o) !== null)
                .map((o) => {
                  const start = timeOf(o)!;
                  const dur = drag?.kind === 'resize' && drag.active && drag.task.id === o.task.id && !o.virtual ? drag.duration : (o.task.durationMin ?? DEFAULT_MIN);
                  return { o, start, end: Math.min(1440, start + Math.max(SNAP, dur)) };
                }),
            );
            const ghost = drag?.active && drag.kind === 'move' && drag.drop?.date === d && drag.drop.minutes !== null ? drag.drop.minutes : null;
            return (
              <div
                key={d}
                className={`cal-col ${d === today ? 'today' : ''}`}
                data-cal-day={d}
                data-cal-col=""
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                  onAdd(d, Math.min(1410, Math.floor(((y / HOUR) * 60) / 30) * 30));
                }}
              >
                {blocks.map(({ o, start, end, col, cols }) => {
                  const dragging = drag?.active && drag.kind === 'move' && drag.task.id === o.task.id && !o.virtual;
                  return (
                    <div
                      key={`${o.task.id}-${o.date}`}
                      role="button"
                      tabIndex={0}
                      className={`cal-block ${o.task.isEvent ? 'event' : 'todo'} ${o.virtual ? 'virtual' : ''} ${dragging ? 'dragging' : ''} ${end - start <= 30 ? 'short' : ''}`}
                      style={
                        {
                          top: (start / 60) * HOUR,
                          height: Math.max(18, ((end - start) / 60) * HOUR - 2),
                          left: `calc(${(col / cols) * 100}% + 2px)`,
                          width: `calc(${100 / cols}% - 4px)`,
                          '--c': colorOf(o.task),
                        } as React.CSSProperties
                      }
                      title={`${o.task.title} · ${minutesToTime(start)}–${minutesToTime(Math.min(end, 1439))}`}
                      onPointerDown={o.virtual ? undefined : (e) => startDrag(e, o.task, 'move', ((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 60)}
                      onClick={() => onOpen(o.task)}
                      onKeyDown={(e) => e.key === 'Enter' && onOpen(o.task)}
                    >
                      <span className="cal-block-title">
                        {!o.task.isEvent && <span className="todo-dot" aria-label="To-do" />}
                        {o.task.recurrence && <IconRepeat size={11} />} {o.task.title}
                      </span>
                      <span className="cal-block-time">
                        {minutesToTime(start)}–{minutesToTime(Math.min(end, 1439))}
                      </span>
                      {!o.virtual && o.task.dueTime && <span className="cal-resize" aria-hidden="true" onPointerDown={(e) => startDrag(e, o.task, 'resize')} />}
                    </div>
                  );
                })}
                {ghost !== null && drag && (
                  <div className="cal-ghost" style={{ top: (ghost / 60) * HOUR, height: Math.max(18, ((drag.task.durationMin ?? DEFAULT_MIN) / 60) * HOUR - 2) }}>
                    {minutesToTime(ghost)} {drag.task.title}
                  </div>
                )}
                {d === today && <div className="cal-now" style={{ top: (nowMin / 60) * HOUR }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({
  days,
  month,
  today,
  occ,
  deadlines,
  drag,
  colorOf,
  compact,
  selected,
  onSelect,
  onDay,
  onAdd,
  onOpen,
  startDrag,
}: GridProps & { month: string; compact: boolean; selected: PlainDate; onSelect: (d: PlainDate) => void; onAdd: (d: PlainDate) => void }) {
  if (compact) {
    // Handy: Punkte statt Einträgen, Tippen wählt den Tag (Liste darunter)
    return (
      <div className="cal-month compact">
        <div className="cal-month-head">
          {WEEKDAYS_SHORT.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="cal-month-grid">
          {days.map((d) => {
            const dots = dotsFor(d, occ, deadlines, colorOf);
            return (
              <button
                key={d}
                className={`cal-cell compact ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''} ${d === selected ? 'selected' : ''}`}
                aria-pressed={d === selected}
                aria-label={`${formatDateLong(d)}${countText(dots.count)}`}
                onClick={() => onSelect(d)}
                onDoubleClick={() => onDay(d)}
              >
                <span className="cal-cell-num">{Number(d.slice(8))}</span>
                <Dots {...dots} />
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="cal-month-grid">
        {days.map((d) => {
          const items = occ
            .filter((o) => o.date === d)
            .sort((a, b) => (a.task.dueTime ?? '').localeCompare(b.task.dueTime ?? ''));
          const dl = deadlines.filter((t) => t.deadline === d);
          const all = [...dl.map((t) => ({ kind: 'deadline' as const, t })), ...items.map((o) => ({ kind: 'task' as const, t: o.task, o }))];
          const preview = drag?.active && drag.drop?.date === d;
          return (
            <div
              key={d}
              className={`cal-cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''} ${preview ? 'drop' : ''}`}
              data-cal-day={d}
              data-cal-cell=""
              onClick={(e) => e.target === e.currentTarget && onAdd(d)}
            >
              <button className="cal-cell-num" onClick={() => onDay(d)} aria-label={formatDateLong(d)}>
                {Number(d.slice(8))}
              </button>
              {all.slice(0, 3).map((x) =>
                x.kind === 'deadline' ? (
                  <button key={`dl-${x.t.id}`} className="cal-chip deadline" onClick={() => onOpen(x.t)} title={`Deadline: ${x.t.title}`}>
                    <IconFlag size={11} />
                    <span className="cal-chip-title">{x.t.title}</span>
                  </button>
                ) : (
                  <button
                    key={`${x.t.id}-${d}`}
                    className={`cal-chip ${x.t.isEvent ? 'event' : ''} ${x.o.virtual ? 'virtual' : ''} ${drag?.task.id === x.t.id && !x.o.virtual ? 'dragging' : ''}`}
                    style={{ '--c': colorOf(x.t) } as React.CSSProperties}
                    onPointerDown={x.o.virtual ? undefined : (e) => startDrag(e, x.t, 'move', 0)}
                    onClick={() => onOpen(x.t)}
                  >
                    {x.t.dueTime && <span className="cal-chip-time">{x.t.dueTime}</span>}
                    <span className="cal-chip-title">{x.t.title}</span>
                  </button>
                ),
              )}
              {all.length > 3 && (
                <button className="cal-more" onClick={() => onDay(d)}>
                  +{all.length - 3} weitere
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Wochenleiste über der Tagesansicht: Tag antippen, Punkte zeigen, wo etwas ansteht */
function WeekStrip({ anchor, today, occ, deadlines, colorOf, onPick }: { anchor: PlainDate; today: PlainDate; occ: Occ[]; deadlines: Task[]; colorOf: (t: Task) => string; onPick: (d: PlainDate) => void }) {
  const mon = startOfIsoWeek(anchor);
  return (
    <div className="cal-strip" role="group" aria-label="Tag wählen">
      {Array.from({ length: 7 }, (_, i) => {
        const d = addDays(mon, i);
        const dots = dotsFor(d, occ, deadlines, colorOf);
        return (
          <button
            key={d}
            className={`cal-strip-day ${d === anchor ? 'on' : ''} ${d === today ? 'today' : ''}`}
            aria-pressed={d === anchor}
            aria-label={`${formatDateLong(d)}${countText(dots.count)}`}
            onClick={() => onPick(d)}
          >
            <span className="cal-strip-wd">{WEEKDAYS_SHORT[i]}</span>
            <b>{Number(d.slice(8))}</b>
            <Dots {...dots} />
          </button>
        );
      })}
    </div>
  );
}

/** Liste des gewählten Tags unter dem Monat (Handy) */
function DayAgenda({
  date,
  today,
  occ,
  deadlines,
  colorOf,
  onOpen,
  onAdd,
  onDayView,
}: {
  date: PlainDate;
  today: PlainDate;
  occ: Occ[];
  deadlines: Task[];
  colorOf: (t: Task) => string;
  onOpen: (t: Task) => void;
  onAdd: (d: PlainDate) => void;
  onDayView: () => void;
}) {
  const [, m, d] = partsOf(date);
  const items = occ.filter((o) => o.date === date).sort((a, b) => (a.task.dueTime ?? '').localeCompare(b.task.dueTime ?? ''));
  const dl = deadlines.filter((t) => t.deadline === date);
  const day = date === today ? 'Heute' : WEEKDAYS_LONG[isoWeekday(date) - 1];
  return (
    <section className="cal-agenda" aria-label={`Plan für ${formatDateLong(date)}`}>
      <div className="cal-agenda-head">
        <strong>
          {day}, {d}. {MONTHS_LONG[m - 1]}
        </strong>
        <button className="btn small ghost" onClick={onDayView}>
          Tagesansicht
        </button>
      </div>
      {!items.length && !dl.length ? (
        <p className="muted small cal-agenda-empty">Nichts geplant.</p>
      ) : (
        <ul className="agenda">
          {dl.map((t) => (
            <li key={`dl-${t.id}`}>
              <button className="agenda-item deadline" style={{ '--c': 'var(--danger)' } as React.CSSProperties} onClick={() => onOpen(t)}>
                <span className="agenda-time">Deadline</span>
                <span className="agenda-title">{t.title}</span>
                <IconFlag size={13} />
              </button>
            </li>
          ))}
          {items.map((o) => {
            const t = o.task;
            const end = t.dueTime && t.durationMin ? minutesToTime(Math.min(1439, timeToMinutes(t.dueTime) + t.durationMin)) : null;
            return (
              <li key={`${t.id}-${o.date}`}>
                <button className={`agenda-item ${t.isEvent ? 'event' : 'todo'} ${o.virtual ? 'virtual' : ''}`} style={{ '--c': colorOf(t) } as React.CSSProperties} onClick={() => onOpen(t)}>
                  <span className="agenda-time">{t.dueTime ? `${t.dueTime}${end ? `–${end}` : ''}` : 'ganztägig'}</span>
                  <span className="agenda-title">
                    {!t.isEvent && <span className="todo-dot" aria-label="To-do" />}
                    {t.title}
                  </span>
                  {t.recurrence && <IconRepeat size={12} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button className="btn small cal-agenda-add" onClick={() => onAdd(date)}>
        <IconPlus size={15} /> Eintragen
      </button>
    </section>
  );
}
