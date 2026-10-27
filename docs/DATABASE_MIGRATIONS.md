# Database migrations

Daytrail now uses the pinned Supabase CLI and npm commands. SQL files stay in `supabase/migrations`; the CLI records successful versions in the database so subsequent runs skip them.

## One-time setup on this Mac

From the Daytrail project directory:

```sh
pnpm install
npm run db:login
npm run db:link
npm run db:status
npm run db:baseline
npm run db:dry-run
npm run db:migrate
```

`db:login` opens Supabase's account login. Keep credentials in the CLI's local credential store. Do not put an access token, database password or service-role key in a `VITE_*` variable, source file, browser setting or chat. The commands use the existing Daytrail project, `ebplrpfthmessyafjjec`; they refuse a checkout linked to another project. The existing Google sign-in and browser publishable key are unrelated to database administration.

`db:link` connects this checkout to that project. If the CLI requests a database password, enter it only in its terminal prompt. The current CLI can use its authenticated account for management queries and temporary database access. Docker and a local Supabase stack are not required for these remote migration commands.

## Adopting the SQL previously applied manually

The first three Daytrail migrations may already exist because they were pasted into SQL Editor. Blindly running them again would fail on existing tables or functions.

`db:baseline` reads only PostgreSQL catalog metadata—function hashes, constraints, columns, row-level security, policies and grants—and compares it with committed fixtures generated from the migration files in an isolated database. It recognizes complete states after cloud saving, Travel mode, or Flights & stays. Only an exact match permits the CLI to mark the verified migrations as applied. This updates migration history; it does not execute those SQL files or change trip data.

If the Flights & stays migration has not been applied yet, only the first two versions are baselined and the third remains pending. If the database is fresh, no baseline is needed. A partial, modified or unfamiliar schema stops for review. Never bypass that failure with a blind `migration repair` or a remote database reset.

## Every later database change

```sh
npm run db:status
npm run db:dry-run
npm run db:migrate
```

`db:migrate` checks the project and history, runs Supabase's dry run, then pushes pending SQL and verifies that none remain. It does not seed data, push role definitions, update vault secrets or reset the database. Run one deployment at a time.

Create a new migration file for each later schema change. Do not edit an already-applied migration. Keep migration deployment separate from the Vercel build: deploy the compatible database change first, then the application. Put any CI administrator credentials in protected deployment secrets, never browser environment variables.

## Verification and maintenance

```sh
npm run test:db-runner
```

This test uses committed metadata fixtures and synthetic mutations; it never contacts Supabase. The database SQL checks also run in an isolated PGlite database through `supabase/tests/run.mjs`.

The fixtures in `supabase/baselines` are only for adopting the three historical manual migrations. They include each migration's SHA-256 checksum. `scripts/db-baseline-generate.mjs` is a maintainer tool for reproducing them in an isolated PGlite instance; it does not read credentials. Future ordinary migrations need no new baseline fixture.

If a command fails, it exits without continuing to the next write. Query responses and raw connection errors are not printed. Re-run `db:status` after fixing login, network or schema-history problems. A CLI session is separate from the app's Google session.

References: [Supabase CLI installation](https://supabase.com/docs/guides/local-development/cli/getting-started), [database migration history and repair](https://supabase.com/docs/guides/deployment/database-migrations), [CLI push reference](https://supabase.com/docs/reference/cli/supabase-db-push).
