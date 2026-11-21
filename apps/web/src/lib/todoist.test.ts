import { OBJECT_DEFAULTS, type Me, type ObjectType } from '@do-it/shared';
import { OBJECT_SCHEMAS } from '@do-it/shared/schemas';
import { describe, expect, it } from 'vitest';
import { buildImport, convertDate, parseCsv, planFromApi, planFromCsv, readImportFiles, type ImportPlan, type ImportTarget, type TodoistData } from './todoist';
import { unzip } from './zip';

const ctx = { today: '2026-11-20', now: '10:00', timeZone: 'Europe/Berlin' };
const me: Me = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Anna',
  email: 'anna@example.org',
  timezone: 'Europe/Berlin',
  isAdmin: true,
  settings: {} as Me['settings'],
  twoFactor: false,
  avatar: null,
};

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Kleiner ZIP-Schreiber für Tests (deflate und stored). */
async function makeZip(files: { name: string; text: string; store?: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const data = f.store ? raw : await deflateRaw(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0808, true); // UTF-8 + Datendeskriptor (Größen hier 0)
    local.setUint16(8, f.store ? 0 : 8, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(8, 0x0808, true);
    central.setUint16(10, f.store ? 0 : 8, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Jede erzeugte Änderung muss die Server-Prüfung bestehen – sonst ginge die Aufgabe verloren. */
function expectValid(mutations: { type: ObjectType; data: Record<string, unknown> }[]) {
  for (const m of mutations) {
    const r = OBJECT_SCHEMAS[m.type].safeParse({ ...OBJECT_DEFAULTS[m.type], ...m.data });
    if (!r.success) throw new Error(`${m.type} ungültig: ${JSON.stringify(m.data).slice(0, 200)} → ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  }
}

function emptyTarget(overrides: Partial<ImportTarget> = {}): ImportTarget {
  return {
    me,
    inboxId: '01900000-0000-7000-8000-0000000000aa',
    existingProjects: [{ id: '01900000-0000-7000-8000-0000000000aa', name: 'Eingang', parentId: null, sortKey: 'a0' }],
    existingSections: [],
    existingTasks: [],
    existingLabels: [],
    ...overrides,
  };
}

describe('Todoist: Datumsangaben', () => {
  it('liest CSV mit Anführungszeichen und Umbrüchen', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","mehr\nzeilig ""zitiert"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'mehr\nzeilig "zitiert"'],
    ]);
  });

  it.each([
    ['2026-12-24', 'en', { dueDate: '2026-12-24', dueTime: null }],
    ['2026-12-24 15:00', 'en', { dueDate: '2026-12-24', dueTime: '15:00' }],
    ['tomorrow', 'en', { dueDate: '2026-11-21' }],
    ['next monday', 'en', { dueDate: '2026-11-23' }],
    ['Dec 24', 'en', { dueDate: '2026-12-24' }],
    ['24 Dec 2026', 'en', { dueDate: '2026-12-24' }],
    ['Dec 24 2027', 'en', { dueDate: '2027-12-24' }],
    ['Dec 24 at 3pm', 'en', { dueDate: '2026-12-24', dueTime: '15:00' }],
    ['every monday', 'en', { dueDate: '2026-11-23', recurrence: { freq: 'week', weekdays: [1] } }],
    ['every day at 8am', 'en', { dueTime: '08:00', recurrence: { freq: 'day', interval: 1 } }],
    ['every! 3 days', 'en', { recurrence: { freq: 'day', interval: 3, afterCompletion: true } }],
    ['every other week', 'en', { recurrence: { freq: 'week', interval: 2 } }],
    ['every other monday', 'en', { recurrence: { freq: 'week', interval: 2, weekdays: [1] } }],
    ['every 3rd thursday', 'en', { recurrence: { freq: 'month', nthWeekday: { n: 3, weekday: 4 } } }],
    ['every last friday', 'en', { recurrence: { freq: 'month', nthWeekday: { n: -1, weekday: 5 } } }],
    ['every last day', 'en', { recurrence: { freq: 'month', monthDay: -1 } }],
    ['every 15th', 'en', { recurrence: { freq: 'month', monthDay: 15 } }],
    ['every jan 15', 'en', { recurrence: { freq: 'year', month: 1, monthDay: 15 } }],
    ['every weekday', 'en', { recurrence: { freq: 'week', weekdays: [1, 2, 3, 4, 5] } }],
    ['every mon, fri', 'en', { recurrence: { freq: 'week', weekdays: [1, 5] } }],
    ['every 2 weeks starting jan 5', 'en', { recurrence: { freq: 'week', interval: 2 } }],
    ['every day until dec 31', 'en', { recurrence: { freq: 'day', until: '2026-12-31' } }],
    ['every year', 'en', { recurrence: { freq: 'year' } }],
    ['jeden Montag', 'de', { recurrence: { freq: 'week', weekdays: [1] } }],
    ['jeden Tag um 9 Uhr', 'de', { dueTime: '09:00', recurrence: { freq: 'day' } }],
    ['alle! 3 Tage', 'de', { recurrence: { freq: 'day', interval: 3, afterCompletion: true } }],
    ['alle 2 Wochen', 'de', { recurrence: { freq: 'week', interval: 2 } }],
    ['jeden Wochentag', 'de', { recurrence: { freq: 'week', weekdays: [1, 2, 3, 4, 5] } }],
    ['jede Woche', 'de', { recurrence: { freq: 'week', interval: 1 } }],
    ['jeden Monat', 'de', { recurrence: { freq: 'month', interval: 1 } }],
    ['jeden letzten Freitag', 'de', { recurrence: { freq: 'month', nthWeekday: { n: -1, weekday: 5 } } }],
    ['25. Nov.', 'de', { dueDate: '2026-11-25' }],
    ['25 Nov 2026', 'de', { dueDate: '2026-11-25' }],
    ['Nov 25', 'de', { dueDate: '2026-11-25' }],
    ['24.12.2026 15:00', 'de', { dueDate: '2026-12-24', dueTime: '15:00' }],
    ['morgen', 'de', { dueDate: '2026-11-21' }],
  ])('versteht „%s“ (%s)', (text, lang, expected) => {
    const r = convertDate(text, lang, ctx);
    expect(r.understood).toBe(true);
    expect(r).toMatchObject(expected);
  });

  it('meldet Unverständliches statt zu raten', () => {
    expect(convertDate('when pigs fly', 'en', ctx).understood).toBe(false);
    expect(convertDate('every hour', 'en', ctx).understood).toBe(false);
    expect(convertDate('', 'en', ctx)).toMatchObject({ understood: true, dueDate: null });
  });
});

describe('Todoist: CSV und Backup', () => {
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG',
    'meta,view_style=board,,,,,,,,,,,,',
    'note,Projektinfo: Schlüssel bei Oma,,,,Anna (1),,,,,,,,',
    'task,Einkaufen @laden @zu-hause,,1,1,Anna (1),,morgen,de,Europe/Berlin,,,,',
    'task,Milch,,4,2,Anna (1),,,de,Europe/Berlin,,,,',
    'note,Bio bitte,,,,Anna (1),,,,,,,,',
    'task,Hafermilch,,,3,Anna (1),,,de,Europe/Berlin,,,,',
    'section,Später,,,,,,,,,,,,',
    'task,Keller,"Alles raus, auch ""Kram""",2,1,Anna (1),Ben (2),alle! 3 Tage,de,Europe/Berlin,30,minute,2026-12-31,de',
    'task,Urlaub planen,,3,1,Anna (1),,wenn die Sonne scheint,de,Europe/Berlin,10,day,,',
    'task,Weit eingerückt,,4,4,Anna (1),,,de,Europe/Berlin,,,,',
    `task,${'Sehr langer Titel '.repeat(40)},,4,1,Anna (1),,,de,Europe/Berlin,,,,`,
  ].join('\r\n');

  it('baut Projekte, Abschnitte, Unteraufgaben, Kommentare und Projektnotizen', () => {
    const plan = planFromCsv([{ name: 'Haushalt [2203306141].csv', text: csv }, { name: 'Eingang.csv', text: 'TYPE,CONTENT\ntask,Hallo' }], ctx);
    const [haushalt, inbox] = plan.projects;
    expect(inbox).toMatchObject({ name: 'Eingang', isInbox: true });
    expect(haushalt).toMatchObject({ name: 'Haushalt', isInbox: false, sections: [{ key: 'Später', name: 'Später' }] });
    expect(plan.taskCount).toBe(9); // 8 Aufgaben + Projektnotizen
    const [notes, einkaufen, keller, urlaub, lang] = haushalt!.tasks;
    expect(notes).toMatchObject({ title: 'Projektnotizen aus Todoist', comments: [{ body: 'Projektinfo: Schlüssel bei Oma' }] });
    // Priorität: in Todoist-CSVs ist 1 die höchste
    expect(einkaufen).toMatchObject({ title: 'Einkaufen', labels: ['laden', 'zu-hause'], priority: 1, dueDate: '2026-11-21', section: null });
    expect(einkaufen!.children[0]).toMatchObject({ title: 'Milch', priority: 4, comments: [{ body: 'Bio bitte' }] });
    expect(einkaufen!.children[0]!.children[0]).toMatchObject({ title: 'Hafermilch', priority: 4 });
    expect(keller).toMatchObject({
      title: 'Keller',
      section: 'Später',
      priority: 2,
      durationMin: 30,
      deadline: '2026-12-31',
      recurrence: { freq: 'day', interval: 3, afterCompletion: true },
    });
    expect(keller!.description).toBe('Alles raus, auch "Kram"\n\nIn Todoist zuständig: Ben');
    // nicht verstanden: Text bleibt erhalten, Dauer über 7 Tage wandert in die Beschreibung
    expect(urlaub).toMatchObject({ dueDate: null, durationMin: null, priority: 3 });
    expect(urlaub!.description).toContain('Fälligkeit in Todoist: wenn die Sonne scheint');
    expect(urlaub!.description).toContain('Dauer in Todoist: 10 day');
    expect(plan.warnings.some((w) => w.includes('wenn die Sonne scheint'))).toBe(true);
    // zu tief eingerückt: hängt an der nächsthöheren Aufgabe, geht nicht verloren
    expect(urlaub!.children[0]).toMatchObject({ title: 'Weit eingerückt' });
    expect(haushalt!.tasks).toHaveLength(5);
    expect(lang!.title.length).toBeLessThanOrEqual(500);
    expect(lang!.description).toContain('Vollständiger Titel aus Todoist');
  });

  it('liest ZIP-Backups direkt (mit Unterordner und Mac-Resten)', async () => {
    const zip = await makeZip([
      { name: 'Backup/Haushalt [1].csv', text: '﻿TYPE,CONTENT,PRIORITY\ntask,Bad putzen,1' },
      { name: 'Backup/Inbox [2].csv', text: 'TYPE,CONTENT\ntask,Ä Ö Ü ß', store: true },
      { name: '__MACOSX/Backup/._Inbox [2].csv', text: 'xx' },
    ]);
    expect((await unzip(zip)).map((e) => e.name)).toHaveLength(3);
    const files = await readImportFiles([new File([zip as BlobPart], 'Todoist backup.zip')]);
    expect(files.map((f) => f.name)).toEqual(['Backup/Haushalt [1].csv', 'Backup/Inbox [2].csv']);
    const plan = planFromCsv(files, ctx);
    expect(plan.projects.map((p) => [p.name, p.isInbox])).toEqual([
      ['Haushalt', false],
      ['Inbox', true],
    ]);
    expect(plan.projects[0]!.tasks[0]).toMatchObject({ title: 'Bad putzen', priority: 1 });
    expect(plan.projects[1]!.tasks[0]!.title).toBe('Ä Ö Ü ß');
  });

  it('lehnt kaputte Dateien verständlich ab', async () => {
    await expect(unzip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toThrow('keine gültige ZIP-Datei');
    const plan = planFromCsv([{ name: 'notizen.csv', text: 'a,b\n1,2' }], ctx);
    expect(plan.projects).toHaveLength(0);
    expect(plan.warnings[0]).toContain('keine Todoist-CSV-Datei');
  });
});

const API: TodoistData = {
  user: { id: 'u1', full_name: 'Anna' },
  collaborators: [
    { id: 'u1', full_name: 'Anna' },
    { id: 'u2', full_name: 'Ben' },
  ],
  projects: [
    { id: 'p2', name: 'Haushalt', color: 'lime_green', child_order: 1 },
    { id: 'p1', name: 'Inbox', inbox_project: true, child_order: 0 },
    { id: 'p3', name: 'Keller', parent_id: 'p2', child_order: 0 },
    { id: 'p4', name: 'Alte Sachen', is_archived: true, child_order: 2 },
    { id: 'p5', name: 'Gelöscht', is_deleted: true },
  ],
  sections: [
    { id: 's2', name: 'Küche', project_id: 'p2', section_order: 2 },
    { id: 's1', name: 'Bad', project_id: 'p2', section_order: 1 },
  ],
  labels: [
    { name: 'finanzen', color: 'red', item_order: 1 },
    { name: 'unbenutzt', color: 'blue', item_order: 2 },
  ],
  items: [
    {
      id: 'i1',
      content: 'Steuer abgeben',
      project_id: 'p1',
      priority: 4,
      due: { date: '2026-12-01', is_recurring: false, string: '1. Dez', lang: 'de' },
      deadline: { date: '2026-12-15' },
      labels: ['finanzen', 'wichtig'],
    },
    { id: 'i2', content: 'Bad putzen', project_id: 'p2', section_id: 's1', child_order: 1, priority: 1, due: { date: '2026-11-22', is_recurring: true, string: 'jeden Sonntag', lang: 'de' } },
    { id: 'i3', content: 'Müll rausbringen', project_id: 'p2', child_order: 2, priority: 2, due: { date: '2026-11-24T19:00:00', is_recurring: true, string: 'every tuesday at 7pm', lang: 'en' } },
    { id: 'i4', content: 'Spiegel', project_id: 'p2', section_id: 's1', parent_id: 'i2', child_order: 1 },
    { id: 'i5', content: 'Fenster', project_id: 'p2', section_id: 's1', parent_id: 'i4', child_order: 1 },
    { id: 'i6', content: 'Zahnarzt', project_id: 'p2', section_id: 's2', child_order: 1, due: { date: '2026-11-25T14:30:00Z', timezone: 'Europe/Berlin', is_recurring: false, string: '25 Nov 15:30' } },
    { id: 'i7', content: 'Erledigt', project_id: 'p2', checked: true },
    { id: 'i8', content: 'Gelöscht', project_id: 'p2', is_deleted: true },
    { id: 'i9', content: 'Seltsam', project_id: 'p3', due: { date: '2026-11-27', is_recurring: true, string: 'every 3rd workday', lang: 'en' } },
    { id: 'i10', content: 'Einkauf', project_id: 'p3', duration: { amount: 90, unit: 'minute' }, responsible_uid: 'u2' },
    { id: 'i11', content: 'Team-Aufgabe', project_id: 'team-1' },
    { id: 'i12', content: 'Alte Aufgabe', project_id: 'p4' },
  ],
  notes: [
    { id: 'n2', item_id: 'i2', content: 'Mache ich', posted_uid: 'u2', posted_at: '2026-11-19T10:00:00Z', file_attachment: { file_name: 'plan.pdf', file_url: 'https://files.todoist.com/plan.pdf' } },
    { id: 'n1', item_id: 'i2', content: 'Erst die Fliesen', posted_uid: 'u1', posted_at: '2026-11-18T10:00:00Z' },
    { id: 'n3', item_id: 'i2', content: 'weg', is_deleted: true },
  ],
  project_notes: [{ id: 'pn1', project_id: 'p2', content: 'Putzplan hängt am Kühlschrank', posted_uid: 'u1', posted_at: '2026-11-01T08:00:00Z' }],
  reminders: [
    { id: 'r1', item_id: 'i6', type: 'relative', minute_offset: 30 },
    { id: 'r2', item_id: 'i1', type: 'absolute', due: { date: '2026-11-30T08:00:00Z' } },
    { id: 'r3', item_id: 'i2', type: 'location' },
    { id: 'r4', item_id: 'i2', type: 'relative', minute_offset: 10, is_deleted: true },
  ],
};

describe('Todoist: API-Import', () => {
  const plan = planFromApi(API, ctx);

  it('übernimmt Projekte in Todoist-Reihenfolge mit Unterprojekten und Archiv', () => {
    expect(plan.projects.map((p) => [p.name, p.isInbox, p.parentKey, p.archived, p.color])).toEqual([
      ['Inbox', true, null, false, null],
      ['Haushalt', false, null, false, '#7ecc49'],
      ['Keller', false, 'p2', false, null],
      ['Alte Sachen', false, null, true, null],
    ]);
    expect(plan.projects[1]!.sections.map((s) => s.name)).toEqual(['Bad', 'Küche']);
  });

  it('übernimmt Aufgaben vollständig', () => {
    const [inbox, haushalt, keller, alt] = plan.projects;
    expect(inbox!.tasks[0]).toMatchObject({
      title: 'Steuer abgeben',
      priority: 1,
      dueDate: '2026-12-01',
      dueTime: null,
      deadline: '2026-12-15',
      labels: ['finanzen', 'wichtig'],
      reminders: [{ kind: 'absolute', date: '2026-11-30', time: '09:00' }],
    });
    const titles = haushalt!.tasks.map((t) => t.title);
    expect(titles).toEqual(['Projektnotizen aus Todoist', 'Müll rausbringen', 'Bad putzen', 'Zahnarzt']);
    const [, muell, bad, zahnarzt] = haushalt!.tasks;
    expect(muell).toMatchObject({ priority: 3, dueDate: '2026-11-24', dueTime: '19:00', recurrence: { freq: 'week', weekdays: [2] }, section: null });
    expect(bad).toMatchObject({ priority: 4, dueDate: '2026-11-22', recurrence: { freq: 'week', weekdays: [7] }, section: 's1' });
    expect(bad!.comments.map((c) => c.body)).toEqual(['Erst die Fliesen', 'Ben: Mache ich\nAnhang: [plan.pdf](https://files.todoist.com/plan.pdf)']);
    expect(bad!.children[0]!.title).toBe('Spiegel');
    expect(bad!.children[0]!.children[0]!.title).toBe('Fenster');
    // feste Zeitzone (UTC) → lokale Zeit
    expect(zahnarzt).toMatchObject({ dueDate: '2026-11-25', dueTime: '15:30', section: 's2', reminders: [{ kind: 'relative', offsetMin: 30 }] });
    const [seltsam, einkauf] = keller!.tasks;
    expect(seltsam).toMatchObject({ dueDate: '2026-11-27', recurrence: null });
    expect(seltsam!.description).toContain('every 3rd workday');
    expect(einkauf).toMatchObject({ durationMin: 90, description: 'In Todoist zuständig: Ben' });
    expect(alt!.tasks[0]!.title).toBe('Alte Aufgabe');
    expect(plan.taskCount).toBe(10); // 9 offene Aufgaben + Projektnotizen
    expect(plan.commentCount).toBe(3);
    expect(plan.reminderCount).toBe(2);
    expect(plan.labels).toEqual([
      { name: 'finanzen', color: '#db4035' },
      { name: 'unbenutzt', color: '#4073ff' },
      { name: 'wichtig', color: null },
    ]);
    expect(plan.warnings.join('\n')).toMatch(/1 Aufgaben gehören zu Projekten/);
    expect(plan.warnings.join('\n')).toMatch(/1 Orts-Erinnerungen/);
  });
});

describe('Todoist: Übernehmen', () => {
  const plan: ImportPlan = planFromApi(API, ctx);

  it('erzeugt nur gültige Änderungen in der richtigen Reihenfolge', () => {
    const r = buildImport(plan, emptyTarget());
    expectValid(r.mutations);
    expect(r.tasks).toBe(10);
    expect(r.skipped).toBe(0);
    const index = new Map(r.mutations.map((m, i) => [m.id, i]));
    for (const [i, m] of r.mutations.entries()) {
      for (const ref of ['projectId', 'parentId', 'taskId', 'sectionId'] as const) {
        const target = m.data[ref] as string | null | undefined;
        if (target && index.has(target)) expect(index.get(target)!).toBeLessThan(i);
      }
    }
    // Eingang wird ergänzt, Unterprojekt hängt am neuen Haushalt
    const steuer = r.mutations.find((m) => m.data.title === 'Steuer abgeben')!;
    expect(steuer.data.projectId).toBe('01900000-0000-7000-8000-0000000000aa');
    const haushalt = r.mutations.find((m) => m.type === 'project' && m.data.name === 'Haushalt')!;
    expect(r.mutations.find((m) => m.type === 'project' && m.data.name === 'Keller')!.data.parentId).toBe(haushalt.id);
    expect(r.mutations.filter((m) => m.type === 'label').map((m) => m.data.name)).toEqual(['finanzen', 'unbenutzt', 'wichtig']);
  });

  it('ergänzt gleichnamige Projekte und Abschnitte und legt beim zweiten Mal nichts doppelt an', () => {
    const first = buildImport(plan, emptyTarget());
    const tasks = first.mutations.filter((m) => m.type === 'task');
    const target = emptyTarget({
      existingProjects: [
        { id: '01900000-0000-7000-8000-0000000000aa', name: 'Eingang', parentId: null, sortKey: 'a0' },
        ...first.mutations.filter((m) => m.type === 'project').map((m) => ({ id: m.id, name: m.data.name as string, parentId: m.data.parentId as string | null, sortKey: m.data.sortKey as string })),
      ],
      existingSections: first.mutations
        .filter((m) => m.type === 'section')
        .map((m) => ({ id: m.id, projectId: m.data.projectId as string, name: m.data.name as string, sortKey: m.data.sortKey as string })),
      existingTasks: tasks.map((m) => ({
        id: m.id,
        projectId: m.data.projectId as string,
        parentId: m.data.parentId as string | null,
        title: m.data.title as string,
        dueDate: m.data.dueDate as string | null,
        sortKey: m.data.sortKey as string,
      })),
      existingLabels: ['Finanzen', 'unbenutzt', 'wichtig'],
    });
    const second = buildImport(plan, target);
    expect(second.mutations).toEqual([]);
    expect(second.skipped).toBe(10);
  });

  it('auch große Importe bleiben gültig', () => {
    const items = Array.from({ length: 1500 }, (_, i) => ({
      id: `big${i}`,
      content: `Aufgabe ${i} ${'x'.repeat(i % 7 === 0 ? 600 : 3)}`,
      description: i % 11 === 0 ? 'y'.repeat(25000) : '',
      project_id: 'p1',
      parent_id: i % 5 === 0 || i === 0 ? null : `big${i - 1}`,
      labels: i % 13 === 0 ? Array.from({ length: 40 }, (_, k) => `label-${k}-${'z'.repeat(70)}`) : [],
      duration: i % 17 === 0 ? { amount: 30, unit: 'day' } : null,
    }));
    const big = planFromApi({ user: { id: 'u1' }, projects: [{ id: 'p1', name: 'Inbox', inbox_project: true }], items, notes: [{ id: 'n', item_id: 'big3', content: 'k'.repeat(25000) }] }, ctx);
    expect(big.taskCount).toBe(1500);
    const r = buildImport(big, emptyTarget());
    expectValid(r.mutations);
    expect(r.tasks).toBe(1500);
    expect(r.mutations.filter((m) => m.type === 'comment')).toHaveLength(3);
  });
});
