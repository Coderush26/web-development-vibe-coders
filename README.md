# Fleet Crisis Command

Local realtime simulator for the Code Rush Web Dev Track fleet-crisis scenario. The app loads the fixed 15-ship Strait of Hormuz scenario from `public/fleet.json`, advances an authoritative in-memory backend state at 1 Hz, and streams snapshots to connected viewers over a persistent Server-Sent Events connection.

## Getting Started

Use pnpm for local development:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the command system.

If `pnpm` is not on PATH, use Corepack:

```bash
corepack pnpm dev
```

## Current Runtime

- `app/api/sim/stream` keeps a persistent SSE connection open and broadcasts authoritative simulator snapshots. This is intentionally non-polling live sync; a later phase can swap this transport to WebSocket without changing the simulator domain model.
- `app/api/sim/directives` lets Command issue directives.
- `app/api/sim/responses` lets Captains accept or escalate directives.
- `app/api/sim/zones` lets Command create restricted zones.
- `app/api/sim/alerts/ack` acknowledges active alerts.
- Runtime state is in memory for local judging simplicity: ships, directives, alerts, zones, weather samples, and playback history.

## Environment Variables and API Keys

No required API keys are needed for the first implementation phase.

Planned weather integration will use Open-Meteo by default because basic forecast data can be fetched without a required API key. If a later provider is added, document its key here.

## Assumptions

- `public/fleet.json` is immutable seed data and must contain exactly 15 ships.
- Fuel burn currently uses a documented local estimate of `0.08 tons/km`, with a multiplier field already present for the upcoming adverse-weather phase.
- Phase 1 uses a direct destination route estimate while the routing phase will replace it with grid/A* restricted-zone and weather avoidance.
- Restricted-zone creation is implemented as a command action and immediately alerts ships already inside the new polygon.
- Playback history is retained in memory for the last hour at 30-second resolution.

## Verification

```bash
pnpm lint
pnpm build
```

Manual browser checks should cover live fleet updates, Command directive issue, Captain accept/escalate, restricted-zone alerting, alert acknowledgement, role scoping, and playback history visibility as those features are completed.
