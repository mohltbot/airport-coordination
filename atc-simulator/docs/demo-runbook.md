# Demo runbook

Ghost Tower, YC Haunted Hacks, 2026-10-31. Top 8 finalists get 2 minutes each, judging 16:00 to 17:00.

## Before walking up

Run all of these on the Mac mini.

1. Agent Relay local engine running in its Terminal tab (`npx -y @relaycast/engine@12.3.0` from `atc-simulator/`). `curl -s localhost:8787/health` returns `{"ok":true}`.
2. Terse runtime, API and worker up. `curl -s localhost:3000/api/health` shows actors READY, relay READY "Agent Relay (local engine)", model READY, worker READY, agentMode live.
3. Big screen open on the display view, Bay Area zoom. Phone on the controller page.
4. Backup video open in a background tab.
5. 60 seconds before the slot, start the run in a terminal and leave it waiting for the cue:

```bash
cd atc-simulator && bun run demo:bay-emergency -- --speed 10 --smoke-on-enter
```

It resets the run, creates 10 Bay Area flights with live OpenSky callsigns, closes both Monterey runways, then waits. Press Enter on the line marked "SMOKE" in the script below.

Measured at 10x with live model decisions (run 955823f7): Monterey refuses 1.6 s after the smoke, San Jose confirms 5.5 s, clearance 67 s, touchdown 2:18.

## Script, 2 minutes

The featured flight's callsign changes every run because it is a live flight. Read it off the screen.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Bay Area map, 10 planes | "This is Ghost Tower. Every plane on this map is a real flight in the air right now, from OpenSky. Each plane and each control tower is its own AI agent." |
| 0:12 | Monterey shown closed | "Monterey has both runways closed." |
| 0:17 | Press Enter (SMOKE) | "[Callsign] is coming up from the south to SFO, and it just reported smoke in the cabin." |
| 0:25 | Radio log: mayday, refusal, offer, confirm | "It asks the nearest airport first. Monterey's tower refuses: runways closed. It asks San Jose. San Jose offers runway one, the plane accepts, and its old slot at SFO goes back to SFO. That took six seconds." |
| 0:50 | Click the featured flight, Communications tab | "Every line is a message between two agents over Agent Relay. Click any plane and you see why it decided: 'SJC has a feasible offer and is the closest available landing option.' Hard rules stay in code, so a closed runway always gets a refusal." |
| 1:15 | State tab | "Each airport and each flight is a Terse durable actor with its own state. We killed the actor runtime mid-run and every plane came back with the same position, fuel and clearance." |
| 1:40 | Featured flight on approach | "Fourteen airports, real callsigns, and every decision you saw was made live. [Callsign] is on approach to San Jose now." |

About 230 spoken words. Touchdown lands just after 2:00 at 10x; if the 12 s booking budget passes its 3 test runs, touchdown moves inside 2:00.

## If something fails

- Model slow: decisions show RULES_FALLBACK with a label. Say so plainly and keep narrating.
- Relay engine or worker down: the health panel says so. Play the backup video and say it is a recorded run from this afternoon.
- Wrong airport or no refusal: reset with the same command and narrate the recorded run instead.

## Questions to expect

- **What's real?** Live callsigns and positions at run start (OpenSky), every agent message over Agent Relay, every decision by gpt-5.4-mini with a written reason, Terse actors for all state, incidents sent through the same command path a phone uses. Simulated: aircraft movement after the start, a map compressed so that real distances fit the scenario.
- **Why one actor per plane?** A tower agent, a pilot agent and a phone all touch the same flight. One actor per flight means one writer at a time, its own history, and it sleeps when idle.
- **Why agents talking to agents instead of one planner?** Each tower owns its runways and can refuse. The flight negotiates like a pilot does, one airport at a time, and the log shows who decided what.
- **Hosted Relay?** It overloaded under the hackathon's load (20 to 110 s per message, 503 database_overloaded). Will Washburn OK'd Agent Relay's local engine for the demo; the same code runs hosted by changing one setting.
- **Who pays?** Airline operations centres and airports handling irregular operations, and drone and eVTOL traffic management, where every vehicle will be an agent negotiating airspace.

## Builderbase submission

**Name:** Ghost Tower

**Tagline:** Every flight and every control tower is an AI agent, negotiating landings live

**Writeup:**

> Ghost Tower puts an AI agent in every cockpit and every control tower. Flights negotiate landing slots with towers over Agent Relay, and each tower can offer, hold or refuse based on its own runways. Each airport and each flight is a Terse durable actor, so state survives a crash and an idle plane costs nothing.
>
> The demo loads real flights in the air over the Bay Area right now from OpenSky. Monterey closes both runways. A flight from the south reports smoke and declares an emergency. It asks Monterey first and is refused (runways closed), then asks San Jose, which offers a runway. The plane accepts within six seconds and lands. Every decision is made live by gpt-5.4-mini with a written reason you can click on, and hard rules such as a closed runway are checked in code.
>
> Built today: 14 US airports, continuous departures, a phone controller that sends incidents through the same command path as the operator, and a restart test where the actor runtime was killed mid-run and every plane resumed unchanged.
>
> Stack: Terse durable actors, Agent Relay (local engine for the demo after the hosted service overloaded), OpenAI gpt-5.4-mini, OpenSky Network, Bun, React.
