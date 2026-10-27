import type { Trip } from '../model';

export interface CloudTrip {
  trip: Trip;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CloudMutation {
  tripId: string;
  expectedRevision: number;
  mutationId: string;
  /** Absent only for an immutable outbox request issued by the version 1 app. */
  schemaVersion?: 1 | 2;
  operation: 'create' | 'save' | 'delete' | 'restore';
  trip?: Trip;
}

export interface CloudRemote {
  /** Includes deleted rows so an offline device cannot resurrect a removed trip. */
  list(): Promise<CloudTrip[]>;
  mutate(input: CloudMutation): Promise<CloudTrip>;
}

export type CloudErrorCode = 'conflict' | 'auth' | 'unavailable' | 'setup' | 'invalid';
export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly current?: CloudTrip;
  constructor(code: CloudErrorCode, message: string, current?: CloudTrip) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.current = current;
  }
}
