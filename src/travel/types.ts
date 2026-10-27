export type TravelState = 'planned' | 'done' | 'skipped';
export interface TravelMark {
  targetId: string;
  /** Stable itinerary identity: replacing this ID invalidates the displayed mark.
   * Editing a place's name/coordinates under the same ID preserves progress. */
  placeId: string;
  state: TravelState;
  revision: number;
  updatedAt: string;
}
export interface TravelMutation {
  tripId: string;
  targetId: string;
  placeId: string;
  state: TravelState;
  expectedRevision: number;
  mutationId: string;
}
export interface TravelRemote {
  /** Includes reset and obsolete-location marks, so their revisions remain known. */
  list(tripId: string): Promise<TravelMark[]>;
  mutate(input: TravelMutation): Promise<TravelMark>;
}
export type TravelErrorCode = 'conflict' | 'auth' | 'unavailable' | 'setup' | 'invalid';
export class TravelError extends Error {
  readonly code: TravelErrorCode;
  readonly current?: TravelMark | null;
  constructor(code: TravelErrorCode, message: string, current?: TravelMark | null) {
    super(message);
    this.name = 'TravelError';
    this.code = code;
    this.current = current;
  }
}
