# Bay Area emergency diversion demo

User-requested scenario: ten flights inbound to the Bay Area. A featured aircraft approaches SFO from the south, declares an emergency, requests Monterey (MRY), receives a real refusal, then requests San José (SJC), receives an offer and clearance, and lands there.

The national directory includes MRY alongside SFO/OAK/SJC and the original top ten airports (14 total). Bay Area view is centered at longitude -122.0, latitude 37.2, zoom 7 so Monterey Bay and all four regional airports are visible.

Backend scenario requirements:
- Seed ten aircraft within the visible region with destinations SFO/OAK/SJC. Keep the featured aircraft south of MRY and its original destination SFO.
- Use a clearly named demo preset. Any seeded positions, destinations, emergencies or constraints are simulation data, even if callsigns come from OpenSky.
- Send the emergency through the normal incident path. MRY must respond with an actual refusal due to an authoritative runway/capacity constraint. Do not fabricate a transcript or force a landing.
- Requests are sequential: MRY refusal precedes SJC request. The general emergency policy currently asks up to three airports in parallel, so the preset needs an explicit sequential negotiation policy.
- Ensure the featured flight has enough fuel and emergency time for the real hosted Relay round trips, and revalidate arrival feasibility at acceptance/confirmation/clearance.
- Keep SJC available. Its offer, reservation, clearance and touchdown must use the normal safety checks.
- Capture evidence of request MRY → refusal MRY → request SJC → offer/confirmation/clearance → landing, including run ID and message IDs.

The map/directory change does not by itself establish a live scenario run. Backend integration owns preset setup, deployment, and the real Relay verification.
