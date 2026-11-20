import { parseMany, parseTask, type ParseContext, type ParseResult, type Span, type SpanType } from '@do-it/parser';
import { type TaskData } from '@do-it/shared';
import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { createTaskFromParse } from '../lib/actions';
import { suggest, train } from '../lib/classifier';
import { useData } from '../lib/data';
import { toast } from '../lib/store';
import { syncState } from '../lib/sync';
import { nowLocal } from '../lib/time';
import { IconBell, IconCalendar, IconClock, IconFlag, IconHash, IconRepeat, IconSparkle, IconTag, IconUser, IconWarn } from './Icons';
import { dueLabel, durationLabel, PRIORITY_COLOR, recurrenceLabel, reminderLabel } from './ui';

const MARK: Record<SpanType, string> = {
  date: 'var(--hl-date)',
  time: 'var(--hl-date)',
  deadline: 'var(--hl-priority)',
  recurrence: 'var(--hl-recurrence)',
  reminder: 'var(--hl-reminder)',
  duration: 'var(--hl-duration)',
  priority: 'var(--hl-priority)',
  project: 'var(--hl-project)',
  label: 'var(--hl-label)',
  assignee: 'var(--hl-assignee)',
  rotation: 'var(--hl-assignee)',
};

export interface QuickAddProps {
  projectId?: string;
  sectionId?: string | null;
  parentId?: string | null;
  defaults?: Partial<TaskData>;
  autoFocus?: boolean;
  initialText?: string;
  placeholder?: string;
  onDone?: () => void;
}

export function QuickAdd(props: QuickAddProps) {
  const { projects, tasks, labels, inbox, projectMap } = useData();
  const { me, members } = syncState.use();
  const [text, setText] = useState(props.initialText ?? '');
  const [ignore, setIgnore] = useState<string[]>([]);
  const [manualProject, setManualProject] = useState<string | null>(null);
  const [batch, setBatch] = useState<ParseResult[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const ctx = useMemo<ParseContext>(() => {
    const now = nowLocal();
    const uniqueMembers = new Map<string, { id: string; name: string }>();
    for (const m of members) uniqueMembers.set(m.userId, { id: m.userId, name: m.name });
    const s = me?.settings;
    return {
      today: now.date,
      now: now.time,
      userId: me?.id,
      projects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, isInbox: p.isInbox })),
      members: [...uniqueMembers.values()],
      labels: labels.map((l) => l.name),
      times: s
        ? { morning: s.morningTime, noon: s.noonTime, afternoon: s.afternoonTime, evening: s.eveningTime, night: s.nightTime, workEnd: s.workEndTime }
        : undefined,
      ignore,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, members, labels, me, ignore, text === '']);

  const result = useMemo(() => parseTask(text, ctx), [text, ctx]);
  const model = useMemo(() => train(tasks, projects), [tasks, projects]);
  const learned = useMemo(
    () => (!result.projectId && !result.newProjectName && !manualProject && result.title.length > 2 ? suggest(model, result.title) : null),
    [model, result, manualProject],
  );

  const baseProject = props.projectId ?? inbox?.id ?? '';
  const effectiveProject = manualProject ?? result.projectId ?? baseProject;
  const memberName = (id: string | null) => members.find((m) => m.userId === id)?.name ?? '?';

  function ignoreSpans(types: SpanType[]) {
    const texts = result.spans.filter((s) => types.includes(s.type)).map((s) => s.text.trim().toLowerCase());
    setIgnore((i) => [...i, ...texts]);
    inputRef.current?.focus();
  }

  function reset() {
    setText('');
    setIgnore([]);
    setManualProject(null);
  }

  async function submit() {
    if (!me || !result.title.trim()) return;
    // Sofort leeren, damit man direkt weitertippen kann; gespeichert wird im Hintergrund.
    const r: ParseResult = manualProject ? { ...result, projectId: manualProject, newProjectName: null } : result;
    reset();
    inputRef.current?.focus();
    try {
      await createTaskFromParse(r, {
        projectId: baseProject,
        sectionId: props.sectionId,
        parentId: props.parentId,
        me,
        defaults: props.defaults,
      });
      const target = r.newProjectName ?? projectMap.get(r.projectId ?? baseProject)?.name;
      if ((r.projectId && r.projectId !== props.projectId) || r.newProjectName) toast(`Zu „${target}“ hinzugefügt`);
      props.onDone?.();
    } catch (e) {
      toast(`Konnte nicht gespeichert werden: ${(e as Error).message}`, { kind: 'error' });
      setText((t) => t || text);
    }
  }

  async function submitBatch() {
    if (!me || !batch) return;
    for (const r of batch) {
      if (r.title.trim()) await createTaskFromParse(r, { projectId: baseProject, sectionId: props.sectionId, parentId: props.parentId, me, defaults: props.defaults });
    }
    toast(`${batch.length} Aufgaben angelegt`);
    setBatch(null);
    reset();
    props.onDone?.();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      if (text) reset();
      else props.onDone?.();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text');
    if (pasted.includes('\n')) {
      e.preventDefault();
      setBatch(parseMany(pasted, ctx));
    }
  }

  const syncScroll = () => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
  };

  if (batch) {
    return (
      <div className="quickadd">
        <strong>{batch.length} Aufgaben erkannt</strong>
        <ul className="list-plain" style={{ margin: '10px 0' }}>
          {batch.map((r, i) => (
            <li key={i}>
              <span>•</span>
              <span>{r.title}</span>
              {r.dueDate && <span className="chip" style={{ '--chip': MARK.date } as React.CSSProperties}>{dueLabel(r.dueDate, r.dueTime, ctx.today)}</span>}
            </li>
          ))}
        </ul>
        <div className="qa-foot">
          <span className="spacer" />
          <button className="btn" onClick={() => setBatch(null)}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={() => void submitBatch()}>
            Alle anlegen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quickadd">
      <div className="qa-field">
        <div className="qa-mirror" ref={mirrorRef} aria-hidden="true">
          {renderMarks(text, result.spans)}
        </div>
        <input
          ref={inputRef}
          className="qa-input"
          value={text}
          autoFocus={props.autoFocus}
          placeholder={props.placeholder ?? 'z. B. „Morgen 15 Uhr Zahnarzt anrufen #Gesundheit“'}
          aria-label="Neue Aufgabe"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setIgnore([]);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onScroll={syncScroll}
          onSelect={syncScroll}
        />
      </div>

      {text && (
        <div className="chips">
          {result.dueDate && (
            <button className="chip" style={chip('date')} onClick={() => ignoreSpans(['date', 'time'])} title="Tippen, um das Datum als Text zu behalten">
              <IconCalendar size={14} /> {dueLabel(result.dueDate, result.dueTime, ctx.today)}
            </button>
          )}
          {result.recurrence && (
            <button className="chip" style={chip('recurrence')} onClick={() => ignoreSpans(['recurrence'])}>
              <IconRepeat size={14} /> {recurrenceLabel(result.recurrence)}
            </button>
          )}
          {result.deadline && (
            <button className="chip" style={chip('deadline')} onClick={() => ignoreSpans(['deadline'])}>
              <IconFlag size={14} /> Deadline {dueLabel(result.deadline, null, ctx.today)}
            </button>
          )}
          {!manualProject && result.projectId && (
            <button
              className="chip"
              style={chip('project')}
              onClick={() => ignoreSpans(['project'])}
              title={result.projectVia === 'explicit' ? undefined : 'Im Satz erkannt – tippen zum Entfernen'}
            >
              <IconHash size={14} /> {projectMap.get(result.projectId)?.name}
              {result.projectVia !== 'explicit' && <span className="muted"> · erkannt</span>}
            </button>
          )}
          {!manualProject && result.newProjectName && (
            <button className="chip" style={chip('project')} onClick={() => ignoreSpans(['project'])}>
              <IconHash size={14} /> Neues Projekt „{result.newProjectName}“
            </button>
          )}
          {!manualProject &&
            result.projectSuggestions.map((id) => (
              <button key={id} className="chip suggest" onClick={() => setManualProject(id)}>
                <IconHash size={14} /> {projectMap.get(id)?.name}?
              </button>
            ))}
          {learned && (
            <button className="chip suggest" onClick={() => setManualProject(learned.projectId)} title="Aus deinen bisherigen Aufgaben gelernt">
              <IconSparkle size={14} /> Vorschlag: {projectMap.get(learned.projectId)?.name}
            </button>
          )}
          {manualProject && (
            <button className="chip" style={chip('project')} onClick={() => setManualProject(null)}>
              <IconHash size={14} /> {projectMap.get(manualProject)?.name} ✕
            </button>
          )}
          {result.labels.map((l) => (
            <button key={l} className="chip" style={chip('label')} onClick={() => ignoreSpans(['label'])}>
              <IconTag size={14} /> {l}
            </button>
          ))}
          {result.assigneeId && !result.rotation.length && (
            <button className="chip" style={chip('assignee')} onClick={() => ignoreSpans(['assignee'])}>
              <IconUser size={14} /> {memberName(result.assigneeId)}
            </button>
          )}
          {result.rotation.length > 0 && (
            <button className="chip" style={chip('rotation')} onClick={() => ignoreSpans(['rotation'])}>
              <IconUser size={14} /> abwechselnd {result.rotation.map(memberName).join(' → ')}
            </button>
          )}
          {result.priority < 4 && (
            <button className="chip" style={{ ...chip('priority'), color: PRIORITY_COLOR[result.priority] }} onClick={() => ignoreSpans(['priority'])}>
              <IconFlag size={14} /> P{result.priority}
            </button>
          )}
          {result.reminders.map((r, i) => (
            <button key={i} className="chip" style={chip('reminder')} onClick={() => ignoreSpans(['reminder'])}>
              <IconBell size={14} /> {r.kind === 'relative' ? reminderLabel(r.offsetMin) : dueLabel(r.date, r.time, ctx.today)}
            </button>
          ))}
          {result.durationMin && (
            <button className="chip" style={chip('duration')} onClick={() => ignoreSpans(['duration'])}>
              <IconClock size={14} /> {durationLabel(result.durationMin)}
            </button>
          )}
          {result.warnings.map((w) => (
            <span key={w} className="chip warn">
              <IconWarn size={14} /> {w}
            </span>
          ))}
        </div>
      )}

      <div className="qa-foot">
        <select
          className="input"
          value={effectiveProject}
          onChange={(e) => setManualProject(e.target.value)}
          aria-label="Projekt"
          style={{ width: 'auto', minHeight: 32, padding: '3px 8px' }}
        >
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.isInbox ? '📥 ' : '# '}
                {p.name}
              </option>
            ))}
        </select>
        <span className="spacer" />
        {props.onDone && (
          <button className="btn ghost" onClick={props.onDone}>
            Abbrechen
          </button>
        )}
        <button className="btn primary" disabled={!result.title.trim()} onClick={() => void submit()}>
          Hinzufügen
        </button>
      </div>
    </div>
  );
}

function chip(type: SpanType): React.CSSProperties {
  return { '--chip': MARK[type] } as React.CSSProperties;
}

function renderMarks(text: string, spans: Span[]) {
  const out: React.ReactNode[] = [];
  let pos = 0;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    if (s.start < pos) continue;
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push(
      <mark key={s.start} style={{ '--mark': MARK[s.type] } as React.CSSProperties}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  }
  out.push(text.slice(pos) + ' ');
  return out;
}
