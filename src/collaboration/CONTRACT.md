# Collaboration database contract

Migration: `202610270003_daytrail_collaboration.sql`. Browser calls use the existing authenticated Supabase client. Every mutating/read RPC below takes `p_expected_actor_id: uuid`, checks it against `auth.uid()`, and rechecks current membership. The browser must never use an administrative key.

## Trip identity and projection

A shared trip has a globally unique `cloud_trip_id` UUID. Its canonical JSON retains its legacy `trip_id` in `document.id`. Client workspace IDs use `collab-${cloud_trip_id}`; translate only at the remote boundary.

Trip projection:

```ts
{
  cloud_trip_id: string; owner_id: string; trip_id: string;
  schema_version: 2; document: Trip; revision: number;
  updated_at: string; deleted_at: string | null;
  role: 'owner' | 'editor' | 'viewer'; channel_epoch: string;
}
```

Owners receive their private booking fields reassembled from protected storage. Editors and viewers receive no private fields. `daytrail_trips.document` itself contains only the shared projection after sharing is enabled. All sidecar tables are inaccessible to browser roles, have RLS enabled with no client policies, and are accessed only through the security-definer RPCs.

Private fields are `bookingReference`, `privateNotes`, `departureGate`, and `arrivalGate` for flights; `bookingReference`, `privateNotes`, `contact`, and `bookingUrl` for stays. Editor submissions containing any of these are rejected. Their absence in editor writes does not delete the owner's values. Deleting a booking does discard its secrets so reusing its ID cannot resurrect private data.

## Read, enable and save

| RPC | Extra parameters | Result |
| --- | --- | --- |
| `daytrail_collab_list` | none | Trip projection array, including tombstones |
| `daytrail_collab_get` | `p_cloud_trip_id: uuid` | Trip projection |
| `daytrail_collab_enable` | `p_trip_id: text`, `p_expected_revision: bigint` | `{status:'ok'|'conflict',trip}` |
| `daytrail_collab_mutate` | `p_cloud_trip_id`, `p_expected_revision`, `p_mutation_id: uuid`, `p_operation:'save'|'delete'|'restore'`, `p_document: jsonb|null` | Result below |

Enable is an explicit owner-only transition after the owner's existing save queue is settled. It extracts private fields, increments revision and permanently gates the older whole-trip RPC. Repeating enable is idempotent. Prior private trips retain their existing protocol. Sharing does not create invitations or upload unsaved local drafts implicitly.

Save is server compare-and-swap: the client merges independent changes against a conflict response and retries the merged snapshot on the returned revision. Validation and permission checks are server-side, and all changes to a trip are transactional. On a revision mismatch, the server returns `{status:'conflict',trip:latest}` without writing. Delete/restore require owner role.

Success returns `{status:'ok',trip:latest,committed_revision:number,replayed:boolean}`. Receipt identity is `(cloud_trip_id,actor_id,mutation_id)`. An exact retry after other users' writes returns the **latest** projection plus the original `committed_revision`, with `replayed:true`. It must acknowledge that submitted change without replacing newer changes with the old draft. Reusing an ID with different input is rejected. Revoked or downgraded writers cannot retrieve accepted receipts through the mutation API.

## Invitations and membership

All trip-scoped RPCs also take `p_cloud_trip_id: uuid`.

| RPC | Extra parameters | Result |
| --- | --- | --- |
| `daytrail_collab_people` | none | `{members:[{user_id,role,display_name}],invitations:[{id,email,role,expires_at,created_at}]}` |
| `daytrail_collab_invite` | `p_email`, `p_role:'editor'|'viewer'` | `{id,email,role,expires_at,token}` |
| `daytrail_collab_cancel_invite` | `p_invitation_id: uuid` | `{status:'ok'}` |
| `daytrail_collab_member` | `p_user_id: uuid`, `p_role:'editor'|'viewer'|null` | `{status:'ok'}`; null removes |
| `daytrail_collab_leave` | none | `{status:'ok'}` |
| `daytrail_collab_activity` | none | `[{id,actor_id,actor_name,kind,revision,created_at}]` newest first |

`daytrail_collab_accept(p_expected_actor_id,p_token:text)` returns the accepted trip projection. It deliberately does not require a cloud trip ID before authentication.

Migration `202610270004_daytrail_invitation_preview.sql` adds `daytrail_collab_preview_invite(p_expected_actor_id,p_token:text) -> {trip_name,owner_name,role,email,expires_at}`. Preview requires a matching server-verified email and an uncancelled, unexpired token. It never creates membership or exposes itinerary data. An already accepted invitation can be previewed only by its still-authorised recipient, and returns their current role. This supports a deliberate review-and-accept screen after Google sign-in.

Only owners can invite, cancel or manage roles; owners cannot remove/downgrade themselves or leave their own trip. Membership creation requires explicit invitation acceptance with a server-confirmed matching email. Invites expire after seven days, store only SHA-256 token hashes, and are single-use except idempotent acceptance by an existing member. Removing a member makes their accepted invitation unusable. Reissuing an invitation cancels older pending links to that email. The raw token appears only in the create response. Members receive an empty pending-invitations list.

Recent activity is bounded to 100 entries, contains only actor identity, fixed event kind, revision and timestamp, and never includes document patches or private booking fields.

## Personal travel progress

`daytrail_collab_list_travel_marks(p_expected_actor_id,p_cloud_trip_id)` and `daytrail_collab_mutate_travel_mark(p_expected_actor_id,p_cloud_trip_id,p_target_id,p_place_id,p_state,p_expected_revision,p_mutation_id)` match the existing travel remote contract. Returned marks contain `owner_id: actor_id` and `trip_id: collab-${cloud_trip_id}`. Each member, including viewers, has independent progress. Owner progress from the legacy table is imported without overwriting existing shared-mode marks. Progress does not increment itinerary revisions or broadcast personal status to other members. Exact retries have durable receipts; obsolete target/place references are rejected before receipt acknowledgement.

## Realtime

Subscribe with `private:true` to `daytrail:${cloud_trip_id}:${channel_epoch}` and event `trip_changed`. Payload is only `{cloud_trip_id,revision}`. Fetch through the authorised RPC to obtain changes. Membership changes rotate `channel_epoch`, and send a final invalidation on the old topic so remaining members reconnect and removed members discard access. Fetch after a notification even when revision is unchanged: membership/epoch changes need not edit the itinerary revision.

`daytrail_collab_can_receive(p_topic)` is the narrow authenticated RLS predicate on `realtime.messages`. It allows only a current member/owner on the current epoch. No client broadcast-insert policy is added. Hosted environments should not have a broader permissive Realtime policy that overrides this access restriction. Missing Realtime infrastructure does not prevent database saving; refresh/reconnect polling remains required because notifications are not a durable change log.

## Errors

- `42501`, `Daytrail account mismatch`: current session changed.
- `42501`, `You no longer have access to this shared trip`: missing/revoked access.
- `42501`, `Sign in with the invited Google account`: wrong or unconfirmed email.
- `42501`, `You do not have permission to edit this shared trip`: viewer save or editor delete/restore.
- `22023`, `Invitation expired or unavailable`: invalid, cancelled, expired or unusable token.
- `22023`, `Invalid shared trip update`: invalid canonical data or mutation parameters.
- `22023`, `Mutation ID was reused`: a retry changed its immutable request payload.
- `0A000` on the legacy trip mutation RPC: reload and use the collaboration protocol.

Do not treat all `42501` cases during invitation acceptance as a global sign-out. Wrong-invitation-account should preserve the current account and allow the user to choose another account deliberately.
