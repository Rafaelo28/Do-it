import { describe, expect, it } from 'vitest';
import { markdownToText, noteTaskIds, noteTitle, taskRef } from './notes';

const A = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

describe('Notizen', () => {
  it('findet eingebettete Aufgaben', () => {
    const body = `# Einkauf\n\n${taskRef(A)}\nText [[task:kaputt]]\n  ${taskRef(B)}  \n${taskRef(A)}`;
    expect(noteTaskIds(body)).toEqual([A, B]);
    expect(noteTaskIds('[[task:' + A + ']] mitten im Satz')).toEqual([]);
  });

  it('macht aus Markdown Klartext', () => {
    expect(markdownToText(`# Titel\n\n- [ ] Milch\n- [x] **Brot**\n> Zitat mit [Link](https://x.de)\n\n${taskRef(A)}\n\n\`\`\`\ncode\n\`\`\``)).toBe(
      'Titel Milch Brot Zitat mit Link',
    );
  });

  it('Titel aus eigenem Titel oder erster Zeile', () => {
    expect(noteTitle({ title: ' Plan ', body: 'x' })).toBe('Plan');
    expect(noteTitle({ title: '', body: `\n${taskRef(A)}\n## Urlaub planen\nmehr` })).toBe('Urlaub planen');
    expect(noteTitle({ title: '', body: '' })).toBe('Unbenannte Notiz');
  });
});
