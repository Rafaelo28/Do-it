import { useState } from 'react';
import { initials } from './ui';

/** Gleichbleibende Farbe pro Person (aus Name/ID), damit Initialen unterscheidbar sind. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Profilbild oder – ohne Bild oder wenn es nicht lädt – farbige Initialen. */
export function Avatar({ name, src, size = 20, seed, title }: { name: string; src: string | null | undefined; size?: number; seed?: string; title?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size };
  if (src && failed !== src) {
    return <img className="avatar" src={src} style={style} alt="" title={title} loading="lazy" decoding="async" onError={() => setFailed(src)} />;
  }
  return (
    <span
      className="avatar initials"
      title={title}
      aria-hidden="true"
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.4)), background: `hsl(${hue(seed ?? name)} 42% 40%)` }}
    >
      {initials(name) || '?'}
    </span>
  );
}
