# airport-coordination

YC Haunted Hacks 2026. Terse durable actors plus Agent Relay.

- `actor/` Terse actors (`bun install`, then `terse actor dev`)
- `client/` backend and pages (`terse actor generate`, then `bun run server`)

## Simulator implementation

- [End-to-end implementation plan](docs/superpowers/plans/2026-10-31-atc-simulator.md)
- [Companion design specification](docs/superpowers/specs/2026-10-31-atc-simulator-design.md)

Read both documents before implementing. The plan proposes a new `atc-simulator/` directory; the existing `actor/` and `client/` integration prototype remains available as a starting reference. References to `haunted-hacks-setup/` describe the author's prior local setup and are not files included in this repository. Implementation tasks remain unchecked.
