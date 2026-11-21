import { describe, expect, it } from 'vitest';
import { applyFilter, parseFilter, type FilterContext, type FilterTask } from './filter';

const ctx: FilterContext = {
  today: '2026-11-21', // Samstag
  meId: 'me',
  projects: [
    { id: 'inbox', name: 'Eingang', parentId: null, isInbox: true },
    { id: 'arbeit', name: 'Arbeit', parentId: null },
    { id: 'kunde', name: 'Kunde Meier', parentId: 'arbeit' },
    { id: 'haus', name: 'Haus und Garten', parentId: null },
  ],
  sections: [{ id: 's1', name: 'Später' }],
  members: [
    { userId: 'me', name: 'Rafael' },
    { userId: 'ben', name: 'Ben Müller' },
  ],
};

const base: FilterTask & { id: string; completedAt: string | null } = {
  id: '',
  title: '',
  projectId: 'inbox',
  sectionId: null,
  parentId: null,
  priority: 4,
  dueDate: null,
  dueTime: null,
  deadline: null,
  durationMin: null,
  recurrence: null,
  assigneeId: null,
  labels: [],
  completedAt: null,
};
const T = (id: string, x: Partial<typeof base>) => ({ ...base, id, title: id, ...x });
const tasks = [
  T('steuer', { projectId: 'arbeit', priority: 1, dueDate: '2026-11-21', labels: ['Finanzen'] }),
  T('alt', { dueDate: '2026-11-18', priority: 2 }),
  T('morgen', { dueDate: '2026-11-22', dueTime: '09:00', durationMin: 60, assigneeId: 'me' }),
  T('bericht', { projectId: 'kunde', deadline: '2026-11-25', sectionId: 's1', description: 'Rechnung beilegen' }),
  T('rasen', { projectId: 'haus', dueDate: '2026-11-28', recurrence: { freq: 'week', interval: 1 }, assigneeId: 'ben' }),
  T('idee', { labels: ['später-lesen'] }),
  T('fertig', { dueDate: '2026-11-21', completedAt: '2026-11-21T08:00:00Z' }),
  T('teil', { parentId: 'steuer', projectId: 'arbeit', dueDate: '2026-12-02' }),
];
const ids = (q: string) => {
  const r = applyFilter(tasks, q, ctx);
  if (r.error) throw new Error(r.error);
  return r.tasks.map((t) => t.id);
};

describe('Filter', () => {
  it.each([
    ['heute', ['steuer']],
    ['today | overdue', ['steuer', 'alt']],
    ['heute | überfällig', ['steuer', 'alt']],
    ['morgen', ['morgen']],
    ['ohne datum', ['bericht', 'idee']],
    ['no date', ['bericht', 'idee']],
    ['7 tage', ['steuer', 'morgen']],
    ['nächste 14 tage & !wiederkehrend', ['steuer', 'morgen', 'teil']],
    ['diese woche', ['steuer', 'alt', 'morgen']],
    ['nächste woche', ['rasen']],
    ['wochenende', ['steuer', 'morgen']],
    ['vor: 21.11.', ['alt']],
    ['nach: heute', ['morgen', 'rasen', 'teil']],
    ['p1', ['steuer']],
    ['!1 | p2', ['steuer', 'alt']],
    ['priorität 2', ['alt']],
    ['#Arbeit', ['steuer', 'teil']],
    ['##arbeit', ['steuer', 'bericht', 'teil']],
    ['#Haus und Garten', ['rasen']],
    ['#Eingang', ['alt', 'morgen', 'idee']],
    ['#haus*', ['rasen']],
    ['/Später', ['bericht']],
    ['@finanzen', ['steuer']],
    ['@später*', ['idee']],
    ['ohne label & ohne datum', ['bericht']],
    ['deadline', ['bericht']],
    ['deadline 7 tage', ['bericht']],
    ['deadline vor: 1.12.', ['bericht']],
    ['mir zugewiesen', ['morgen']],
    ['zugewiesen an: ben', ['rasen']],
    ['assigned to: others', ['rasen']],
    ['nicht zugewiesen & heute', ['steuer']],
    ['wiederkehrend', ['rasen']],
    ['unteraufgaben', ['teil']],
    ['mit uhrzeit', ['morgen']],
    ['mit dauer', ['morgen']],
    ['suche: rechnung', ['bericht']],
    ['(heute | morgen) & !#Arbeit', ['morgen']],
    ['nicht heute & p1', []],
    ['heute, morgen', ['steuer', 'morgen']],
    ['alle', ['steuer', 'alt', 'morgen', 'bericht', 'rasen', 'idee', 'teil']],
  ])('„%s“', (q, expected) => {
    expect(ids(q)).toEqual(expected);
  });

  it('gibt verständliche Fehler', () => {
    expect(parseFilter('')).toMatchObject({ ok: false, error: 'Die Abfrage ist leer.' });
    expect(parseFilter('heute &')).toMatchObject({ ok: false, error: 'Nach einer Verknüpfung fehlt noch etwas.' });
    expect(parseFilter('(heute | morgen')).toMatchObject({ ok: false, error: 'Eine Klammer wird nicht geschlossen.' });
    expect(parseFilter('heute)')).toMatchObject({ ok: false, error: 'Eine Klammer zu viel.' });
    expect(parseFilter('rechnung')).toMatchObject({ ok: false, error: '„rechnung“ kenne ich nicht. Für eine Textsuche „suche: rechnung“ schreiben.' });
    expect(parseFilter('vor: irgendwann')).toMatchObject({ ok: false });
    expect(parseFilter('deadline bald')).toMatchObject({ ok: false });
  });
});
