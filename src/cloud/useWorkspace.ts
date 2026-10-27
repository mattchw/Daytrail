import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import type {Trip} from '../model';
import {getBrowserSupabaseClient} from '../auth/browser';
import {createCloudRemote} from './remote';
import {createWorkspaceController} from './controller';
import {createIndexedWorkspaceStore} from './storage';

export interface UseWorkspaceOptions {
  ownerId: string | null;
  authReady: boolean;
  authOffline?: boolean;
  initialGuestTrips: Trip[];
  initialGuestError?: string | null;
}

/** A single durable workspace owns data; the editor only submits changes. */
export function useWorkspace(options: UseWorkspaceOptions) {
  const [controller] = useState(() => createWorkspaceController({
    store: createIndexedWorkspaceStore(),
    initialGuestTrips: options.initialGuestTrips,
    initialGuestError: options.initialGuestError,
  }));
  const remote = useMemo(() => {
    const client = options.ownerId && options.authReady && !options.authOffline ? getBrowserSupabaseClient() : null;
    return client && options.ownerId ? createCloudRemote(client, options.ownerId) : null;
  }, [options.ownerId, options.authReady, options.authOffline]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.setIdentity(options.ownerId, remote, options.authReady, options.authOffline);
    return () => controller.dispose();
  }, [controller, options.ownerId, options.authReady, options.authOffline, remote]);
  // Effects run after paint. Never expose the previous account during that render.
  const switchingOwner = snapshot.ownerId !== (options.authReady ? options.ownerId : null);
  const safeSnapshot = switchingOwner ? {...snapshot, trips: [], trash: [], conflicts: [], ready: false,
    ownerId: options.authReady ? options.ownerId : null, error: null, pendingCount: 0, acknowledgedCount:0, canUndo: false,
    statusById: {}, updatedAtById: {}, revisionById: {}, status: 'syncing' as const} : snapshot;
  return {
    ...safeSnapshot,
    changeTrips: controller.changeTrips,
    replaceTrips: controller.replaceTrips,
    undo: controller.undo,
    setScope: controller.setScope,
    refresh: controller.refresh,
    retry: controller.retry,
    migrateGuest: controller.migrateGuest,
    resolveConflict: controller.resolveConflict,
    restore: controller.restore,
    setEditing: controller.setEditing,
    prepareSignOut: controller.prepareSignOut,
  };
}
