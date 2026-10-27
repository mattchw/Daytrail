# Cloud saving

Daytrail uses the existing Google/Supabase sign-in session for private trip storage. The app works locally and as a static Vite build on Vercel. No database password or service-role key belongs in Vite configuration.

## Enable the database

1. Open the SQL Editor in the Daytrail Supabase project (`ebplrpfthmessyafjjec`).
2. Open `supabase/migrations/202610260001_daytrail_cloud.sql` from this repository. Copy the **complete file** into a new SQL query, review it, and run it. It runs in a transaction, creates the Daytrail trip table and private validators, enables owner-only reads, and exposes one guarded write function. It does not import browser trips, delete users, or change Google sign-in configuration.
3. Confirm the SQL Editor reports success. If it reports an error, retain the error and stop rather than applying fragments of the file.
4. Return to Daytrail and choose **Manage → Retry**. The account library should load. Cloud availability is detected from the database response, not assumed from successful sign-in.
5. Choose **Move device trips**, select the trips you want on this account, and confirm. A device trip is archived from the normal device library only after its cloud save is acknowledged. The original legacy localStorage document is retained for recovery.

The browser uses the already configured `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. There are no extra runtime credentials to paste into the app.

## Enable Travel mode progress

After the trip migration, run the complete `supabase/migrations/202610270001_daytrail_travel.sql` in the same project's SQL Editor. This transaction adds `daytrail_travel_marks` plus guarded list/mutation functions; it does not change trip documents or import device progress. Return to Travel mode and choose Retry if a setup error was previously shown. No additional keys or Vercel environment variables are required.

Progress is private to the authenticated owner and references an existing, non-deleted trip. The server checks target IDs and place IDs, compares revisions, and rejects stale writes. Planned resets keep their revision history. Soft-deleting a trip hides its progress; restoring the same trip exposes it again. Device progress is kept separate and does not migrate with a trip. Duplicated/new trip IDs begin with no progress.

Local draft and immutable outbox writes are transactional. Pending changes across opened trips are included in the sign-out warning. Same-target conflicts offer explicit device/saved choices, and rejected obsolete targets can be discarded without changing the itinerary. Progress contains IDs and state only, never notes, provider content or account profile fields.

## Enable Flights & stays

Run the complete `supabase/migrations/202610270002_daytrail_bookings.sql` **after both earlier migrations**. This is the third migration, extending the existing trip validator and guarded mutation functions; it does not create a separate public bookings table. Flights, accommodation, day time-zone overrides and itinerary references live in each owner's private trip document. It also enables stable `flight:<flight ID>` travel progress. Existing trip IDs, activity IDs and progress rows remain intact.

Use the same project's SQL Editor, or follow [Database migrations](DATABASE_MIGRATIONS.md) for the pinned CLI workflow. For a project whose earlier migrations were applied manually, verify and baseline its existing schema before asking the CLI to push migrations. Do not rerun earlier SQL files blindly or apply migration fragments. No additional browser environment variables or flight-provider credentials are required.

The current app reads schema versions 1 and 2 and creates new trip mutations using version 2. An immutable version 1 write already waiting in the local outbox retains its original request format and mutation ID for a safe retry. The existing `daytrail_mutate_trip` RPC still performs owner and revision checks. Once a cloud row reaches version 2, a version 1 client cannot save, delete, or restore it; this prevents older code from silently dropping booking data. Older clients can continue using version 1 rows until those rows are upgraded. Apply the database migration before rolling out the new app build to a shared deployment.

Flight/stay records save with the trip's existing transactional draft and conflict flow. Flight progress remains a separate resource and follows the stable flight ID plus arrival-place reference. Both departure and arrival day views of an overnight flight address the same progress record. Private booking references, flight gates, contact details, booking URLs and private notes remain in account documents and personal backups, but are removed from read-only snapshot/HTML exports. See [Flights & stays](FLIGHTS_AND_STAYS.md) for the user flows and verification checklist.

## Storage and sync behavior

- Signed-in users default to **Your account**. **On this device** remains a separate guest library. Merely signing in never uploads the guest library.
- IndexedDB stores canonical drafts, immutable pending writes and the last acknowledged revision atomically. Browser quota/storage failures reject the edit and preserve the preceding saved state.
- Cloud saves are per trip and serialized. The database compares revisions and derives ownership from the authenticated session; it also verifies the caller's expected account to reject an old queue after an account switch.
- Identical retries of the latest mutation return its acknowledgement. Older retries after another save return a conflict and never reapply stale content.
- Refresh runs on focus, reconnect and visible-tab checks. A browser-local lease coordinates writers; revision checks remain the final protection across devices.
- On a conflict, keep local changes as a separate trip or use the saved version. Active editors defer incoming replacements. Undo is scoped to affected trips and is invalidated by competing changes.
- Trash uses versioned tombstones. Normal saves cannot restore deleted trips. Restore is explicit; there is no automatic permanent purge.
- Up to 100 stored trips including Trash and 4 MiB of canonical document data per account. Limits are checked by the database and client. Export remains available; oversized changes are not silently truncated.
- Google Place IDs and user planning content are stored. Fetched Google names, addresses, coordinates, photos, ratings, hours, route responses and attribution payloads are excluded. User-entered custom place coordinates and labels are retained.
- Offline edits are supported for locally available trips when the application can load. Offline application launch, map tiles, search and Google place hydration are not provided by this milestone.
- Signing out clears displayed account data and synced caches. Users can explicitly keep unsynced drafts under the original account. Device-only and legacy recovery data remain browser-local. Browser storage is not encrypted by Daytrail.

## Validation

Run `pnpm test` and `pnpm build` for application regression checks. Database tests do not require live project credentials:

```sh
DAYTRAIL_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node supabase/tests/run.mjs
```

The runner creates an isolated PostgreSQL runtime, bootstraps minimal Supabase auth roles, applies all three real migrations and runs trip/progress/booking security and concurrency checks plus application-to-database fixtures. Booking checks cover version 1 compatibility, strict version 2 validation, owner isolation, old-client downgrade rejection and stable flight progress. It does not connect to Supabase. The SQL smoke files use synthetic users and roll back; use the runner rather than running test fixtures against production.

Before rollout, verify two separate accounts cannot read or mutate one another's rows, laptop/phone changes do not silently overwrite, interrupted writes recover, and expired authentication does not move drafts into a different account.

## Vercel

Use the existing Vite build command and `dist` output. Configure the two public Supabase variables separately in the intended Vercel environment, preserve Google Maps settings, and add the chosen origin and OAuth return URL to Supabase/Google restrictions as described in `GOOGLE_SIGN_IN_SETUP.md`. Apply SQL migrations deliberately to the matching Supabase project; do not run them from the browser or during each static build. The current work does not deploy to Vercel.
