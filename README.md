# Daytrail

**Find your places. Plan your days.**

An interactive travel-planning app based on the supplied planning-workspace reference. It includes Google Maps, live place discovery and journey estimates, a whole-trip overview, a trip dashboard, responsive daily timelines, saved Ideas, custom places, flights and accommodation bookings, drag-and-drop rearranging, cross-day moves, fixed bookings, notes, route improvement, and undo. Google sign-in uses Supabase Auth; private account trips and travel progress sync to Supabase while device trips remain local.

## Run locally

Use Node.js and the pnpm version declared in `package.json`.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Before starting the development server, fill in the Google Maps configuration below. Google sign-in is optional and needs the separate Supabase setup. The server runs at `http://localhost:5182` with a fixed port for OAuth callbacks. Browser storage belongs to an origin: trips previously saved at `http://127.0.0.1:5182`, another port, or the hosted prototype do not automatically appear at this address.

```sh
pnpm test     # Planning, bookings, Maps, discovery, auth, cloud and travel checks
pnpm build    # TypeScript validation and production output in dist/
pnpm preview  # Serve the production build locally
```

## Google Maps configuration

The Google Cloud project must have billing configured and these services enabled:

- **Maps JavaScript API** for the map, markers, and JavaScript libraries.
- **Places API (New)** for destination search and current place details.
- **Routes API** for walking, driving, and public transport journeys through the Maps JavaScript Routes library.

Set these variables in the untracked `.env.local` file:

```env
VITE_GOOGLE_MAPS_API_KEY=your_restricted_browser_api_key
VITE_GOOGLE_MAPS_MAP_ID=your_javascript_map_id
```

Use a browser key restricted to the local development origin and each deployed website origin, with API restrictions for the enabled Google services. Vite includes `VITE_` values in the browser bundle; they are not server secrets. Keep server credentials out of this file and do not commit real configuration values. Restart the development server after changing configuration, and rebuild to update a deployment.

The app loads the Maps JavaScript API once and shares its Places and Routes libraries across the map, discovery, and itinerary. Failed searches and routes show retry controls. It never replaces a missing live route with an illustrative estimate.

## Google sign-in and deployment preparation

Follow [Google sign-in setup](docs/GOOGLE_SIGN_IN_SETUP.md) to configure the Google provider in Supabase Auth and the local callback. The only additional browser values are:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

Leave both values empty to keep using Daytrail as a guest. The Google OAuth client secret belongs in Supabase's Google provider settings, never in Vite, Git, or Vercel frontend environment variables. A Supabase secret key or legacy `service_role` key must never be used here. Sign-in uses PKCE and returns to `/?auth=callback` on the origin where it began.

Google sign-in supplies account identity and a persistent session. Follow [Cloud saving setup](docs/CLOUD_SAVING_SETUP.md) to apply the private trip schema. Account trips then sync to Supabase; device trips remain local until explicitly moved. Each account has a separate library, drafts and queue.

`vercel.json` prepares a Vite build with output in `dist/`. The setup guide covers the future Vercel project settings, Node/pnpm versions, environment variables, and production redirect URLs. Adding these files does not create or deploy a Vercel project.

## Structure

- `src/App.tsx`: workspace interactions, editing and sharing.
- `src/travel/` and `src/components/TravelMode.tsx`: day selection, exact directions, separate progress storage/sync and the phone travel interface.
- `src/bookings/`, `src/components/FlightsStaysPanel.tsx`, `TripBookingsBar.tsx`, `BookingDayBoundary.tsx`, `FlightCard.tsx`, and `BookingEssentials.tsx`: flight/stay records, trip-wide booking setup, day-boundary previews, time-zone resolution, private booking cards, and day reminders.
- `src/cloud/`: canonical payloads, authenticated data transport, transactional IndexedDB drafts, conflict handling and the workspace controller.
- `supabase/migrations/` and `supabase/tests/`: private revisioned trip schema and isolated PostgreSQL validation.
- `src/model.ts`: typed trip data, Kyoto sample places, scheduling, persistence filtering, and restoration validation.
- `src/model.test.mjs`: checks for fixed bookings, live and uncertain journeys, dates, persisted place data, and invalid saved data.
- `src/googleMaps.ts`: Google API loading, place search/details, route calculation, and transient request caches.
- `src/discoveryData.ts`: rich search, scoped map searches, ratings, photo handles, and separate detail requests.
- `src/openingHours.ts`: local opening status, selected-date schedules, and regular-hours fallbacks.
- `src/visitHours.ts` and `src/useVisitHours.ts`: full planned-visit checks and session-only, active-day hours loading.
- `src/components/DayEndpointPicker.tsx`, `AddToTripDialog.tsx`, and `TravelLeg.tsx`: scoped start/end selection and timing, choosing an insertion position, and compact transport controls.
- `src/useDiscovery.ts`: shared search, selected details, request versions, and mobile scroll state.
- `src/components/DiscoveryExplorer.tsx`: photo cards and accessible place details.
- `src/usePlaceData.ts`: fresh place-detail hydration for the active day or whole trip and saved Ideas.
- `src/useTripOverview.ts`: bounded whole-trip journey and visit-hours summaries with session-only reuse.
- `src/components/TripOverview.tsx` and `AddDaysForm.tsx`: all-day planning, cross-day moves, Ideas placement, and extending trips.
- `src/useLiveRoutes.ts`: departure-time conversion, sequential journey calculation, and route loading state.
- `src/components/MapPanel.tsx`: Google map, synchronized stop selection, actual route paths, and place previews.
- `src/components/TripDashboard.tsx`: trip creation, duplication, deletion, and navigation.
- `src/improveDay.ts`, `src/improveRoutes.ts`, and `src/useImproveDay.ts`: constrained order search, real-route verification, and comparison lifecycle.
- `src/auth/` and `src/useAuth.tsx`: optional Supabase Google sign-in, PKCE callback handling, and account state.
- `src/tripBackup.ts` and `src/components/TripBackupDialog.tsx`: filtered JSON backups, validated imports, and duplicate handling.
- `src/styles.css` and component styles: responsive desktop and mobile layouts.
- `reference/`: supplied UI reference material.

The app uses React, TypeScript, and Vite, with dnd kit for dragging and Lucide icons. The planning model is independent of the interface.

## Planning behaviour

Trip drafts and pending mutations are saved transactionally in IndexedDB. The original `daytrail.workspace.v1` localStorage data is retained as a recovery copy after migration. Account trips save through a revision-checked Supabase RPC; guest trips remain device-only. Undo is scoped to affected trips, lasts for the current session, and refuses competing changes. Saving, offline, authentication, conflict and setup failures stay visible. See [Cloud saving setup](docs/CLOUD_SAVING_SETUP.md) for migration and sync behavior.

Whole trip brings every day together with its stops, visit time, real journey estimates, return time, and scheduling issues. Drag stops or saved Ideas onto a day, or use their Move / Add controls to choose a precise position. Open day returns to the detailed planner. Missing journeys remain explicit; the overview does not use illustrative travel estimates.

Add days is available in both the overview and the day tabs. Add one or more empty days, up to 30 total; the trip end date and day labels update across month and year boundaries. Existing plans stay intact, and Undo reverses an extension. New trips and shared snapshots open in the overview.

Search Google Maps for places in the trip's destination, then add them to a day or save them to Ideas. Select a real hotel or another starting point before calculating the first and last journeys. Each day’s **Start from** and **End at** rows open a picker with its location and start or optional finish time. Existing plans default to a 09:00 hotel departure. The last journey ends at the day's chosen endpoint; finish goals never shorten visits or move bookings.

The Kyoto example retains its curated descriptions. Named sample attractions resolve to map locations when their day or Idea is visible. Generic entries such as Hotel, Lunch in Arashiyama, Dinner in Pontochō, Tea ceremony, and combined neighbourhood stops require an explicit location choice. User-created custom places are never automatically matched to a business.

Fixed bookings retain their booked times and expose arrival conflicts. Missing journey estimates keep later arrival times uncertain. Changing stop order, transport mode, locations, dates, or relevant visit durations recalculates the affected journeys.

**Improve this day** compares real, directed journey times for up to eight stops, using walking for every leg or driving for every leg, including the return. Bookings retain their positions and times; temporary position locks can protect other stops for a comparison. Candidates preserve all activities, visit durations, notes, departure settings, and return location. They must save at least five minutes of travel, avoid late bookings and known opening-hours conflicts, and return no later than the current order. Missing hours remain explicit and regular schedules are provisional. The current and suggested orders can be reviewed on the timeline and map before applying; Apply is one undoable edit. The comparison also respects a booked departure airport deadline. Ground days with arrival/departure endpoints are supported; mixed modes, public transport and days containing linked flight legs are not supported yet. The optimiser uses constraints and route data, not generative AI.

Choose **Change** beside **Start from** or **End at** to edit that endpoint only. The picker offers matching booked airports and stays, followed by **Search another place**. Starts use an arrival airport or the previous night’s stay; ends use a departure airport or the stay covering that night. Set a start time or optional finish time there for a stay/custom location; a selected flight uses its booking time and buffer. The day time zone is also available. Other days, the opposite endpoint and existing stops stay intact. There is no separate Day plan dialog or duplicate daily booking block. Direct transfers still work without activities, and endpoints remain part of routes, maps, overview, improvement, snapshots and backups.

Open the trip title to edit the start date and destination time zone. Use an IANA time zone such as `Asia/Tokyo` or `Europe/London`; itinerary times are local to that zone. New trips ask for their destination time zone; the sample Kyoto trip uses `Asia/Tokyo`. Transit calculations use the trip date and the departure time resulting from earlier visits and journeys, including daylight-saving changes. Daytrail requests transit estimates only within 100 days ahead or 7 days in the past. Outside that window, it shows the limitation instead of substituting today's timetable. Walking and driving remain available where Google can provide a route.

## Today mode

Open **Today** on mobile or **Today view** on desktop, including individual whole-trip day cards. The dark Now card shows the confirmed current stop, a leave countdown, and the next journey. **Start my day**, **Leaving now**, **I’ve arrived**, and **Stay 15 min longer** record actual timing; the clock never completes a stop. Today replaces the old Travel mode entry point. Today, Map and Bookings tabs keep the planner close by.

The remaining day recalculates from the current time and explicit progress, preserving fixed booking times, flight schedules and airport buffers. Early arrivals wait for opening. Unknown journeys remain unknown, and times crossing midnight include the day offset. Future/past days are read-only previews of live timing. A midnight prompt offers the new day without discarding the active visit.

**Fix it** previews leaving now, shortening a flexible future visit, saving a stop to Ideas, and switching to a faster verified driving route. Each option shows the resulting booking margin, hours conflict or remaining uncertainty. Applying a plan change uses normal itinerary Undo; leave/arrive/stay actions have their own progress Undo. Pinned bookings and flights are never silently moved or shortened. Changed plans or progress invalidate old proposals.

Ground directions open Google Maps with an exact Place ID or coordinates. Google Maps supplies the starting position; the app does not track GPS. Live route estimates use the confirmed last location and actual departure time, including sequential updates for later transit legs. Missing locations offer a planner link. Bookings shows saved references, notes and addresses for drivers; it does not invent addresses, translations or live flight updates.

A linked flight retains a separate **Mark landed** action and both airports’ local times. Actual landing includes the configured arrival buffer. Overnight views share the same flight completion ID. Private references and notes retain existing owner/access protections.

Completion marks use the existing separate progress storage and Supabase synchronization. Precise Today arrival/leave timestamps remain on this device, isolated by account, library, trip and day; they are not shared with collaborators or included in itinerary backups. The UI states this distinction. No new credentials are required. Use `npm run db:migrate` to apply pending migrations, including `202610270005_daytrail_admission.sql` for confirmed last-entry metadata.

Progress follows the itinerary target and place ID. Replacing a stop's place ID resets its displayed progress; editing the same place's name, coordinates, notes or timing preserves it. Reordering or moving the same activity preserves progress. Conflicting changes to the same stop require an explicit choice. Unsynced progress is included in sign-out protection and stays with its original account. Shared snapshots and itinerary backups exclude travel progress.

Production builds support deliberate offline app preparation; see **Pacing, weather and offline access** below. Maps, fresh place searches and new route estimates still need a connection.

## Pacing, weather and offline access

The day header keeps weather, walking, meal timing and **Pace** together; day tabs remain compact without weather. Pace defaults to Relaxed (8 km), with Moderate (12 km) and Active (16 km). A trip default lives in trip settings; choosing a day pace overrides it for that day. Walking counts numeric walking-route distances, known transit walking steps and explicitly labelled estimates inside attractions. Missing measurements remain unknown. Expand a stop’s **Meals, walking & weather** section to confirm meal/snack status, walking distance or indoor/outdoor setting.

Meal reminders require a gap of at least four hours that covers all of lunch (11:30–13:30) or dinner (18:30–20:30), in the relevant local time zone. A snack does not count as a meal. Meal insertion and driving previews are bounded, explicit checks against current routes, hours, fixed bookings, airport buffers, finish goals and walking limits. Unknown routes or unconfirmed restaurant hours prevent a verified proposal. Changes use ordinary itinerary Undo. Reminders can be dismissed per device/account/day and restored in trip settings; small unrelated edits do not bring them back.

Weather uses Open-Meteo hourly forecasts for the next ten days, near the stops’ coarse forecast areas, with visible attribution and checked time. Past/out-of-range, stale, offline and unavailable states are distinct. Outdoor or mixed visits overlapping rain probability of at least 50% get advice. A proposed move checks both days and requires known dry coverage at the new time. **Indoor ideas** filters discovery conservatively; unconfirmed places are not labelled indoor. Today shows weather for remaining visits. The free Open-Meteo endpoint is suitable for the current non-commercial prototype; review its commercial licence/limits before a commercial launch.

On mobile, **Offline** replaces Share in the header. Share remains in the offline sheet and on desktop. Desktop offline access is in trip settings and Today. **Save for offline** prepares the production app assets and verifies that the trip is already durably saved in its canonical IndexedDB workspace. Preparation stores a readiness record, not a second editable trip; later durable edits update it while the app is open. The sheet reports real stored bytes and missing details. Independently entered names, venue hours and bilingual addresses remain available with booking references and notes. Google provider responses, photos and map tiles are never cached by the service worker. Offline displays a stop-order list and saved Ideas rather than a downloaded street map.

Today timestamps and completion changes commit in one IndexedDB transaction. Storage failure rolls both back; account switching, conflicts and stale callbacks cannot silently overwrite another workspace. Pending trip/progress units remain queued for their own account. Reconnect sync uses the existing revision and conflict handling, and the success receipt appears only after an acknowledged upload and no outstanding conflicts. Queue counts are pending updates, not a count of individual keystrokes. Offline prepared account access does not grant remote access until the session is verified again.

Run `npm run build` then `npm run preview` to test real offline launch (stop the dev server first if it uses port 5182). The Vite development server intentionally does not install a service worker. Production uses HTTPS, or localhost for testing. After preparing a trip, reload it without network access. Storage eviction remains possible; the backup flow is available in the sheet. Wi-Fi-only background downloads, street-map packages and prototype clock/connection switches are not part of this milestone.

Migration `202610270006_daytrail_pacing.sql` adds validated optional metadata without changing the itinerary wire version. Use `npm run db:migrate`; no manual SQL step is required once the project is linked. `npm test` includes pacing safety, rain moves, offline shell/startup, readiness races, receipt acknowledgement and atomic Today persistence regressions.

## Flights and accommodation

The trip’s **Bookings** bar is the planner’s single booking entry point. It shows **Arrival flight → Stays → Departure flight** and night coverage. **Collapse** leaves a compact count of flights, stays and covered/missing nights; **Expand** restores the cards. This view setting is local UI state. On a phone, cards scroll sideways and the toggle stays visible. Open a saved card, use a dashed add button, or choose **Manage all flights and stays** in the bar. Missing nights offer **Add stay** with that night’s dates; overlaps and multiple matching flights offer a choice.

The flight form keeps airports, dates and local times visible, with airline, terminals, buffers and private details available on demand. Copy the details from the airline booking and confirm each airport's displayed time zone. Unknown times remain **To confirm**; overnight flights show their day difference, and repeated daylight-saving hours require an offset choice. **How this shapes your day** previews landing plus the arrival buffer or departure minus the airport buffer. Keep the day-application option checked for **Save & update day**, or uncheck it to save the booking only. Airport transfers use public transport, driving/taxi or walking; Maps calculates the ground journey after locations are mapped. **Not flying?** opens the first day’s start picker or last day’s end picker.

Applying an arrival sets the day's airport start, ready time and local time zone. Applying a departure sets its airport end and finish goal. Existing stops stay in the plan, and **Add a stop** stays easy to reach. The deadline appears in the timeline and constrains **Improve this day**; missing transfer estimates remain uncertain. An outside transfer date requires explicit trip extension, within the 30-day limit. The origin departure or return arrival on another date does not force the holiday to include it. Bookings are trip records, not automatically added activities.

For airport-to-airport travel during the trip, the existing **Flight** transport selector and **Add to departure day** flow remain available. Their preview explains the added airport stops, and each segment links only to its departure date. Unlinking/deleting a linked flight retains its airport stops. Optional connecting-journey groups show elapsed layovers and flag airport changes. A flight already setting a day boundary displays **Sets day start/end** instead of the redundant link action.

For a stay, choose the property and covered nights, then review **Use this stay for day start and end points**. **Save & update days** applies eligible endpoints in one transaction while preserving chosen airports and custom overrides. Check-out is exclusive for occupied nights; a hotel change can supply different start and end properties. Suggested 15:00 check-in and 11:00 checkout times are editable and must be confirmed against the booking. The timeline displays reminders without automatically adding waiting time. Optional **Add bag-drop stop** and **Add bag-collection stop** actions create editable 15-minute visits; they do not confirm that luggage storage is available.

The bookings bar, collapse state and scoped endpoint pickers use the existing version 2 booking/day fields or UI-only state, so this update needs no new database migration. Initial cloud setup still requires `supabase/migrations/202610270002_daytrail_bookings.sql` after the trip/travel migrations; use `npm run db:migrate` to apply pending migrations. Existing IDs, revision checks, private booking protection, backups and collaboration behaviour remain in place. Read-only snapshot links and HTML itineraries omit booking references, flight gates, contacts, booking URLs and private notes.

Flight schedules are entered manually; there is no flight-number lookup, matched-flight search or live airline status. No new flight API key is needed. Google Maps continues to provide actual ground routes, with any flight connection drawn illustratively. See [Flights & stays behavior and verification](docs/FLIGHTS_AND_STAYS.md) and [Cloud saving setup](docs/CLOUD_SAVING_SETUP.md).

## Discovery experience

With no mapped stops, the map opens around the trip destination using Google’s suggested city or region viewport. Once places are added, the itinerary takes priority. Panning or zooming keeps your chosen view; **Show destination** returns to the destination when the day is empty. Destination lookup results stay in memory and are never saved in trip data.

Discover offers Attractions, Temples, Museums, Restaurants, and Cafés, with up to eight results per search. Cards include a lazy-loaded photo with author credits, Google rating and rating count, and opening hours for the selected trip weekday when available. Place details show a larger photo, the selected trip date's hours, an expandable weekly schedule, and Save / Add actions. Missing photos, ratings, or hours remain explicit rather than being invented.

One-click Add keeps discovery open, with an inline View itinerary action that reveals the new stop. The adjacent chooser can insert at the beginning, end, or after a named stop on any day. Names for the chosen day load on demand. A red opening-hours warning offers the nearest verified reorder, or a move to another day that is open, with Undo. Candidates use real routes, retain bookings and airport deadlines, and cannot worsen other known constraints. Searches are bounded; if no safe change is verified, the manual move and timing controls remain available.

The search session stays in memory when switching between mobile results, place details, and the map. Back to results restores the query, filters, and scroll position. Hotel and custom-location pickers keep separate search state.

Pan or zoom the map, then choose **Search this area** to search the visible bounds. A map move alone does not issue a search. Search results have distinct unnumbered pins and never become route stops until added. Discovery keeps the current viewport steady while routes refresh. **Back to the destination** resumes destination-based search, and **Fit all stops** restores the itinerary view.

Opening status uses the place's local time. Current schedules cover the available upcoming dates; later trip dates show regular weekly hours and explain that holiday hours may differ. The itinerary checks the whole planned visit, including split schedules and overnight closing times. Warnings show when a visit is outside opening hours or has too little time before closing; regular weekly schedules are labelled provisional. Missing upstream travel keeps arrival-based checks unknown. Return-trip uncertainty does not invalidate an already-known visit. A flexible visit arriving before opening adds waiting time; fixed bookings stay fixed. Closed days and confirmed last-entry conflicts are red, shortened visits are amber, and unknown hours are never treated as open 24 hours. Each stop editor can save a traveller-confirmed last-entry cutoff for that weekday. This user-entered metadata saves with trips and backups; provider photos, ratings, hours and photo URLs remain session-only. Hours never automatically reorder activities or change a booking.

Search requests use explicit field lists. Ratings and opening fields can affect the Google billing tier. Photos load only when visible, rich detail requests happen only when a place is opened, and duplicate in-flight requests are shared. Itinerary checks use a separate hours-only field list and reuse fresh discovery details when available; notes, reorderings, and timing edits do not fetch hours again. Monitor usage in the existing Google Cloud project.

## Stored place data

Trips, user notes, visit durations, transport choices, bookings, and Google place IDs are saved locally. Google-supplied place names, addresses, coordinates, links, and attribution content are not saved in the trip payload. Current details are fetched into memory for the active day, its starting and ending points, and saved Ideas, or all planned places while the overview is visible. Whole-trip hydration uses up to four concurrent place requests; journey summaries load at most two days at a time. These details and route responses use transient session caches; they are not written to local storage. A restored Google place may briefly appear as **Saved place** or **Your stay** while its current details load.

User-entered custom place data and the app's curated sample content remain part of the plan. Linking a custom place to Google preserves its user label, notes, and default visit duration separately from provider details. Removing browser storage removes saved trips. Google sign-in does not recover deleted local plans.

## Local backup and import

Open **Back up / import trips** from the account controls to download an editable JSON backup or import one. Backups contain local planning data and Google place IDs; authentication sessions and fetched Google place details are excluded. Keep the file private if it contains personal notes. Import validates files up to 4 MB and 100 trips before adding plans, keeps existing trips, and skips already-present or previously imported copies. It does not upload the file to Supabase.

Use a backup before changing domains, browser profiles, or devices, and check the imported plans before deleting the original copies. Older builds may only offer a standalone HTML itinerary or read-only snapshot. The HTML file is for reading and printing and cannot be imported as an editable JSON backup. Existing browser data is not transferred simply by deploying the app to another host.

## Sharing

Live viewer/editor access, invitations, concurrent editing and setup are described in [Collaborative planning](docs/COLLABORATION.md). Invitation recipients review the trip, owner and assigned role before accepting with the invited Google account. The collaboration and invitation-preview migrations (`202610270003` and `202610270004`) have been applied through the migration runner.

The Share dialog also offers a read-only planning snapshot encoded in the URL fragment. Later edits do not change an existing snapshot. Google places are shared by ID; their current details and journey estimates load when the recipient opens the app. Recipients need access to the same hosted app; a snapshot link does not grant access to a privately hosted site. Recipients can save an editable copy in their own browser.

The downloadable standalone HTML itinerary opens in any browser without app access or an account and can be printed. It contains planning information at download time, public flight/stay details, and links to Google places, rather than copied provider details or live journey estimates. Booking references, flight gates, contact details, booking websites and private booking notes are excluded from both sharing formats. The owner's personal JSON backup can keep these fields; editors and viewers receive only shared data. Oversized snapshots use this download option instead of a link.

Expense tracking and bill splitting remain future milestones. Today mode and collaborative planning are available locally; `localhost` invitation links cannot be used remotely, so deployed HTTPS hosting is needed for friends on other devices. Role and concurrency behaviour is covered by automated tests; a complete browser flow with a second real Google account remains unverified.
