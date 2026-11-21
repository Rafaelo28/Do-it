import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown, IconInbox, IconSearch } from './Icons';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** Symbol, Farbpunkt oder Avatar vor dem Text */
  icon?: ReactNode;
  /** kleiner grauer Zusatz rechts */
  hint?: string;
  /** Einrückung (z. B. Unterprojekte) */
  depth?: number;
  disabled?: boolean;
}

interface Props<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Name für Bildschirmleser */
  label: string;
  disabled?: boolean;
  /** Suchfeld oben (Standard: ab 9 Einträgen) */
  searchable?: boolean;
  size?: 'sm' | 'md';
  /** ohne Rahmen, z. B. in Tabellen */
  variant?: 'field' | 'ghost';
  /** volle Breite des Elternelements */
  block?: boolean;
  className?: string;
}

/**
 * Auswahlmenü im Stil der App – ersetzt die Browser-Auswahlliste.
 * Tastatur: Pfeile, Pos1/Ende, Enter, Esc; Tippen springt zum passenden Eintrag bzw. sucht.
 */
export function Select<T extends string | number>({ value, options, onChange, label, disabled, searchable, size = 'md', variant = 'field', block, className }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();
  const current = options.find((o) => o.value === value);
  const withSearch = searchable ?? options.length > 8;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)) : options;
  }, [options, query]);

  function place() {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const vh = window.innerHeight;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const wanted = Math.min(340, 8 + options.length * 38 + (withSearch ? 48 : 0));
    const flip = below < Math.min(wanted, 220) && above > below;
    const width = Math.max(r.width, 200);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: flip ? r.top - 4 : r.bottom + 4,
      width,
      maxHeight: Math.max(160, Math.min(wanted, flip ? above : below)),
      above: flip,
    });
  }

  function show() {
    if (disabled) return;
    place();
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function close(focus = true) {
    setOpen(false);
    if (focus) button.current?.focus();
  }

  function pick(o: SelectOption<T> | undefined) {
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', outside, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ohne Suchfeld bekommt die Liste den Fokus (für die Tastatur)
  useEffect(() => {
    if (open && !withSearch) list.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
  }, [open, withSearch]);

  // markierten Eintrag sichtbar halten
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function move(delta: number) {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + delta + shown.length) % shown.length;
      if (!shown[i]!.disabled) break;
    }
    setActive(i);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
    else if (e.key === 'Home') (e.preventDefault(), setActive(0));
    else if (e.key === 'End') (e.preventDefault(), setActive(shown.length - 1));
    else if (e.key === 'Enter') (e.preventDefault(), pick(shown[active]));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
    else if (e.key === 'Tab') close(false);
    else if (!withSearch && e.key.length === 1) {
      // Tippen springt zum ersten passenden Eintrag
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select ${size} ${variant} ${block ? 'block' : ''} ${open ? 'open' : ''} ${className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${current?.label ?? 'nichts gewählt'}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        {current?.icon && <span className="select-icon">{current.icon}</span>}
        <span className="select-value">{current?.label ?? '–'}</span>
        <IconChevronDown size={size === 'sm' ? 14 : 16} className="select-chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            className={`select-pop ${pos.above ? 'above' : ''}`}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
            onKeyDown={onKey}
          >
            {withSearch && (
              <div className="select-search">
                <IconSearch size={15} />
                <input
                  autoFocus
                  value={query}
                  placeholder="Suchen …"
                  aria-label={`${label} suchen`}
                  aria-controls={id}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div id={id} role="listbox" aria-label={label} tabIndex={-1} className="select-list" aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}>
              {shown.map((o, i) => (
                <div
                  key={String(o.value)}
                  id={`${id}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  className={`select-option ${i === active ? 'active' : ''} ${o.value === value ? 'selected' : ''} ${o.disabled ? 'disabled' : ''}`}
                  style={o.depth ? { paddingLeft: 10 + o.depth * 16 } : undefined}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  {o.icon && <span className="select-icon">{o.icon}</span>}
                  <span className="select-label">{o.label}</span>
                  {o.hint && <span className="select-hint">{o.hint}</span>}
                  {o.value === value && <IconCheck size={14} className="select-check" />}
                </div>
              ))}
              {!shown.length && <div className="select-empty">Nichts gefunden</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Farbpunkt für Projekte */
export function Dot({ color }: { color: string | null | undefined }) {
  return <span className="select-dot" style={{ background: color ?? 'var(--accent)' }} />;
}

/** Projekte als Auswahl: Eingang zuerst, Unterprojekte eingerückt, mit Farbpunkt */
export function projectOptions(projects: { id: string; name: string; color: string | null; isInbox: boolean; parentId: string | null; archived: boolean }[], keep?: string): SelectOption<string>[] {
  const visible = projects.filter((p) => !p.archived || p.id === keep);
  const out: SelectOption<string>[] = [];
  const add = (parent: string | null, depth: number) => {
    for (const p of visible.filter((x) => (x.parentId ?? null) === parent && !x.isInbox)) {
      out.push({ value: p.id, label: p.name, icon: <Dot color={p.color} />, depth });
      add(p.id, depth + 1);
    }
  };
  const inbox = visible.find((p) => p.isInbox);
  if (inbox) out.push({ value: inbox.id, label: 'Eingang', icon: <IconInbox size={15} /> });
  add(null, 0);
  // Unterprojekte, deren Elternprojekt fehlt
  for (const p of visible) if (!p.isInbox && !out.some((o) => o.value === p.id)) out.push({ value: p.id, label: p.name, icon: <Dot color={p.color} /> });
  return out;
}
