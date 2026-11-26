import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** aktiv/eingeschaltet (z. B. Fett) */
  on?: boolean;
  /** Trennlinie davor */
  separator?: boolean;
}

/** Knopf mit Ausklapp-Menü (Tastatur: Pfeile, Enter, Esc) */
export function MenuButton({ label, icon, items, className, text }: { label: string; icon: ReactNode; items: MenuItem[]; className?: string; text?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = 230;
    const below = window.innerHeight - r.bottom;
    const above = below < Math.min(320, items.length * 40 + 16) && r.top > below;
    setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: above ? r.top - 4 : r.bottom + 4, above });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', place, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const choose = (it: MenuItem | undefined) => {
    if (!it || it.disabled) return;
    setOpen(false);
    btn.current?.focus();
    it.onSelect();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className ?? 'icon-btn'}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) return setOpen(false);
          place();
          setActive(enabled[0] ?? 0);
          setOpen(true);
        }}
      >
        {icon}
        {text && <span>{text}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className={`menu-pop ${pos.above ? 'above' : ''}`}
            style={{ left: pos.left, top: pos.top }}
            onKeyDown={(e) => {
              const at = enabled.indexOf(active);
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive(enabled[(at + 1) % enabled.length] ?? 0));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive(enabled[(at - 1 + enabled.length) % enabled.length] ?? 0));
              else if (e.key === 'Enter') (e.preventDefault(), choose(items[active]));
              else if (e.key === 'Escape' || e.key === 'Tab') (e.preventDefault(), setOpen(false), btn.current?.focus());
            }}
          >
            {items.map((it, i) => (
              <div key={`${it.label}-${i}`}>
                {it.separator && <div className="menu-sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={`menu-item ${i === active ? 'active' : ''} ${it.danger ? 'danger' : ''} ${it.on ? 'on' : ''}`}
                  disabled={it.disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(it)}
                >
                  <span className="menu-icon">{it.icon}</span>
                  <span>{it.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
