# Saved Bay Area demo

Preserve this scenario independently of NYC. Adding or running the NYC weather demo must not replace the Bay Area placement or script.

## Scripted emergency replay

Run on the backend host, from `atc-simulator`, with the normal server/actors/worker and local Relay engine running:

```sh
bun run demo:bay-emergency --flights 8 --speed 10 --seed 20261031 --featured F001
```

This command replaces the active run. It closes both Monterey runways (R1 and R2), injects smoke on F001, and follows real Relay negotiation and touchdown. The intended sequence is MRY refusal followed by SJC acceptance and landing; outcomes still depend on actual airport capacity and agent decisions.

To cue the smoke manually, add `--smoke-on-enter`. This still closes Monterey automatically; it is not an incidents-off mode.

## Clean setup for phone-controlled incidents

Create the run through the existing operator API with this config, then Start and Resume:

```json
{
  "airportNetwork": "US",
  "focusRegion": "BAY_AREA",
  "flightCount": 8,
  "speed": 10,
  "seed": 20261031,
  "emergencyCandidateMode": "SEQUENTIAL",
  "featuredFlightId": "F001"
}
```

Create no incidents during setup. From the phone, close MRY R1 and R2 before triggering SMOKE on F001 if the Monterey-refusal story is desired. Other Bay flights head to SFO, OAK and SJC. F001 starts south of Monterey, originally bound for SFO. Its displayed callsign can change with live callsign data; use F001 as the stable identifier.

The placement is saved in `packages/domain/src/bay-area.ts`; the replay driver is `scripts/demo-bay-emergency.ts`. This preserves the repeatable setup, not a frozen copy of an old run or its historical messages.
