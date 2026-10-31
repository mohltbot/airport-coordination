# Ghost Tower interface

Ghost Tower is an operating interface for hackathon judges and its operator. The user's Apple-presentation refinement updates the original spec's visual tokens and density while preserving its operational behavior. Impeccable and Taste informed the refinement. No decorative telemetry or fabricated activity.

## Tokens

Canvas #090B0E; map #101419; graphite panels #15191F; raised surfaces #20262E; primary text #F5F6F8; secondary #A5AEBA; borders #30363F; separators white at 7.5% opacity. Selection #8CCFFF; warning #F2C079; emergency #FF939D; confirmed #A1E1BA. Native system sans throughout, with system monospace reserved for clocks and coordinates. Body 14–16 px; map and inspector headings 28–30 px. Spacing 4/8/12/16/20/24/32 px. Major panels have 20 px radii, controls 10 px. All primary controls at least 44 px high; visible cyan focus ring. Subtle 180 ms interaction transitions respect reduced motion.

## Composition

Detached 76 px toolbar; 236 px fleet/configuration panel; dominant north-up 240 × 160 NM SVG map; 368 px communication inspector; bounded 180 px activity timeline below the map. Panels are separated by 16 px gutters, with 20 px outer margins. At 1050 px the fleet becomes a drawer. Short desktop/tablet screens scroll the whole composition rather than clipping map content. Under 768 px, map/list toggle and stacked inspector. The dedicated /control route is the phone-first surface with Airports, Flights, and Active incidents tabs.

## Communication inspector

Selecting a flight or airport opens Communications by default. State and Controls remain available in keyboard-accessible tabs. Show only actual public timeline summaries involving the selected entity. Deduplicate by eventId, order by wallTimeMs, and group by correlationId; null correlation IDs remain standalone. A counterpart filter narrows the visible exchanges. Label summaries as summaries, preserving sender, recipient, wall time, event type, application status, and model/rules/system source. A new negotiation round gets a new thread. Do not invent dialogue or infer a successful landing from an offer. The available history is the snapshot's latest 200 events.

## Map and operational behavior

Map geometry is authoritative. Light dotted lines connect each nonterminal flight with a confirmed assignment to its assigned airport. Selecting a flight brightens its line; selecting an airport brightens incoming assigned lines. Unassigned flights have no destination line. Selected-flight proposals use amber long dashes with an explicit unconfirmed legend. Revocations briefly cross then disappear. Closed airports have a distinctive glyph and label; emergencies use pink, selection uses blue. Labels avoid collisions and retain screen-size readability; invisible hit areas preserve keyboard and pointer selection.

Selection survives snapshot replacement. Interpolate only authoritative positions, stop interpolation on stale data, and respect reduced motion. Animation never changes model state. Show connection freshness, transport/application distinction, dependency health, and real model/rules-fallback source. Never turn HTTP 202 into an active incident. Per-incident resolve controls preserve independent overlaps and explain that clearing low fuel does not refill fuel. No secret appears in browser logs. /join exchanges and removes the capability fragment.

Use semantic buttons, inputs, headings, lists, labels, and status regions. Keep empty/error/loading states clear, event history bounded, and layouts free of horizontal overflow. Validate at 1440×900, 1024×768, 390×844, and 768×1024. The static /preview route is labeled Development preview and cannot send commands.
