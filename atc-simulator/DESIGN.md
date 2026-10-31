# Ghost Tower interface

The simulator is an operating interface for hackathon judges and its operator. The existing design spec section 9 is the visual authority. No marketing surface or decorative telemetry.

## Tokens

Background #10161C; panels #18222C; primary text #F3F6F8; secondary #A9B7C4; borders #344553; routes #58C8DD; warning #F0B35C; emergency #F07178; confirmed #7DD6A2. System sans for UI, system monospace for callsigns, clocks, coordinates. Body 14–16 px desktop and 16 px phone. Spacing 4/8/12/16/24/32 px. Border-based separation, restrained 6–8 px control radii. All controls at least 44 px high; visible cyan focus ring.

## Composition

64 px toolbar; 280 px left fleet/configuration panel; center north-up 240 × 160 NM SVG map; 340 px right inspector; fixed 180 px activity timeline under the map. At 1024 px fleet becomes a drawer. Under 768 px map/list toggle and stacked inspector; dedicated /control is the phone-first surface with Airports, Flights, Active incidents tabs.

## Behavior

Map is geometry, not decoration. Per the user's presentation update, light cyan dotted lines connect every nonterminal flight with a confirmed assignment to its assigned airport. Selecting a flight brightens its line; selecting an airport brightens its incoming assigned lines. Flights without an assignment get no destination line. Selected-flight proposals use amber long dashes and an explicit unconfirmed legend; revocations briefly cross then disappear. This replaces the original spec's solid-confirmed-line convention. Closed airport markers are hatched and labeled. Selection survives snapshot replacement. Draw only between authoritative positions and stop animation on stale data. Respect reduced motion. Animation never changes model state.

Show connection freshness, transport/application distinction, dependency health, and real model/rules-fallback source. Never turn HTTP 202 into an active incident. Per-incident resolve controls preserve independent overlaps and explain that low-fuel clearing does not refill fuel. No secret appears in browser logs. /join exchanges and removes the capability fragment.

Use semantic buttons, inputs, headings, lists, labels and status regions. Keyboard selection, clear empty/error/loading states, readable queue labels, bounded event feed, no page-wide horizontal overflow. Validate at 1440×900, 1024×768, 390×844 and 768×1024. The fixture route is explicitly labeled DEVELOPMENT DATA and cannot send commands.
