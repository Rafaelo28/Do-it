import type {
  CommentData,
  LabelData,
  MemberInfo,
  Me,
  Mutation,
  NoteData,
  ObjectType,
  ProjectData,
  ReminderData,
  SectionData,
  TaskData,
} from '@do-it/shared';
import Dexie, { type Table } from 'dexie';

export type WithId<T> = T & { id: string };
export type Project = WithId<ProjectData>;
export type Section = WithId<SectionData>;
export type Task = WithId<TaskData>;
export type Label = WithId<LabelData>;
export type Reminder = WithId<ReminderData>;
export type Comment = WithId<CommentData>;
export type Note = WithId<NoteData>;

export interface OutboxEntry {
  seq?: number;
  mid: string;
  type: ObjectType;
  id: string;
  op: Mutation['op'];
  data?: Record<string, unknown>;
  hlc: string;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

export class DoItDb extends Dexie {
  projects!: Table<Project, string>;
  sections!: Table<Section, string>;
  tasks!: Table<Task, string>;
  labels!: Table<Label, string>;
  reminders!: Table<Reminder, string>;
  comments!: Table<Comment, string>;
  notes!: Table<Note, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<MetaEntry, string>;

  constructor() {
    super('do-it');
    this.version(1).stores({
      projects: 'id',
      sections: 'id, projectId',
      tasks: 'id, projectId, parentId, dueDate',
      labels: 'id',
      reminders: 'id, taskId',
      comments: 'id, taskId',
      outbox: '++seq, id',
      meta: 'key',
    });
    this.version(2).stores({ notes: 'id, projectId' });
  }

  tableFor(type: ObjectType): Table<WithId<Record<string, unknown>>, string> {
    const map = {
      project: this.projects,
      section: this.sections,
      task: this.tasks,
      label: this.labels,
      reminder: this.reminders,
      comment: this.comments,
      note: this.notes,
    } as const;
    return map[type] as unknown as Table<WithId<Record<string, unknown>>, string>;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }
}

export const db = new DoItDb();

export interface MetaState {
  me: Me | null;
  members: MemberInfo[];
  projectIds: string[];
}
