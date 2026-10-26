# Daytrail

**Find your places. Plan your days.**

An interactive travel-planning app based on the supplied planning-workspace reference. It includes Google Maps, live place discovery and journey estimates, a trip dashboard, responsive daily timelines, saved Ideas, custom places, drag-and-drop rearranging, cross-day moves, fixed bookings, notes, and undo.

## Run locally

Use Node.js and the pnpm version declared in `package.json`.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Before starting the development server, fill in the two configuration values described below. The server runs at `http://127.0.0.1:5182`.

```sh
pnpm test     # Planning, Google Maps and discovery checks
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

## Structure

- `src/App.tsx`: workspace interactions, editing, undo, browser storage, and sharing.
- `src/model.ts`: typed trip data, Kyoto sample places, scheduling, persistence filtering, and restoration validation.
- `src/model.test.mjs`: checks for fixed bookings, live and uncertain journeys, dates, persisted place data, and invalid saved data.
- `src/googleMaps.ts`: Google API loading, place search/details, route calculation, and transient request caches.
- `src/discoveryData.ts`: rich search, scoped map searches, ratings, photo handles, and separate detail requests.
- `src/openingHours.ts`: local opening status, selected-date schedules, and regular-hours fallbacks.
- `src/visitHours.ts` and `src/useVisitHours.ts`: full planned-visit checks and session-only, active-day hours loading.
- `src/components/DayPlanForm.tsx`, `AddToTripDialog.tsx`, and `TravelLeg.tsx`: day setup, choosing an insertion position, and compact transport controls.
- `src/useDiscovery.ts`: shared search, selected details, request versions, and mobile scroll state.
- `src/components/DiscoveryExplorer.tsx`: photo cards and accessible place details.
- `src/usePlaceData.ts`: fresh place-detail hydration for the active day and saved Ideas.
- `src/useLiveRoutes.ts`: departure-time conversion, sequential journey calculation, and route loading state.
- `src/components/MapPanel.tsx`: Google map, synchronized stop selection, actual route paths, and place previews.
- `src/components/TripDashboard.tsx`: trip creation, duplication, deletion, and navigation.
- `src/styles.css` and component styles: responsive desktop and mobile layouts.
- `reference/`: supplied UI reference material.

The app uses React, TypeScript, and Vite, with dnd kit for dragging and Lucide icons. The planning model is independent of the interface.

## Planning behaviour

Trips are saved in this browser's local storage under `daytrail.workspace.v1`. There is no account, server database, or cross-device sync. Undo history lasts for the current session. Failed saves remain visible in the interface.

Search Google Maps for places in the trip's destination, then add them to a day or save them to Ideas. Select a real hotel or another starting point before calculating the first and last journeys. Day plan lets each day have its own departure time, starting location, and optional same-day finish goal. Existing plans default to a 09:00 hotel departure. Return journeys still end at the trip’s stay; finish goals never shorten visits or move bookings.

The Kyoto example retains its curated descriptions. Named sample attractions resolve to map locations when their day or Idea is visible. Generic entries such as Hotel, Lunch in Arashiyama, Dinner in Pontochō, Tea ceremony, and combined neighbourhood stops require an explicit location choice. User-created custom places are never automatically matched to a business.

Fixed bookings retain their booked times and expose arrival conflicts. Missing journey estimates keep later arrival times uncertain. Changing stop order, transport mode, locations, dates, or relevant visit durations recalculates the affected journeys. Manual rearranging is supported; automatic route optimisation is deferred until it can compare real journeys while preserving booking constraints. The former sample order-suggestion control is not shown.

Open the trip title to edit the start date and destination time zone. Use an IANA time zone such as `Asia/Tokyo` or `Europe/London`; itinerary times are local to that zone. New trips ask for their destination time zone; the sample Kyoto trip uses `Asia/Tokyo`. Transit calculations use the trip date and the departure time resulting from earlier visits and journeys, including daylight-saving changes. Daytrail requests transit estimates only within 100 days ahead or 7 days in the past. Outside that window, it shows the limitation instead of substituting today's timetable. Walking and driving remain available where Google can provide a route.

## Discovery experience

Discover offers Attractions, Temples, Museums, Restaurants, and Cafés, with up to eight results per search. Cards include a lazy-loaded photo with author credits, Google rating and rating count, and local opening status when available. Place details show a larger photo, the selected trip date's hours, an expandable weekly schedule, and Save / Add actions. Missing photos, ratings, or hours remain explicit rather than being invented.

One-click Add keeps discovery open, with an inline View itinerary action that reveals the new stop. The adjacent chooser can insert at the beginning, end, or after a named stop on any day. Names for the chosen day load on demand. Opening-hours warnings also offer the same position chooser for moving an existing stop.

The search session stays in memory when switching between mobile results, place details, and the map. Back to results restores the query, filters, and scroll position. Hotel and custom-location pickers keep separate search state.

Pan or zoom the map, then choose **Search this area** to search the visible bounds. A map move alone does not issue a search. Search results have distinct unnumbered pins and never become route stops until added. Discovery keeps the current viewport steady while routes refresh. **Back to the destination** resumes destination-based search, and **Fit all stops** restores the itinerary view.

Opening status uses the place's local time. Current schedules cover the available upcoming dates; later trip dates show regular weekly hours and explain that holiday hours may differ. The itinerary checks the whole planned visit, including split schedules and overnight closing times. Warnings show when a visit is outside opening hours or has too little time before closing; regular weekly schedules are labelled provisional. Missing upstream travel keeps arrival-based checks unknown. Return-trip uncertainty does not invalidate an already-known visit. Hours never automatically move activities or change a booking. Photos, ratings, hours, and photo URLs remain session-only and are excluded from saved trips, snapshots, and exports.

Search requests use explicit field lists. Ratings and opening fields can affect the Google billing tier. Photos load only when visible, rich detail requests happen only when a place is opened, and duplicate in-flight requests are shared. Itinerary checks use a separate hours-only field list and reuse fresh discovery details when available; notes, reorderings, and timing edits do not fetch hours again. Monitor usage in the existing Google Cloud project.

## Stored place data

Trips, user notes, visit durations, transport choices, bookings, and Google place IDs are saved locally. Google-supplied place names, addresses, coordinates, links, and attribution content are not saved in the trip payload. Current details are fetched into memory for the active day, its starting point, and saved Ideas. These details and route responses use transient session caches; they are not written to local storage. A restored Google place may briefly appear as **Saved place** or **Your stay** while its current details load.

User-entered custom place data and the app's curated sample content remain part of the plan. Linking a custom place to Google preserves its user label, notes, and default visit duration separately from provider details. Removing browser storage removes saved trips. Accounts, a cloud database, and cross-device synchronisation are not implemented.

## Sharing

The Share dialog creates a read-only planning snapshot encoded in the URL fragment. Later edits do not change an existing snapshot. Google places are shared by ID; their current details and journey estimates load when the recipient opens the app. Recipients need access to the same hosted app; a snapshot link does not grant access to a privately hosted site. Recipients can save an editable copy in their own browser.

The downloadable standalone HTML itinerary opens in any browser without app access or an account and can be printed. It contains planning information at download time and links to Google places, rather than copied provider details or live journey estimates. Oversized snapshots use this download option instead of a link.

Automatic route optimisation, accounts and cloud-saved trips, collaborative editing, and expense splitting remain future milestones.
