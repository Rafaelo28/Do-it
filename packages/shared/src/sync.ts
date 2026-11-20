import { z } from 'zod';
import { idSchema, OBJECT_TYPES, type MemberInfo, type Me, type ObjectType } from './model';

export const mutationSchema = z.strictObject({
  /** eindeutige ID der Änderung (Idempotenz) */
  mid: z.string().min(8).max(64),
  type: z.enum(OBJECT_TYPES as [ObjectType, ...ObjectType[]]),
  id: idSchema,
  op: z.enum(['put', 'delete']),
  /** geänderte Felder (bei put) */
  data: z.record(z.string(), z.unknown()).optional(),
  hlc: z.string().max(80),
});

export type Mutation = z.infer<typeof mutationSchema>;

export const pushRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(64),
  mutations: z.array(mutationSchema).max(500),
});

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
}

export type ServerMessage = { type: 'poke' } | { type: 'hello'; userId: string } | { type: 'ping' };
