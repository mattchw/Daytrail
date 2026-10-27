import type {Place} from './model';
import type {OpeningInfo} from './openingHours';

/** Google supplies the schedule; admission cutoffs are explicitly traveller-entered. */
export function withPlaceAdmission(info: OpeningInfo | undefined, place: Place | undefined): OpeningInfo | undefined {
  if (!place) return info;
  if (!place.lastEntryMinutes || !Object.keys(place.lastEntryMinutes).length) {
    if (!info?.lastEntryMinutes) return info;
    const {lastEntryMinutes: _oldCutoff, ...providerInfo} = info;
    return providerInfo;
  }
  return {...info, fetchedAt: info?.fetchedAt ?? 0, lastEntryMinutes: place.lastEntryMinutes};
}
