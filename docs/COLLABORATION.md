# Collaborative planning

Daytrail supports a live shared itinerary with owner, editor and viewer access. Existing device trips and private account trips keep their previous behaviour until the owner explicitly enables collaboration.

## Using a shared trip

1. Sign in with Google and save the trip to **Your account**. Wait for pending changes to finish saving.
2. Open **Share**, then choose **Enable collaboration**. The current account remains the owner.
3. Enter a friend’s Google account email and choose **Editor** or **Viewer**.
4. Choose **Create invitation link**, copy the link and send it yourself. Daytrail does not send invitation emails.
5. The recipient opens the link and signs in with the invited account. They can review the trip name, owner, assigned role and expiry before explicitly accepting. Shared trips appear under **Trips you’re planning together** in the account library.

Invitations expire after seven days. A new invitation for the same email cancels that email’s older pending links. The owner can cancel pending invitations, change member permissions and remove members. An invitation can be accepted only by the matching verified account; possessing the link alone is insufficient. Repeating a successful acceptance is safe, but a used invitation cannot restore access after the member has been removed.

Invitation preview is an authenticated read. It does not join the trip or return its itinerary or private booking data. Signed-out visitors see a sign-in prompt; the wrong account is asked to switch accounts. Cancelled, expired and unavailable links cannot be accepted.

| Action | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Read shared plans and updates | Yes | Yes | Yes |
| Change the itinerary, flight schedules and accommodation | Yes | Yes | No |
| Manage invitations and members | Yes | No | No |
| Move the shared trip to Trash or restore it | Yes | No | No |
| View and edit private booking fields | Yes | No | No |
| Record personal Travel mode progress | Yes | Yes | Yes |

Leaving a trip removes the member’s access without deleting the owner’s plan. The owner cannot leave or transfer ownership in this release. Enabling collaboration is a permanent protocol change for that trip; removing every invited member does not return it to the older private-trip save protocol.

**Share a snapshot** remains a separate action. Snapshot links and downloaded HTML itineraries are fixed copies with private booking fields removed. They do not grant shared-trip membership or receive later updates.

## Simultaneous editing

The implementation uses **client-side three-way merging followed by an atomic server revision check**. It does not use whole-trip last-write-wins, character-level collaborative editing, or a server-side typed-operation engine.

Each shared draft tracks its last acknowledged trip, the local changes and the latest server trip. The client compares those three versions using stable day, activity, flight and stay IDs. Independent changes can merge. The merged document is submitted with an expected revision and a unique mutation ID. Supabase locks the trip, checks the actor’s current permission and validates the full document before committing it and incrementing the revision. A stale revision receives the current trip instead of replacing it; the client merges and retries when safe.

| Concurrent edits | Handling |
| --- | --- |
| Independent places, days or fields | Preserve both changes where the combined itinerary is valid |
| Independent additions | Preserve both using stable IDs and predictable order |
| Same field changed differently | Present the saved value and the unsaved value for review |
| Overlapping stop rearrangements | Review the relevant order instead of silently choosing one |
| Delete versus edit or incompatible cross-day moves | Preserve the draft and require review |
| Invalid flight, stay or day relationships | Keep the current shared structure and reapply the related change against it |

Conflict choices are checked against the latest trip again before saving. Some structural changes cannot safely be reapplied automatically; those require keeping the saved structure and making the intended change again. The dialog offers a draft download before resolving conflicts. Undo applies an inverse of the user’s recorded change through the same merge rules; it must not restore an old snapshot over another person’s edits.

Issued network requests remain immutable until acknowledged or rejected with a revision conflict. The database keeps mutation receipts per trip, actor and mutation ID, so a retry after a lost acknowledgement cannot duplicate a change, even after later changes have been saved. Reusing an ID with different content is rejected. Current permissions are checked before acknowledging a retry.

## Live updates and offline changes

Only the active shared trip subscribes to a private Realtime Broadcast channel. A committed change sends a minimal invalidation containing the cloud trip ID and revision; the app then fetches authorised data. Full documents and private booking fields are not broadcast. Membership changes rotate the channel generation, and the previous channel receives a final invalidation so clients refresh their access.

Focus, reconnect and a 30-second refresh provide recovery when a live notification is missed. Updates can wait while an editor is open so remote changes do not replace a form being edited. Finish or close the editor to review waiting changes. The recent-activity list records broad actions such as an itinerary update or membership change; it is not a complete restorable version history.

Shared drafts are stored in IndexedDB under the signed-in account and globally unique cloud trip ID. Offline edits are queued locally and rechecked on reconnect. Role changes or revoked access can prevent an offline draft from being uploaded; an account-scoped recovery draft remains available for download. Changing accounts does not transfer those drafts to another account. Sign-out protection includes pending collaborative edits.

This release does not provide guaranteed offline app launch, downloadable map tiles, live cursors or presence-based editing locks. Previously downloaded information cannot be recalled from another person’s device when access is revoked.

## Booking privacy and personal progress

The migration adds separate private booking storage. Enabling collaboration removes these fields from the shared document and stores them in an owner-only sidecar:

- Flight booking reference, private notes, departure gate and arrival gate.
- Accommodation booking reference, contact, booking URL and private notes.

Only the owner’s authorised response reattaches those fields. Editors cannot submit private booking fields, and deleting a booking removes its private values so reusing an ID cannot resurrect them. Shared itinerary notes, flight schedules, terminals and accommodation locations remain visible to all members. Avoid putting private booking information in shared notes.

The owner’s personal JSON backup can contain private booking fields. An editor’s or viewer’s backup contains only the shared data their account can access. Read-only snapshot links and HTML exports omit private booking fields for every role.

The public trip table retains its owner-only read policy. Membership, invitations, private booking fields and mutation receipts are stored in the private schema without browser grants. Shared access goes through narrowly scoped RPC functions that check the current authenticated actor and membership; UI controls are not the security boundary.

Travel mode check-offs are separate from itinerary revisions and keyed by the traveller. A viewer can mark their own stops done without changing the shared plan or another traveller’s progress. Existing owner progress is carried into the shared-trip progress store. Snapshots and itinerary backups do not include travel progress.

## Database setup and deployment

Collaborative planning uses these migrations, in order after the three existing trip, Travel mode and booking migrations:

```text
supabase/migrations/202610270003_daytrail_collaboration.sql
supabase/migrations/202610270004_daytrail_invitation_preview.sql
```

Both collaboration migrations have been applied to the linked Daytrail project through the migration runner. For another environment or subsequent database changes, use the configured commands; migration history prevents reapplying completed versions:

```sh
npm run db:status
npm run db:dry-run
npm run db:migrate
```

Migration `202610270003` creates globally unique cloud trip IDs, membership and invitation records, booking sidecars, mutation receipts, activity records, personal shared-trip progress and private Realtime authorisation. It blocks legacy whole-trip saves for collaboration-enabled trips, including retries from older tabs. Existing private trips continue using the previous protocol. Migration `202610270004` adds the authorised invitation-preview function without changing membership. No trip is shared merely by applying either migration.

Use the existing Supabase URL and publishable browser key. No additional browser secret, database password or service-role key is required. CLI login and project linking are a separate administrative setup described in [Database migrations](DATABASE_MIGRATIONS.md). Deploy the database change before the application build; do not run remote migrations inside the Vercel build command.

Invitation links use the current app origin. `localhost` refers to each visitor’s own device, so links generated by the local development server cannot be used to invite friends remotely. Friends on separate devices need the deployed HTTPS address, with its Google/Supabase OAuth return URL and Maps origin configured as described in [Google sign-in setup](GOOGLE_SIGN_IN_SETUP.md). No invitation email service is required.

## Verification

The focused client and presentation suites run without contacting Supabase:

```sh
node src/collaboration/collaboration.test.mjs
node src/components/Collaboration.test.mjs
```

Run the application checks and production build:

```sh
npm test
npm run build
```

Database checks use the existing isolated PGlite runner; they never read project credentials or connect to the live database. Install the test-only PGlite dependency in a temporary location or supply its module path:

```sh
DAYTRAIL_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node supabase/tests/run.mjs
```

The collaboration SQL suite covers owner/editor/viewer permissions, private-field projection, stale writes, exact replay, changed-payload replay rejection, revoked/downgraded retries, email-bound invitations, cancellation and expiry, private Realtime policies, distinct owners with the same legacy trip ID, booking-secret nonresurrection and personal progress isolation.

Roles, privacy and concurrent-update behaviour have been exercised by automated controller, presentation and isolated database tests. A complete browser flow using a second real Google account has **not** been verified. In particular, these automated checks do not establish that two real signed-in browsers have accepted an invitation and exchanged live edits end to end.

Browser release checks should use separate owner, editor and viewer sessions. Verify invitation acceptance and wrong-account recovery; same-field and reorder conflicts; independent edits surviving; offline reconnect; role downgrade while editing; viewer Travel mode progress; private-field omission in fetched responses and snapshots; owner Trash/restore; keyboard navigation; and narrow mobile layouts. Mocked controller, render and SQL checks do not replace this multi-session browser verification.

Current server limits include 100 members and 100 active pending invitations per trip, plus the existing document and account quotas. Activity is bounded to the latest 100 events. The existing trip-day, booking and backup limits continue to apply. There is no ownership transfer, invitation email delivery, per-field permission model, group-wide Travel mode progress or historical version restore in this release.
