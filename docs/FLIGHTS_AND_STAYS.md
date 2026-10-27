# Flights & stays

Flight and accommodation records belong to the whole trip. The **Bookings** bar under the header is the planner’s single booking entry point: **Arrival flight → Stays → Departure flight**, with covered nights, gaps and overlaps. It starts expanded; **Collapse** keeps flight/stay counts and night coverage visible, and **Expand** brings back the cards. The collapse setting is UI state only. On a phone, the cards scroll sideways while the toggle stays visible. Open a card to edit it, use a dashed add button, or choose **Manage all flights and stays** in the bar. Multiple matching flights open the list for a choice.

Booking forms preview their effect on the day. **Save & update day(s)** saves the booking and the accepted endpoint changes together. When adding a booking, uncheck the application option to save only the booking. Flight and stay records do not become ordinary activities, and existing stops are not moved to Ideas automatically. Small **+** controls on the timeline let people add stops between journeys.

## Choosing a day’s start and end

Use **Change** on the timeline’s **Start from** or **End at** row. Each opens a picker for that endpoint only, with matching booked airports and stays first: an arrival airport or the previous night’s stay for the start; a departure airport or that night’s stay for the end. **Search another place** supports a station, port or any other location.

For a stay or another place, set the **Start time** or optional **Prefer to finish by** time in the same picker. A selected flight uses its booking time and buffer; edit those in Bookings. Save changes only the chosen day and endpoint, keeping stops and the other endpoint intact. The day time-zone control is available there too. The former **Day plan** dialog and duplicate daily **Flights & stays** block have been removed; the timeline retains useful booking reminders and warnings.

## Arrival and departure flights

1. Choose **Add arrival flight** or **Add departure flight** in the bar. The flight form also offers **Arriving**, **Heading home** and **Another flight**. Existing booking chips open the saved record rather than creating a duplicate.
2. Enter the optional flight number, then choose exact departure and arrival airports through place search or a custom location. Copy both local dates and times from the booking. Each airport's time zone is visible beside **Change time zone**; confirm the zones, especially for international travel.
3. Review the duration and any **+1 day** arrival label. Unknown times can stay blank. Repeated daylight-saving hours require the booking's UTC offset; nonexistent local times must be corrected. **Airport time & extra details** contains buffers, airline, terminals and connecting-journey grouping. Gates, references and notes are in the owner's private section.
4. Review **How this shapes your day**, choose an airport transfer mode, and save. Applying an arrival sets that day's start airport, local time and time zone to landing plus the arrival buffer. Applying a departure sets the end airport and the finish goal to departure minus the airport buffer. Stops retain their identities, notes and durations.

The default allowances are 60 minutes after landing and 120 minutes before departure; travellers can adjust both. Actual ground transfer time comes from the day planner's route calculation, not from the flight number. The preview does not invent a hotel departure time or promise spare time while journeys are unknown. A conflicting day start/finish goal or an existing linked flight journey must be reviewed before applying the booking. **Not flying? Choose a start or end place** opens the first day’s start picker or the last day’s end picker for a station, port or another location.

If the relevant airport-transfer date is outside the trip, explicitly select **Include [date] in my trip** before applying it. Only the needed arrival-ready or airport-goal date is added; the origin flight can depart before the holiday, and the return flight can land after it. The other airport's date does not force an extension when the booking already sets an in-trip boundary. Existing day and activity IDs are retained, within the 30-day trip limit. **Save booking only** remains available without extending the trip.

The day timeline shows landing/buffer information or the airport arrival deadline. A known late plan shows a flight-conflict warning; incomplete transfer estimates remain explicit and do not produce a reassuring spare-time claim. **Improve this day** respects the airport deadline, including when a manual finish goal is later. It never moves stops automatically. Ground days with an arrival/departure boundary can use the existing walking/driving comparison; days with a linked flight leg are still excluded.

## Flights within an itinerary

The existing **Flight** transport option remains available for an airport-to-airport journey during a trip. Choose it in a transport selector to create or link a booking, or choose **Add another flight or connection** and then **Add to departure day**. The placement preview explains which airport stops will be added. A booking already used as an arrival/departure boundary shows **Sets day start** or **Sets day end**, without the redundant departure-day action.

The transport picker preserves the chosen day start/end, hotel links, manual start time and existing stops. It adds any required airport legs around that journey. Switching back to walking, transit or driving retains the saved flight booking, removes only generated zero-minute landing and unchanged check-in markers, and applies the chosen ground mode to the next actual stop or day end. Real airport visits retain their duration and notes. The picker checks the selected journey's endpoints, mode and flight link again on save; a changed or deleted journey must be selected again instead of overwriting newer edits.

The explicit **Add to departure day** flow can set up an empty airport-only day using the departure and arrival airports as its start/end. A flight before another activity adds airport transfers while retaining that activity's identity, notes, booking time and visit duration. Existing matching airport stops can be reused. The flight has one itinerary link, even when its arrival card also appears on the following day. Unlink before changing the linked flight's airports or departure date; airport stops remain in the plan after the separate unlink/delete actions.

When a day starts at the departure airport with a linked flight, one vertical card groups the starting airport, flight details and arrival airport. The day’s start time stays distinct from scheduled departure; local dates, time zones, arrival-day changes and the post-landing buffer remain visible. Start/end changes, flight editing and the transport selector stay available where applicable. The small **+** below the card inserts a visit after landing while preserving the linked flight. Ground journeys and flights later in the day keep their usual timeline presentation.

Each eligible transition has a compact **+** with a 44-pixel tap target. Select it to search for a place, choose a saved Idea or add a custom place at that position. Drag an Idea or an existing stop onto the highlighted transition to insert it there. Keyboard users can pick up a drag handle with Space, move between gaps with the arrow keys, and drop with Space. Flight departure and arrival airports remain together, so the flight itself has no insertion point. Gap targets use neighbouring stop IDs and reject a changed gap instead of silently appending after a collaborator edits the day.

Unapplied flights outside the trip can remain bookings. **Extend trip to include flight** explicitly adds the needed range before using the older flight-leg flow; a flight cannot be linked to an unrelated day. Each connecting segment retains its own dates and times. **Part of a connecting journey** associates segments so cards can calculate elapsed layovers when timings are confirmed. Airport changes and overlaps are called out; this is not an airline minimum-connection validation.

All flight schedules are entered manually. There is no airline booking lookup, matched-flight search, live gate/delay feed, ticket purchase, boarding-pass import or flight tracking. Flight duration comes from the scheduled timestamps, not a Maps route. Google Maps continues to supply ground journeys to and from airports; any flight connection drawn on the map is illustrative.

## Arrival days and Travel mode

Travel mode treats the airport visit and flight as separate progress targets. Marking the departure airport **Done** does not mark the flight landed. Use **Mark landed** after arrival. The departure/arrival views of an overnight flight share the same flight progress ID. The clock never completes it automatically.

Departure-day flight cards can open ground directions to the departure airport. That action is hidden on an arrival-only day, so the next-day screen does not send the traveller back to the departure country.

In Travel mode’s Essentials, a linked overnight flight’s arrival-day booking card can offer **Start this day at arrival airport**. Its preview identifies the airport, the local time after the post-landing buffer, and the arrival time zone. Applying it replaces that day's start location, time and time zone; an existing finish goal at or before the new start is cleared. The end location remains as planned. A later valid airport start is respected. An explicit onward journey on the previous day ending at this day’s starting place also satisfies the arrival-start check, including when landing or the arrival buffer crosses midnight. This keeps a later hotel start intact. The check compares confirmed flight times, remaining visits and fixed waits across time zones; it does not invent a transfer estimate. Missing transfers remain visible on the previous day. Without either a valid airport start or that onward plan, affected ground journeys remain uncertain.

If the post-landing buffer extends into another local date, the preview explains that the onward plan belongs on that date instead. Missing or uncertain flight timing must be resolved before reliable onward routing.

## Accommodation

Choose **Add a stay**, search for the property, and select its check-in and check-out dates. **Add stay** beside uncovered nights starts with the first missing night. New stays suggest check-in at 15:00 and check-out at 11:00; these are editable defaults to confirm against the booking, not verified property hours. Times may be left blank. The property time zone remains visible, with its editor and private details available on demand.

Check-out is exclusive for occupied nights. Review **Your days, joined up** and keep **Use this stay for day start and end points** checked to save and apply eligible endpoints in one step. The previous night's stay supplies a day's start, and the next night's stay supplies its end. Thus a hotel change can end one day at a ryokan and begin the next there. Chosen airports and other custom endpoints remain in place. Overlapping bookings require a choice instead of silently selecting a property. A stay outside the trip offers a separate, explicit date-extension checkbox.

The list's existing **Apply to itinerary** action still previews eligible endpoints and lets the traveller select individual days. Editing an applied stay refreshes its accepted locations. When an accepted stay is shortened with day application enabled, its expired endpoints can switch to another booked stay; manual airport/custom overrides survive. Deleting a stay detaches its booking references and retains the chosen locations. The older single **Your stay** location also continues working.

The timeline shows **Check in from…** and **Check out by…** reminders on the relevant days. These reminders do not automatically add waiting time, enforce checkout, or move activities. On an arrival day, **Add bag-drop stop** can add a 15-minute editable visit to the stay before other stops. Before a departure, **Add bag-collection stop** can add one before the final airport transfer. These actions are optional and undoable; luggage storage must be confirmed with the accommodation. Neither a hotel booking nor the button establishes that storage is available.

## Saving, privacy and compatibility

- Flights and stays are saved once per trip; existing itinerary items and stay endpoints reference stable booking IDs. Arrival/departure setup uses existing day start/end, time-zone and finish-goal fields. The bookings bar, collapse control, guided forms and scoped endpoint pickers require no new schema or migration.
- The schema version 2 migration is `supabase/migrations/202610270002_daytrail_bookings.sql`, following cloud saving and Travel mode progress. It preserves existing IDs and progress. Booking edits continue through the existing revision-checked private or collaborative save path. Use `npm run db:migrate` for schema setup rather than manually pasting migrations.
- New clients read versions 1 and 2. New mutations use version 2; previously queued immutable version 1 mutations retain their original format. Older clients cannot save, delete or restore a version 2 cloud row.
- Personal JSON backups retain flight/stay details, including private fields, and imports accept backup versions 1 and 2. Imported copies receive independent trip IDs. Travel progress is not part of itinerary backups.
- Collaborative editors/viewers receive shared booking data; owner-private fields remain protected by the collaboration save path. Read-only snapshots and HTML itineraries omit booking references, private notes, contact details, booking websites and flight gates. They retain useful public details such as airports, dates/times, terminals, flight numbers and accommodation dates.
- Guest trips remain on the device until explicitly moved. Account booking edits use existing durable drafts, pending writes, revision conflict handling and sign-out protection.
- No new flight-provider key or browser database secret is needed. Follow [Cloud saving setup](CLOUD_SAVING_SETUP.md) and [Database migrations](DATABASE_MIGRATIONS.md) for deployment.

## Verification checklist

Automated coverage and manual browser acceptance are recorded separately. Rendering tests validate output and privacy, not browser interactions or live service access.

### Automated coverage

Run `pnpm test` and `pnpm build`. For isolated PostgreSQL validation, use the command in [Cloud saving setup](CLOUD_SAVING_SETUP.md#validation).

| Area | Coverage |
| --- | --- |
| Flight timing | Time-zone differences, overnight/date-line travel, daylight-saving gaps/repeats, half-hour offsets, missing/invalid timings and buffer handling in `src/bookings/model.test.mjs`. |
| Routes and scheduling | Flights bypass Google ground routing; fixed departure/arrival and buffers drive downstream timing; uncertain arrival-day starts prevent misleading ground estimates. |
| Editing and linking | Airport-only and mid-day insertion, existing airport reuse, unlink/delete, exact departure-day linkage, range extension and preserved IDs in `src/bookings/actions.test.mjs`; atomic boundary/stay application, date limits, manual override preservation and multiple-flight ambiguity in `src/bookings/journey.test.mjs`. |
| Accommodation | Exclusive check-out, property-change days, shortened stays, selected endpoint application, preserved manual overrides, overlap/gap warnings and edit/delete behavior. |
| Presentation and privacy | Owner-only private fields, safe booking URLs, escaped notes, local dates/duration, DST choices, direct booking edits, boundary previews, night coverage, multiple-flight choices, read-only controls, uncertainty warnings and optional bag-stop actions in `src/components/bookings.test.mjs`. |
| Progress | Separate airport/flight completion, stable overnight flight IDs, no automatic completion and no flight-mode Google directions in `src/travel/model.test.mjs` and progress controller tests. |
| Backups and sharing | Version 1 import, version 2 round-trip, independent imported trip IDs, strict references and private-field removal in `src/tripBackup.test.mjs`. |
| Database | Strict version 2 document validation, legacy compatibility, owner isolation, stale-write protection, downgrade rejection and flight progress in `supabase/tests/daytrail_bookings.sql`. |

### Manual release acceptance

The following checks are pending manual sign-off in this document. Check a box only after exercising that flow in a browser, and record the browser/device and any remaining limitations. Automated checks above do not count as manual sign-off.

- [ ] Collapse/expand the Bookings bar on desktop and phone; change one day start/end from a matching booking or search result, including its time, without changing the opposite endpoint or other days.
- [ ] Use the bookings bar to save an arrival and departure with the previewed day changes; verify booking-only saves leave the plan unchanged and stops remain available.
- [ ] Add a flight with real place search and custom locations; date/time fields update the duration immediately and survive save/reopen.
- [ ] Link an airport-only flight day, and a flight before an existing attraction; verify fixed flight timings and preserved visits.
- [ ] Open the arrival day of an overnight flight; verify local dates, the onward-start preview, no departure-country directions and one shared **Mark landed** status.
- [ ] Add a connecting segment; review the layover, overlap warning and an airport-change connection.
- [ ] Keep an out-of-range booking, explicitly extend the trip, then link it to its departure day without losing existing days.
- [ ] Open an uncovered night, save its stay and review the nights count; check optional bag-drop/collection stops without assuming storage is available.
- [ ] Add two accommodations; preview a hotel-change day and confirm airport overrides are preserved.
- [ ] Edit/delete/unlink flights and stays; verify retained airport/property locations and clear errors for broken links.
- [ ] Verify owner booking references/contacts in Travel Essentials and their absence from shared snapshots and downloaded HTML.
- [ ] Reload, reopen the trip, and recover pending account saves after reconnecting. Verify current schema migration state before live cloud checks.
- [ ] Exercise phone and desktop layouts, keyboard focus, native date/time fields and place-picker back navigation.
