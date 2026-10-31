# Regional arrivals and departures

Both demo scripts now enable continuous traffic by default. Use `--finite` to replay the previous finite scenario. `--no-incidents` still leaves incident control to the phone.

- Keep the configured flight count bounded. One initial background flight departs LGA (NYC) or OAK (Bay); the others retain regional inbound placement, including the unchanged featured Bay flight.
- After a terminal flight has remained visible for 90 simulated seconds and its outbox has drained, replace it with a new actor identity. Keep the featured Bay flight available for inspection after landing.
- Alternate departures and new inbound arrivals. Departures originate at open regional airports with an available runway, rechecked after Relay registration. Inbound flights enter 18–34 simulated nautical miles out from different directions and negotiate through the ordinary actor/Relay path, including weather refusals.
- Replace at most one flight per scheduler pass, with 60–120 simulated seconds between activations. At 10x this is 6–12 wall seconds, provided another terminal slot is available. The flight-count limit prevents a growing crowd.
- Regional departures head to other simulated US airports, leaving the regional viewport naturally. Initial departures are represented as aircraft already taking off, with ENROUTE motion; this is not a taxi, climb or departure-clearance model.
- Positions, routes and timing are simulated, even when callsigns come from OpenSky. Closed airports can still be requested by incoming flights and must refuse through the real negotiation path.

Examples, from `atc-simulator/` (each command resets the current run):

```sh
bun run demo:bay-emergency --flights 8 --speed 10
bun run demo:nyc-weather --flights 4 --speed 10
# Manual incident control:
bun run demo:bay-emergency --flights 8 --speed 10 --no-incidents
bun run demo:nyc-weather --flights 4 --speed 10 --no-incidents
```

The NYC verifier tracks the original cohort across replacements so ongoing traffic does not prevent completion. The Bay featured flight is never retired. The old finite presets remain available by adding `--finite`.
