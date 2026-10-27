# Google sign-in setup

This milestone adds optional Google sign-in through hosted Supabase Auth. Trips remain in this browser; signing in does not upload them or enable cross-device sync. These instructions prepare local testing and a later Vercel deployment. No cloud project or deployment is created by adding the configuration files.

## 1. Prepare Supabase Auth

Create or choose the Supabase project intended for Daytrail. From its project connection/API settings, copy the **Project URL** and **publishable key** into the untracked `.env.local` file:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

The publishable key is intended for browser code. Do not use a secret key or legacy `service_role` key. Vite exposes every `VITE_` variable in the built app. No trip tables, storage buckets, or database migrations are needed for this auth-only stage. [Supabase API key documentation](https://supabase.com/docs/guides/getting-started/api-keys)

In **Authentication → URL Configuration**, set:

| Setting | Local value |
| --- | --- |
| Site URL | `http://localhost:5182` |
| Redirect URLs | `http://localhost:5182/?auth=callback` |

The app passes the callback explicitly; the Site URL is Supabase's fallback. Use exact production callbacks when adding a deployed origin, rather than a broad wildcard. [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls)

In Authentication's sign-in/provider settings, enable **Google**, disable **Email**, **Phone**, **anonymous sign-ins**, and any other unused providers. Keep **Allow new users to sign up** enabled so a new Google user can create an account. Guest planning does not require a Supabase anonymous account. Turning off general sign-ups would also block first-time Google users. [Supabase general configuration](https://supabase.com/docs/guides/auth/general-configuration)

## 2. Configure Google

Use the existing Google Cloud project for Daytrail. Its Maps browser key and map ID stay separate from OAuth credentials.

1. Open **Google Auth Platform → Branding**. Enter Daytrail, a real support email, and developer contact details. Use reachable homepage, privacy, and terms URLs when preparing the public app. [Google branding settings](https://support.google.com/cloud/answer/15549049)
2. Under **Audience**, choose **External** unless access is intentionally limited to your Google Workspace organization. Start with **Testing** and record your intended test accounts.
3. Under **Data Access**, use only `openid`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/userinfo.profile` (the `email` and `profile` OpenID Connect scopes). Daytrail does not need Gmail, Drive, Calendar, or Maps OAuth scopes.
4. Under **Clients**, create a **Web application** OAuth client named for Daytrail development. Add `http://localhost:5182` as an **Authorized JavaScript origin**. An origin has no path, query string, or wildcard. [Google OAuth client settings](https://support.google.com/cloud/answer/15549257)
5. Copy the callback shown in Supabase's Google provider settings into Google's **Authorized redirect URIs**. For a hosted Supabase project it normally has this form:

   ```text
   https://your-project-ref.supabase.co/auth/v1/callback
   ```

6. Save the Google client ID and client secret in **Supabase Authentication → Google provider** and enable that provider. The client secret stays there; it is not a Daytrail frontend environment variable.

This follows [Supabase's Google provider setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google). The two redirects have different jobs:

| Redirect | Where to register it |
| --- | --- |
| Google → Supabase: `https://your-project-ref.supabase.co/auth/v1/callback` | Google OAuth client's Authorized redirect URIs |
| Supabase → Daytrail: `http://localhost:5182/?auth=callback` | Supabase Authentication Redirect URLs |

Google's usual Testing restrictions have an exception for sign-in requests limited to basic identity scopes. Do not assume every test user must be allowlisted or every authorization expires after seven days. Before public launch, review the Audience publishing status and any branding/domain verification Google requests. Basic scopes do not guarantee that all branding or organization checks are waived. [Google's audience and publishing rules](https://support.google.com/cloud/answer/15549945)

## 3. Run and check locally

Use the Node and pnpm versions declared in `package.json`, install dependencies, then run:

```sh
pnpm dev
```

Open **http://localhost:5182**. Restart Vite after editing `.env.local`. Keep this exact host and port throughout sign-in; `127.0.0.1`, `localhost`, and different ports are different browser origins. If the port is busy, stop the other server instead of silently moving to a new port.

The existing Google Maps browser-key restrictions must also allow `http://localhost:5182/*`. This is separate from Google OAuth's authorized origin setting.

Check the following with a real test account:

- Google sign-in returns to Daytrail and displays the account; reload retains the session.
- Canceling Google consent returns a recoverable state and retains existing local trips.
- Sign-out returns to guest mode and leaves the local trip library intact.
- A second Google account sees the same browser-local plans; this milestone does not isolate trips by account.
- A fresh browser profile can sign in but does not acquire trips from the first browser.
- **Back up / import trips** downloads JSON that can restore editable trip copies in another browser. Do not use the read-only HTML itinerary as an import file.

The app uses PKCE. Complete sign-in in the same browser context where it started; copying a callback URL to another browser can lose the verifier needed to finish the exchange. [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

## 4. Prepare Vercel when ready to deploy

Create the Vercel project only when deployment is wanted. Use these build settings:

| Setting | Value |
| --- | --- |
| Root Directory | The directory containing this `package.json`; `daytrail` if importing its parent repository, otherwise the repository root |
| Framework Preset | Vite |
| Node.js Version | `22.x`, matching the repository's declared runtime |
| Build Command | `pnpm build` |
| Output Directory | `dist` |
| Install Command | Leave automatic; enable Corepack as below |

Vercel supports Node 22 and pnpm 11. Add `ENABLE_EXPERIMENTAL_COREPACK=1` to make it use the version pinned in `package.json`. Keep the committed pnpm lockfile. Confirm the actual Node and pnpm versions in the first build log; do not replace this with an unpinned `pnpm install` override, which can select a different bundled version. [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [package manager selection](https://vercel.com/docs/package-managers), and [Corepack configuration](https://vercel.com/docs/builds/configure-a-build#corepack)

Add these **Production** environment variables, copying values from `.env.local` without committing the file:

- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_GOOGLE_MAPS_MAP_ID`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `ENABLE_EXPERIMENTAL_COREPACK=1`

For Preview deployments, configure variables only for the environments you intend to test, and allow their exact origins/callbacks. Avoid allowing every unrelated Vercel preview domain. Vite embeds these values at build time, so a changed value needs a new build.

Once the real production origin is known, for example `https://YOUR-DAYTRAIL-DOMAIN`:

1. Set Supabase **Site URL** to that origin and add `https://YOUR-DAYTRAIL-DOMAIN/?auth=callback` to its **Redirect URLs**.
2. Add that origin to the Google OAuth client's **Authorized JavaScript origins**. Its authorized redirect remains the Supabase callback. For a separate production OAuth client, put that client's ID/secret in the production Supabase provider configuration.
3. Add `https://YOUR-DAYTRAIL-DOMAIN/*` to the Maps browser key's website restrictions.
4. Make the actual `/privacy.html` and `/terms.html` URLs publicly reachable, review the notice for the deployed service, and use these real URLs in Google's branding configuration.
5. Check Google Audience/verification settings for the intended users and repeat the real-account sign-in check on the deployed origin.

The callback uses the root path plus a query string, so it does not require an SPA catch-all rewrite. `vercel.json` preserves static privacy/terms pages and assets. If pathname-based routes are introduced later, add and test the appropriate [Vite SPA rewrite](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas).

## 5. Keep existing trips when changing origins

Google sign-in does not move data from the current ChatGPT-hosted prototype to Vercel or localhost. Use **Back up / import trips** on an origin running the new backup-enabled build, import its JSON on the destination, and verify dates, activities, bookings, notes, and custom places before retiring the original copy.

An older hosted build may only offer a snapshot link and an HTML download. Keep that original browser data until an editable transfer is available. Its HTML download remains useful for reading and printing, but is not a JSON backup. The auth session and provider-fetched details are excluded from backups.

## Troubleshooting

If dependency installation fails with `ERR_PNPM_META_FETCH_FAIL`, Google provider settings will not fix it: the package manager first needs access to its configured registry. This repository does not override the machine's registry. Use your organization's approved registry/network when one is configured; Vercel can use its default public npm registry. To check direct public registry access without printing environment variables or credentials:

```sh
node -e "fetch('https://registry.npmjs.org/@supabase%2Fsupabase-js').then(r=>console.log('Registry HTTP',r.status)).catch(e=>console.error('Registry error:',e.cause?.code||e.message))"
```

An HTTP 200 means Node can reach the package metadata. A failure only against public npm does not imply your approved internal registry is unavailable. DNS errors such as `ENOTFOUND` need network/DNS troubleshooting; certificate errors need the network's approved certificate/proxy configuration. Keep TLS verification enabled. After connectivity is restored, run `pnpm install --no-frozen-lockfile`, `pnpm test`, and `pnpm build`. Commit the updated lockfile before deploying; a declared but uninstalled SDK is not a verified build.

| Symptom | Check |
| --- | --- |
| Sign-in is unavailable | Both Supabase browser variables must be present in the running build; restart/rebuild after changes. Guest planning remains available. |
| Google reports `redirect_uri_mismatch` | Google's authorized redirect must exactly match the callback displayed by Supabase, including project host and `/auth/v1/callback`. |
| Supabase returns to the wrong app URL | Check its Site URL and exact allowed `/?auth=callback` URL; make sure the sign-in began on that same origin. |
| Google completes, then Supabase reports `Unable to exchange external code` | The failure happened between Google and Supabase, before Daytrail received a session code. Check the latest Auth log for the underlying provider error. Confirm Supabase's Google client ID and client secret belong to the same **Web application** OAuth client, that the secret is current, and that the provider settings were saved. These are OAuth credentials, separate from the Maps key and Supabase publishable key. Keep the client secret in Supabase; never paste it into chat, Vite, or Git. |
| Callback cannot complete | Start a fresh sign-in in the same browser; do not reuse an old code or copy the callback to another browser. |
| New Google users cannot sign in | Enable Google and general sign-ups in Supabase; check Google's Audience and any organization restrictions. |
| Maps fail only on the new domain | Update the Maps browser key's website restrictions separately from OAuth. |
| Trips seem missing after a move or sign-in elsewhere | Trip storage is local to each origin/browser. Import an editable JSON backup; authentication alone cannot recover another browser's plans. |
