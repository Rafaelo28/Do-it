import type { Me } from '@do-it/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { Avatar } from './Avatar';

const VIEW = 260;
const OUT = 256;

/** Profilbild im Profil: anzeigen, neues wählen und zuschneiden, entfernen. */
export function ProfilePhoto({ me }: { me: Me }) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return toast('Das Bild ist zu groß (höchstens 30 MB).', { kind: 'error' });
    try {
      setBitmap(await createImageBitmap(file));
    } catch {
      toast('Dieses Bildformat kann der Browser nicht öffnen. Bitte ein JPEG- oder PNG-Bild wählen.', { kind: 'error' });
    }
  }

  async function save(image: string) {
    setBusy(true);
    try {
      const r = await api<{ user: Me }>('PUT', '/api/me/avatar', { image });
      syncState.set((s) => ({ ...s, me: r.user }));
      setBitmap(null);
      toast('Profilbild gespeichert');
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      const r = await api<{ user: Me }>('DELETE', '/api/me/avatar');
      syncState.set((s) => ({ ...s, me: r.user }));
      toast('Profilbild entfernt');
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }

  return (
    <div className="profile-photo">
      <Avatar name={me.name} src={me.avatar} size={64} seed={me.id} />
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="row">
          <button className="btn" onClick={() => input.current?.click()}>
            {me.avatar ? 'Anderes Bild' : 'Profilbild wählen'}
          </button>
          {me.avatar && (
            <button className="btn ghost" onClick={() => void remove()}>
              Entfernen
            </button>
          )}
        </div>
        <span className="small muted">Sehen alle, mit denen du Projekte teilst.</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {bitmap && <CropDialog bitmap={bitmap} busy={busy} onCancel={() => setBitmap(null)} onSave={(img) => void save(img)} />}
    </div>
  );
}

function CropDialog({ bitmap, busy, onCancel, onSave }: { bitmap: ImageBitmap; busy: boolean; onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cover = Math.max(VIEW / bitmap.width, VIEW / bitmap.height);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clamp = (p: { x: number; y: number }, z = zoom) => {
    const s = cover * z;
    const mx = Math.max(0, (bitmap.width * s - VIEW) / 2);
    const my = Math.max(0, (bitmap.height * s - VIEW) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  };

  const draw = (ctx: CanvasRenderingContext2D, size: number) => {
    const f = size / VIEW;
    const s = cover * zoom * f;
    const w = bitmap.width * s;
    const h = bitmap.height * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bitmap, size / 2 - w / 2 + pos.x * f, size / 2 - h / 2 + pos.y * f, w, h);
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(VIEW * dpr);
    c.height = Math.round(VIEW * dpr);
    draw(c.getContext('2d')!, c.width);
  });

  useEffect(() => () => bitmap.close(), [bitmap]);

  const setZoomTo = (z: number) => {
    const nz = Math.max(1, Math.min(4, z));
    setZoom(nz);
    setPos((p) => clamp(p, nz));
  };

  function save() {
    const out = document.createElement('canvas');
    out.width = OUT;
    out.height = OUT;
    draw(out.getContext('2d')!, OUT);
    onSave(out.toDataURL('image/jpeg', 0.88));
  }

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal crop-dialog" role="dialog" aria-modal="true" aria-label="Profilbild zuschneiden" onClick={(e) => e.stopPropagation()}>
        <strong>Ausschnitt wählen</strong>
        <span className="small muted">Ziehen zum Verschieben, Regler oder Mausrad zum Vergrößern.</span>
        <div className="crop-frame" style={{ width: VIEW, height: VIEW }}>
          <canvas
            ref={canvas}
            style={{ width: VIEW, height: VIEW, touchAction: 'none', cursor: 'grab' }}
            tabIndex={0}
            aria-label="Bildausschnitt (Pfeiltasten zum Verschieben)"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={(e) => setZoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
            onKeyDown={(e) => {
              const step = 8;
              const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
              const m = moves[e.key];
              if (m) {
                e.preventDefault();
                setPos((p) => clamp({ x: p.x + m[0], y: p.y + m[1] }));
              }
              if (e.key === '+') setZoomTo(zoom * 1.1);
              if (e.key === '-') setZoomTo(zoom / 1.1);
            }}
          />
          <div className="crop-mask" />
        </div>
        <label className="field">
          <span>Größe</span>
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoomTo(Number(e.target.value))} aria-label="Vergrößerung" />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onCancel}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
