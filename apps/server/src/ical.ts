import { addDays, zonedToUtc, type TaskData } from '@do-it/shared';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Zeilen nach RFC 5545 auf 75 Oktette falten. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** Kalender-Abo: Aufgaben mit Termin als Termine (nur lesend). */
export function buildIcs(tasks: { id: string; data: TaskData }[], tz: string, appUrl: string): string {
  const now = utcStamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Do-it//Aufgaben//DE', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Do-it', 'METHOD:PUBLISH'];
  const origin = new URL(appUrl).origin;
  for (const { id, data: t } of tasks) {
    if (!t.dueDate) continue;
    lines.push('BEGIN:VEVENT', `UID:${id}@do-it`, `DTSTAMP:${now}`, `SUMMARY:${esc(t.title)}`, `URL:${origin}/task/${id}`);
    if (t.dueTime) {
      const start = zonedToUtc(t.dueDate, t.dueTime, tz);
      const end = new Date(start.getTime() + (t.durationMin ?? 30) * 60_000);
      lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${t.dueDate.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(t.dueDate, 1).replace(/-/g, '')}`);
    }
    if (t.description) lines.push(`DESCRIPTION:${esc(t.description.slice(0, 2000))}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
