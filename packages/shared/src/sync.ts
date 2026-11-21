import type { z } from 'zod';
import type { MemberInfo, Me, ObjectType } from './model';
import type { mutationSchema, pushRequestSchema } from './schemas';

export type Mutation = z.infer<typeof mutationSchema>;

export type PushRequest = z.infer<typeof pushRequestSchema>;

export interface PushResponse {
  applied: string[];
  rejected: { mid: string; reason: string }[];
}

export interface SyncObject {
  id: string;
  type: ObjectType;
  projectId: string | null;
  ownerId: string | null;
  data: Record<string, unknown>;
  deleted: boolean;
  seq: number;
}

export interface PullResponse {
  objects: SyncObject[];
  cursor: number;
  hasMore: boolean;
  /** alle Projekte, die der Nutzer gerade sehen darf */
  projectIds: string[];
  members: MemberInfo[];
  me: Me;
  /** Zeitpunkt des neuesten Briefings (damit Geräte nur bei Bedarf nachladen) */
  briefingAt: string | null;
}

export type ServerMessage = { type: 'poke' } | { type: 'hello'; userId: string } | { type: 'ping' };
