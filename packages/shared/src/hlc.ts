/**
 * Hybrid Logical Clock: Zeitstempel, die sich als Text sortieren lassen und auch bei
 * leicht falsch gehenden Uhren eine eindeutige Reihenfolge ergeben.
 * Format: <13 Stellen ms>-<5 Stellen Zähler base36>-<Knoten-ID>
 */
export interface HlcParts {
  ms: number;
  counter: number;
  node: string;
}

export function formatHlc(ms: number, counter: number, node: string): string {
  return `${String(ms).padStart(13, '0')}-${counter.toString(36).padStart(5, '0')}-${node}`;
}

export function parseHlc(s: string): HlcParts | null {
  const m = /^(\d{13})-([0-9a-z]{5})-([\w-]{1,40})$/.exec(s);
  if (!m) return null;
  return { ms: Number(m[1]), counter: parseInt(m[2]!, 36), node: m[3]! };
}

export class HybridClock {
  private last = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
  ) {}

  tick(): string {
    const t = this.now();
    if (t > this.last) {
      this.last = t;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return formatHlc(this.last, this.counter, this.node);
  }

  /** Fremden Zeitstempel einarbeiten, damit eigene spätere Stempel größer sind. */
  receive(remote: string): void {
    const p = parseHlc(remote);
    if (!p) return;
    const t = this.now();
    const max = Math.max(t, this.last, p.ms);
    if (max === this.last && max === p.ms) this.counter = Math.max(this.counter, p.counter) + 1;
    else if (max === this.last) this.counter++;
    else if (max === p.ms) this.counter = p.counter + 1;
    else this.counter = 0;
    this.last = max;
  }
}
