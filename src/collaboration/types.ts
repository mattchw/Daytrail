import type {Trip} from '../model';

export type CollaborationRole = 'owner' | 'editor' | 'viewer';
export interface SharedTrip {
  trip: Trip;
  cloudId: string;
  sourceTripId: string;
  ownerId: string;
  role: CollaborationRole;
  revision: number;
  channelEpoch: string;
  updatedAt: string;
  deletedAt: string | null;
}
export type SharedTripMetadata = Omit<SharedTrip, 'trip'>;
export interface MergeConflict {
  path: string;
  label: string;
  kind: 'field' | 'order' | 'delete' | 'structure';
  base: unknown;
  local: unknown;
  remote: unknown;
}
export type ConflictChoices = Record<string, 'local' | 'remote'>;
export interface CollaborationConflict {
  tripId: string;
  cloudId: string;
  fields: MergeConflict[];
  remote: SharedTrip;
}
export interface SharedMutation {
  cloudId: string;
  sourceTripId: string;
  expectedRevision: number;
  mutationId: string;
  operation: 'save' | 'delete' | 'restore';
  trip?: Trip;
}
export interface SharedMutationResult {trip: SharedTrip; committedRevision: number; replayed: boolean}
export interface CollaborationMember {user_id:string;role:CollaborationRole;display_name:string}
export interface CollaborationInvitation {id:string;email:string;role:'editor'|'viewer';expires_at:string;created_at?:string}
export interface CollaborationActivity {id:string;actor_id:string|null;actor_name:string;kind:string;revision:number;created_at:string}
export interface CollaborationPeople {members:CollaborationMember[];invitations:CollaborationInvitation[]}
export interface CollaborationInvitePreview {trip_name:string;owner_name:string;role:'editor'|'viewer';email:string;expires_at:string}
export type CollaborationErrorCode = 'conflict' | 'auth' | 'revoked' | 'unavailable' | 'setup' | 'invalid';
export class CollaborationError extends Error {
  constructor(readonly code: CollaborationErrorCode, message: string, readonly current?: SharedTrip) {
    super(message); this.name = 'CollaborationError';
  }
}
export interface CollaborationRemote {
  list(): Promise<SharedTrip[]>;
  get(cloudId: string): Promise<SharedTrip>;
  enable(sourceTripId: string, expectedRevision: number): Promise<SharedTrip>;
  mutate(input: SharedMutation): Promise<SharedMutationResult>;
  people(cloudId:string):Promise<CollaborationPeople>;
  invite(cloudId:string,email:string,role:'editor'|'viewer'):Promise<CollaborationInvitation & {token:string}>;
  cancelInvite(cloudId:string,invitationId:string):Promise<void>;
  accept(token:string):Promise<SharedTrip>;
  previewInvite(token:string):Promise<CollaborationInvitePreview>;
  member(cloudId:string,userId:string,role:'editor'|'viewer'|null):Promise<void>;
  leave(cloudId:string):Promise<void>;
  activity(cloudId:string):Promise<CollaborationActivity[]>;
  subscribe?(trip: SharedTrip, onChange: () => void): () => void;
}
export const sharedUIId = (cloudId: string) => `collab-${cloudId}`;
export const sharedCapabilities = (role: CollaborationRole) => ({
  canEdit: role !== 'viewer', canManageMembers: role === 'owner', canDelete: role === 'owner', canViewPrivateBookings: role === 'owner',
});
