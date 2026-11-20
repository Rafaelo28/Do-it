import { describe, expect, it } from 'vitest';
import { convertDate, parseCsv, planTodoistImport } from './todoist';

const ctx = { today: '2026-11-20', now: '10:00' };

describe('Todoist-Import', () => {
  it('liest CSV mit Anführungszeichen und Umbrüchen', () => {
    expect(parseCsv('a,b\n"x, y","mehr\nzeilig"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'mehr\nzeilig'],
    ]);
  });

  it('versteht Todoist-Daten', () => {
    expect(convertDate('2026-12-24', 'en', ctx)).toMatchObject({ dueDate: '2026-12-24', dueTime: null, understood: true });
    expect(convertDate('every monday', 'en', ctx)).toMatchObject({ dueDate: '2026-11-23', recurrence: { freq: 'week', weekdays: [1] }, understood: true });
    expect(convertDate('every day at 8am', 'en', ctx)).toMatchObject({ dueTime: '08:00', recurrence: { freq: 'day' }, understood: true });
    expect(convertDate('every! 3 days', 'en', ctx)).toMatchObject({ recurrence: { freq: 'day', interval: 3, afterCompletion: true } });
    expect(convertDate('Dec 24', 'en', ctx)).toMatchObject({ dueDate: '2026-12-24', understood: true });
    expect(convertDate('jeden Montag', 'de', ctx)).toMatchObject({ recurrence: { weekdays: [1] }, understood: true });
    expect(convertDate('when pigs fly', 'en', ctx).understood).toBe(false);
  });

  it('baut Projekte, Abschnitte, Unteraufgaben und Kommentare', () => {
    const csv = [
      'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
      'task,Einkaufen @laden,,4,1,Anna,,tomorrow,en,Europe/Berlin,,',
      'task,Milch,,1,2,Anna,,,en,Europe/Berlin,,',
      'note,Bio bitte,,,,Anna,,,,,,',
      'section,Später,,,,,,,,,,',
      'task,Keller,"Alles raus",2,1,Anna,,every! 3 days,en,Europe/Berlin,30,minute',
    ].join('\n');
    const plan = planTodoistImport([{ name: 'Haushalt [123].csv', text: csv }, { name: 'Inbox.csv', text: 'TYPE,CONTENT\ntask,Hallo' }], ctx);
    expect(plan.taskCount).toBe(4);
    expect(plan.commentCount).toBe(1);
    const [haushalt, inbox] = plan.projects;
    expect(haushalt).toMatchObject({ name: 'Haushalt', isInbox: false, sections: ['Später'] });
    expect(inbox?.isInbox).toBe(true);
    const einkaufen = haushalt!.tasks[0]!;
    expect(einkaufen).toMatchObject({ title: 'Einkaufen', labels: ['laden'], priority: 1, dueDate: '2026-11-21', section: null });
    expect(einkaufen.children[0]).toMatchObject({ title: 'Milch', priority: 4, comments: ['Bio bitte'] });
    expect(haushalt!.tasks[1]).toMatchObject({ title: 'Keller', section: 'Später', priority: 3, durationMin: 30, recurrence: { afterCompletion: true } });
  });
});
