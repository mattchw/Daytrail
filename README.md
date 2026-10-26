# Daytrail

**Find your places. Plan your days.**

An interactive travel-planning prototype based on the supplied planning-workspace reference. It includes a trip dashboard, responsive daily timelines, linked map selections, saved Ideas, custom places, drag-and-drop rearranging, cross-day moves, fixed bookings, notes, undo, and walking/driving order suggestions.

## Run locally

Use Node.js and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm dev
```

The development server runs at `http://127.0.0.1:5182`.

```sh
pnpm test     # Planning-model checks
pnpm build    # TypeScript validation and production output in dist/
pnpm preview  # Serve the production build locally
```

## Structure

- `src/App.tsx`: workspace interactions, editing, undo, browser storage, and sharing.
- `src/model.ts`: typed trip data, Kyoto sample places, scheduling, route suggestions, and restoration validation.
- `src/model.test.mjs`: checks for fixed bookings, uncertain journeys, optimisation constraints, dates, and invalid saved data.
- `src/components/MapPanel.tsx`: interactive illustrative map, route display, and place previews.
- `src/components/TripDashboard.tsx`: trip creation, duplication, deletion, and navigation.
- `src/styles.css` and component styles: responsive desktop and mobile layouts.
- `reference/`: supplied UI reference material.

The app uses React, TypeScript, and Vite, with dnd kit for dragging and Lucide icons. The planning model is independent of the interface.

## Prototype behaviour

Trips are saved in this browser's local storage under `daytrail.workspace.v1`. There is no account, server database, or cross-device sync. Undo history lasts for the current session. Failed saves remain visible in the interface.

Discovery contains curated sample Kyoto places. Other destinations support custom locations. Map coordinates, routes, distances, and travel times are illustrative; no live maps, place-search, or transit APIs are connected. Each day starts from the sample hotel at 09:00.

Fixed bookings retain their booked times and expose arrival conflicts. Missing journey estimates keep later arrival times uncertain. Order suggestions work on walking/driving days with up to eight flexible stops, preserve booking boundaries, and reject changes that worsen individual booking conflicts.

## Sharing

The Share dialog creates a read-only snapshot encoded in the URL fragment. Later edits do not change an existing snapshot. Recipients need access to the same hosted prototype; a snapshot link does not grant access to a privately hosted site. Recipients can save an editable copy in their own browser.

The downloadable standalone HTML itinerary opens in any browser without app access or an account and can be printed. It contains the itinerary at download time. Oversized snapshots use this download option instead of a link.

Live destination search, real route calculation, accounts, collaborative editing, and expense splitting are future milestones.
