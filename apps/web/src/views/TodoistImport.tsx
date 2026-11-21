import type { Me } from '@do-it/shared';
import { useState } from 'react';
import { IconWarn } from '../components/Icons';
import { useData } from '../lib/data';
import { toast } from '../lib/store';
import { sync } from '../lib/sync';
import { nowLocal } from '../lib/time';
import { buildImport, fetchTodoist, planFromApi, planFromCsv, readImportFiles, type ImportPlan, type ImportTask } from '../lib/todoist';

const count = (tasks: ImportTask[]): number => tasks.reduce((n, t) => n + 1 + count(t.children), 0);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;

/** Übernahme aus Todoist: per API-Schlüssel (alles, jeder Tarif) oder aus Backup/CSV. */
export function TodoistImport({ me }: { me: Me }) {
  const { projects, sections, tasks, labels, inbox } = useData();
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const ctx = () => {
    const n = nowLocal();
    return { today: n.date, now: n.time, timeZone: me.timezone };
  };

  async function load(fn: () => Promise<ImportPlan>) {
    setError(null);
    setResult(null);
    setBusy('Lade …');
    try {
      const p = await fn();
      if (!p.taskCount && !p.projects.length) setError('In den Daten wurden keine Aufgaben gefunden.');
      else setPlan(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!plan || !inbox) return;
    const built = buildImport(plan, {
      me,
      inboxId: inbox.id,
      existingProjects: projects.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, sortKey: p.sortKey })),
      existingSections: sections.map((s) => ({ id: s.id, projectId: s.projectId, name: s.name, sortKey: s.sortKey })),
      existingTasks: tasks.map((t) => ({ id: t.id, projectId: t.projectId, parentId: t.parentId, title: t.title, dueDate: t.dueDate, sortKey: t.sortKey })),
      existingLabels: labels.map((l) => l.name),
    });
    const all = built.mutations;
    setBusy(`Übernehme … 0 %`);
    try {
      for (let i = 0; i < all.length; i += 300) {
        await sync.mutateMany(all.slice(i, i + 300));
        setBusy(`Übernehme … ${Math.round((Math.min(i + 300, all.length) / Math.max(1, all.length)) * 100)} %`);
      }
      const text = `${plural(built.tasks, 'Aufgabe', 'Aufgaben')} übernommen${built.skipped ? `, ${plural(built.skipped, 'war', 'waren')} schon da` : ''}.`;
      setResult(text);
      toast(text);
      setPlan(null);
    } catch (e) {
      setError(`Abgebrochen: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Aus Todoist übernehmen</strong>
      <span className="small muted">
        Holt alle offenen Aufgaben mit Projekten, Unterprojekten, Abschnitten, Unteraufgaben, Labels, Kommentaren und Erinnerungen. Gleichnamige Projekte werden ergänzt,
        ein zweiter Durchlauf legt nichts doppelt an.
      </span>

      {!plan && (
        <>
          <form
            className="todoist-token"
            onSubmit={(e) => {
              e.preventDefault();
              const t = token;
              void load(async () => {
                const data = await fetchTodoist(t);
                setToken('');
                return planFromApi(data, ctx());
              });
            }}
          >
            <label className="field" style={{ flex: 1 }}>
              <span>API-Schlüssel aus Todoist</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="z. B. 0123456789abcdef0123456789abcdef01234567"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <button className="btn primary" disabled={!!busy || token.trim().length < 20}>
              Aus Todoist laden
            </button>
          </form>
          <span className="small muted">
            In Todoist: <b>Einstellungen → Integrationen → Entwickler → API-Token kopieren</b>. Funktioniert in jedem Todoist-Tarif. Der Schlüssel geht nur direkt an Todoist und
            wird nicht gespeichert.
          </span>
          <details className="small">
            <summary>Stattdessen ein Backup oder eine CSV-Datei verwenden</summary>
            <p className="muted" style={{ margin: '6px 0' }}>
              Backups (ZIP) gibt es in Todoist Pro unter Einstellungen → Backups. Einzelne Projekte lassen sich in jedem Tarif über „Als Vorlage exportieren“ als CSV speichern.
              Die ZIP-Datei muss nicht entpackt werden.
            </p>
            <input
              type="file"
              accept=".zip,.csv,application/zip,text/csv"
              multiple
              disabled={!!busy}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void load(async () => planFromCsv(await readImportFiles(files), ctx()));
              }}
            />
          </details>
        </>
      )}

      {busy && <span className="small">{busy}</span>}
      {error && (
        <span className="small row error-text" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <IconWarn size={14} /> {error}
        </span>
      )}
      {result && <span className="small">{result}</span>}

      {plan && (
        <div className="hint" style={{ display: 'grid', gap: 8 }}>
          <span>
            <b>Bereit:</b> {plural(plan.projects.length, 'Projekt', 'Projekte')} · {plural(plan.taskCount, 'Aufgabe', 'Aufgaben')} ·{' '}
            {plural(plan.commentCount, 'Kommentar', 'Kommentare')} · {plural(plan.reminderCount, 'Erinnerung', 'Erinnerungen')} · {plural(plan.labels.length, 'Label', 'Labels')}
          </span>
          <details className="small">
            <summary>Projekte ansehen</summary>
            <ul className="import-projects">
              {plan.projects.map((p) => (
                <li key={p.key} style={{ paddingLeft: p.parentKey ? 16 : 0 }}>
                  <span>
                    {p.isInbox ? 'Eingang' : p.name}
                    {p.archived && <span className="muted"> (archiviert)</span>}
                  </span>
                  <span className="muted">{plural(count(p.tasks), 'Aufgabe', 'Aufgaben')}</span>
                </li>
              ))}
            </ul>
          </details>
          {plan.warnings.length > 0 && (
            <details className="small">
              <summary className="row" style={{ gap: 6, display: 'flex' }}>
                <IconWarn size={14} /> {plural(plan.warnings.length, 'Hinweis', 'Hinweise')} – nichts geht verloren, Unklares steht in der Beschreibung
              </summary>
              <ul className="import-warnings">
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <span className="small muted">Erledigte Aufgaben bleiben in Todoist – Todoist gibt sie beim Export nicht heraus.</span>
          <div className="row">
            <button className="btn primary" disabled={!!busy || !inbox} onClick={() => void run()}>
              Jetzt übernehmen
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => setPlan(null)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
