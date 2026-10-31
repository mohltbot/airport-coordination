# Independent laptop recording instance

Open http://localhost:3100/ for the display and http://localhost:3100/control for the phone controls. These use your laptop's own actor and Relay databases, not the partner's tunnel.

- API + built web: 3100
- Terse runtime: 7101, project `recording`
- Relay engine: 8788, dedicated workspace/database
- Agent decisions: deterministic rules (selected for this recording)
- Private environment: `atc-simulator/.env.recording` (gitignored)
- Logs/state: `atc-simulator/.data/recording/` (gitignored)

The 5173 tab still connects to the partner's app. Use **3100** when recording independently.

## Restart if needed

From `atc-simulator/`, add the already-installed tools to PATH:

```sh
export PATH="/Users/siddharthsurana/Documents/ChatGPT/Mosi/haunted-hacks-setup/bin:/Users/siddharthsurana/Documents/ChatGPT/Mosi/haunted-hacks-setup/tools/node_modules/.bin:$PATH"
```

Run each service in its own terminal (do not start a duplicate while its port is occupied):

```sh
(cd actors && terse actor dev --port 7101 --project-id recording)
/Users/siddharthsurana/.agentworkforce/relay/bin/relaycast-engine --port 8788 --db .data/recording/relay.db
bun --env-file=.env.recording scripts/dev.ts --prod
```

Create a fresh operator link:

```sh
bun --env-file=.env.recording scripts/operator-link.ts
```

Use the **localhost:3100** link it prints, not its legacy 5173 link.

For a fresh scene with no incidents (starts, checks health, then pauses):

```sh
bun --env-file=.env.recording .data/recording/prepare.ts bay
bun --env-file=.env.recording .data/recording/prepare.ts nyc
```

These commands reset only the local recording run. Incidents can then be triggered from `/control`.
