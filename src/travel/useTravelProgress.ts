import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {getBrowserSupabaseClient} from '../auth/browser';
import {createTravelRemote} from './remote';
import {createTravelController, type TravelContext} from './controller';
import {createIndexedTravelStore} from './storage';
import {travelTargetReferences} from './model';

export function useTravelProgress(options: TravelContext) {
  const [controller] = useState(() => createTravelController({store: createIndexedTravelStore()}));
  const remote = useMemo(() => {
    const client = options.ownerId && options.authReady && !options.authOffline ? getBrowserSupabaseClient() : null;
    return client && options.ownerId ? createTravelRemote(client, options.ownerId) : null;
  }, [options.ownerId, options.authReady, options.authOffline]);
  // Notes, visit durations, and ordinary clock renders do not restart requests.
  const references = JSON.stringify(Object.entries(options.trip ? travelTargetReferences(options.trip) : {}));
  const readyIds = JSON.stringify(options.cloudReadyTripIds ? [...options.cloudReadyTripIds].sort() : null);
  useEffect(() => {
    void controller.setContext(options, remote);
    // Every persistence/network input is captured by these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, remote, options.ownerId, options.authReady, options.authOffline, options.scope, options.trip?.id, options.enabled, options.tripCloudReady, references, readyIds]);
  useEffect(() => () => controller.dispose(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const changed = snapshot.ownerId !== (options.authReady ? options.ownerId : null) || snapshot.scope !== options.scope
    || snapshot.tripId !== (options.trip?.id || null) || snapshot.referenceKey !== references;
  const visible = changed ? {...snapshot, ownerId: options.authReady ? options.ownerId : null, scope: options.scope,
    tripId: options.trip?.id || null, marks: {}, conflicts: [], ready: false, error: null, canUndo: false,
    pendingCount: 0, acknowledgedCount:0, pendingTripIds: [], status: 'syncing' as const} : snapshot;
  return {...visible, ready: visible.ready && options.enabled && (options.scope === 'guest' || options.authReady),
    todayPersistence: controller.todayPersistence, setState: controller.setState, retry: controller.retry, refresh: controller.refresh,
    resolveConflict: controller.resolveConflict, undo: controller.undo, prepareSignOut: controller.prepareSignOut};
}
