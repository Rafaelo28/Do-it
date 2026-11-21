import { DEFAULT_APPEARANCE, type Appearance } from '@do-it/shared';
import { syncState } from './sync';

/** Akzentfarben zur Auswahl (eigene Farben gehen zusätzlich) */
export const ACCENTS: { name: string; color: string }[] = [
  { name: 'Smaragd', color: '#0f8b6c' },
  { name: 'Petrol', color: '#0e7490' },
  { name: 'Blau', color: '#3e63dd' },
  { name: 'Indigo', color: '#5b5bd6' },
  { name: 'Violett', color: '#8e4ec6' },
  { name: 'Pink', color: '#d6409f' },
  { name: 'Koralle', color: '#e5484d' },
  { name: 'Orange', color: '#dd5f12' },
  { name: 'Bernstein', color: '#b7791f' },
  { name: 'Graphit', color: '#4b5563' },
];

export const STYLES: { value: Appearance['style']; name: string; light: [string, string, string]; dark: [string, string, string] }[] = [
  { value: 'paper', name: 'Papier', light: ['#f7f6f3', '#efede8', '#ffffff'], dark: ['#14181c', '#181c20', '#1c2126'] },
  { value: 'clear', name: 'Klar', light: ['#fafafa', '#f1f1f2', '#ffffff'], dark: ['#121212', '#161617', '#1b1b1c'] },
  { value: 'cool', name: 'Kühl', light: ['#f3f5f9', '#e9edf4', '#ffffff'], dark: ['#0f1521', '#121a26', '#161e2c'] },
  { value: 'warm', name: 'Warm', light: ['#f8f3ec', '#f1e9de', '#fffdf9'], dark: ['#1a1613', '#1e1916', '#231e1a'] },
  { value: 'oled', name: 'Tiefschwarz', light: ['#ffffff', '#f6f6f7', '#ffffff'], dark: ['#000000', '#060607', '#0c0c0d'] },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** Aus einer Farbe die Akzent-Werte für hell und dunkel ableiten (lesbar auf beiden Hintergründen). */
export function accentVars(hex: string): Record<string, string> {
  const base = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : DEFAULT_APPEARANCE.accent;
  const [h, s, l] = rgbToHsl(hexToRgb(base));
  // hell: nicht zu blass, damit Text in Akzentfarbe auf Weiß lesbar bleibt
  let light = base;
  for (let ll = l; contrast(light, '#ffffff') < 3.2 && ll > 0.12; ll -= 0.03) light = hslToHex(h, s, ll);
  // dunkel: aufhellen, Sättigung begrenzen
  let dark = hslToHex(h, Math.min(s, 0.7), Math.max(l, 0.52));
  for (let ll = Math.max(l, 0.52); contrast(dark, '#1c2126') < 4 && ll < 0.85; ll += 0.03) dark = hslToHex(h, Math.min(s, 0.7), ll);
  const onLight = contrast(light, '#ffffff') >= 3 ? '#ffffff' : '#111111';
  const onDark = contrast(dark, '#0b0f12') >= contrast(dark, '#ffffff') ? '#0b0f12' : '#ffffff';
  return { '--accent-l': light, '--accent-d': dark, '--accent-text-l': onLight, '--accent-text-d': onDark };
}

let media: MediaQueryList | null = null;
let current: Appearance = DEFAULT_APPEARANCE;

function resolveDark(a: Appearance): boolean {
  return a.mode === 'dark' || (a.mode === 'system' && !!media?.matches);
}

/** Erscheinungsbild auf die Seite anwenden und für den nächsten Start merken. */
export function applyAppearance(input: Partial<Appearance> | undefined): void {
  const a: Appearance = { ...DEFAULT_APPEARANCE, ...input };
  current = a;
  media ??= window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  const root = document.documentElement;
  const dark = resolveDark(a);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-style', a.style);
  root.setAttribute('data-density', a.density);
  root.setAttribute('data-radius', a.radius);
  root.setAttribute('data-text', a.textSize);
  const vars = accentVars(a.accent);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // Farbe der Statusleiste (installierte App)
  const bg = (STYLES.find((s) => s.value === a.style) ?? STYLES[0]!)[dark ? 'dark' : 'light'][0];
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.removeAttribute('media');
    m.content = bg;
  }
  try {
    localStorage.setItem('doit-appearance', JSON.stringify({ ...a, vars }));
  } catch {
    /* privat/gesperrt: dann eben ohne Merken */
  }
}

/** Erscheinungsbild aus den Einstellungen verfolgen; bei "System" auch auf Hell/Dunkel des Geräts reagieren. */
export function startAppearance(): () => void {
  media ??= window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  let last = '';
  const sync = () => {
    const a = syncState.get().me?.settings.appearance;
    const key = JSON.stringify(a ?? null);
    if (a && key !== last) {
      last = key;
      applyAppearance(a);
    }
  };
  sync();
  const off = syncState.subscribe(sync);
  const onMedia = () => current.mode === 'system' && applyAppearance(current);
  media?.addEventListener('change', onMedia);
  return () => {
    off();
    media?.removeEventListener('change', onMedia);
  };
}
