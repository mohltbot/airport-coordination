# National map and continuous traffic

User requirements: all ten busiest US airports active, real map and names, regional zoom including the Bay Area, and ongoing flights departing from airports. This feature is prepared on `codex/us-map`; it must not silently replace the partner's active integration run.

## Geographic and compatibility contract

Airport ranking and boundary provenance: [MAP-SOURCES.md](MAP-SOURCES.md). Real geography is compressed into the existing simulation space, preserving demo fuel and emergency timing. These coordinates are not real nautical-mile distances. Only snapshot airports appear as active towers; regional cities are map context. Bay Area geography can be explored, but SFO/OAK/SJC are not among the pinned top ten.

`RunConfig.airportNetwork` is optional: `US` opts into the ten-airport world; absent or `LEGACY` retains the original three-airport world. The schema accepts both sets of IDs. World creation, actor registration, pilot directories and flight geometry choose the correct directory. A new UI run defaults to US, while existing runs retain their persisted network. A negotiation still contacts at most three candidates.

## Continuous traffic design

`RunConfig.continuousTraffic` is optional; absent preserves one-shot legacy behavior. The UI offers an explicit Keep traffic flowing setting. Initial continuous flights depart from airport coordinates rather than appearing near destinations. The origin is included in flight projections.

A fenced durable replacement saga records a unique next flight identity before any side effects. Terminal flights (landed or unresolved) are replaced with freshly initialized actors; no old flight actor is repurposed. The worker registers the new Relay identity, initializes the actor idempotently, and activates the replacement only after preparation succeeds. It reconciles active agent membership from authoritative actor state even if the activation response is lost. Retired identities remain separately routable for late airport replies and accepted controller commands; their outboxes still drain, but they no longer advance or count toward the chosen fleet size. Registration uses a union of current, retired and pending identities, so pausing mid-registration cannot disconnect the existing fleet. Replayed work reuses the recorded IDs, preventing duplicate departures. Paused and reset runs must not dispatch new flights. A pending registration temporarily holds the simulation clock; if its origin becomes unavailable, the pending departure is cancelled durably and replanned using a new identity, allowing ticks to resume. Old messages must never route to a new flight.

The active population stays at the configured flight count. The implementation has a documented per-run dispatch capacity of 10,000 flight legs; this is ongoing hackathon traffic, not an unbounded production scheduler. The capacity limit must produce a visible event rather than silently stalling. Departures use an origin with a usable runway. Landing clearance and arrival safety checks remain authoritative; the UI must not invent takeoff clearances.

## Integration gate

Before deploying: review the branch, run domain/worker/browser tests, regenerate actor clients if the new actor methods require it, and restart at a coordinated boundary after the partner's scenario finishes. Start a fresh US run and verify a complete departure/landing/replacement cycle through real Relay, plus pause, worker restart and reset. A passing fixture or mock test is not proof of hosted Relay capacity or live continuous dispatch.
