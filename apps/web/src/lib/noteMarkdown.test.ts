import { describe, expect, it } from 'vitest';
import { countOpenChecks, looksLikeMarkdown, normalizeChecklists, noteGroup, wordCount } from './noteMarkdown';

describe('Notizen: Einfügen', () => {
  it('vereinheitlicht Checklisten aus anderen Apps', () => {
    const input = 'Wochenende\n[] Milch\n[ ] Brot morgen\n- [ ] Eier\n- [] Käse\n[x] Butter\n  ☐ Mehl\n☑ Zucker\nnormal [] im Satz';
    expect(normalizeChecklists(input)).toBe(
      'Wochenende\n- [ ] Milch\n- [ ] Brot morgen\n- [ ] Eier\n- [ ] Käse\n- [x] Butter\n  - [ ] Mehl\n- [x] Zucker\nnormal [] im Satz',
    );
    expect(normalizeChecklists('Zeile\r\n[] A')).toBe('Zeile\n- [ ] A');
  });

  it('erkennt Markdown und Checklisten, normalen Text nicht', () => {
    expect(looksLikeMarkdown('[] Milch\n[] Brot')).toBe(true);
    expect(looksLikeMarkdown('# Titel\nText')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b')).toBe(true);
    expect(looksLikeMarkdown('Das ist **fett**')).toBe(true);
    expect(looksLikeMarkdown('Hallo,\nwie geht es dir?')).toBe(false);
    expect(looksLikeMarkdown('Preis: 5-10 Euro')).toBe(false);
  });

  it('zählt offene Punkte', () => {
    expect(countOpenChecks(normalizeChecklists('[] a\n[x] b\n- [ ] c\ntext'))).toBe(2);
  });
});

describe('Notizen: Liste', () => {
  it('gruppiert nach Bearbeitungszeit', () => {
    const at = (d: string) => ({ pinned: false, updatedAt: `${d}T10:00:00` });
    expect(noteGroup({ pinned: true, updatedAt: '2020-01-01T10:00:00' }, '2026-11-26')).toBe('pinned');
    expect(noteGroup(at('2026-11-26'), '2026-11-26')).toBe('today');
    expect(noteGroup(at('2026-11-25'), '2026-11-26')).toBe('yesterday');
    expect(noteGroup(at('2026-11-21'), '2026-11-26')).toBe('week');
    expect(noteGroup(at('2026-11-01'), '2026-11-26')).toBe('month');
    expect(noteGroup(at('2026-09-01'), '2026-11-26')).toBe('older');
  });

  it('zählt Wörter', () => {
    expect(wordCount('Hallo Welt – das ist ein E-Mail-Test, oder?')).toBe(7);
    expect(wordCount('')).toBe(0);
  });
});
