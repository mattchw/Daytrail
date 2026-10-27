import type {TravelMark} from '../travel/model';
/** Timestamp and completion mark share the same durable transaction. */
export interface TodayCommit {dayId:string;previous:string|null;next:string|null;mark?:{targetId:string;previous:TravelMark;expected:TravelMark}}
export interface TodayPersistence {read(dayId:string):Promise<string|null>;commit(change:TodayCommit):Promise<void>}
