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

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/sim/stream` | GET | Persistent SSE connection — broadcasts authoritative simulator snapshots at 1 Hz |
| `/api/sim/snapshot` | GET | One-shot snapshot of current simulator state |
| `/api/sim/directives` | POST | Command issues a directive to a ship |
| `/api/sim/responses` | POST | Captain accepts or escalates a directive |
| `/api/sim/zones` | POST | Command creates or toggles a restricted zone |
| `/api/sim/alerts/ack` | POST | Acknowledges an active alert |
| `/api/sim/weather` | POST | Triggers an immediate weather refresh from Open-Meteo |

## Environment Variables and API Keys

No API keys are required. Weather data is fetched from the [Open-Meteo](https://open-meteo.com/) free tier (no key needed).

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| _(none required)_ | — | All defaults are production-ready for local judging |

## Weather

Weather is fetched from Open-Meteo across a 14-point grid covering the Persian Gulf, Strait of Hormuz, and Gulf of Oman:

- **On startup** — first fetch runs automatically within ~10 seconds of `pnpm dev`.
- **Every 10 minutes** — background refresh updates all grid points and broadcasts via SSE.
- **On demand** — `POST /api/sim/weather` triggers an immediate refresh.

**Adverse classification thresholds:**
- Wind speed ≥ 15 m/s (~30 knots), OR
- Wave height ≥ 2 m

Adverse weather applies a **1.3× fuel multiplier** (30% extra burn) to any ship moving through that region. Weather does not trigger rerouting on its own — it affects fuel cost when a route is computed for another reason.

## Simulator Features

- **15 ships** loaded from `public/fleet.json` (immutable seed data).
- **1 Hz tick loop** advances ship positions, burns fuel, and resolves status.
- **Fuel burn:** `0.08 tons/km × weather multiplier`. Adverse weather adds 30%.
- **Ship statuses:** `normal`, `rerouting`, `distressed`, `stopped`, `insufficient_fuel`, `stranded`, `out_of_fuel`, `arrived`.
- **Dijkstra routing** inside the navigable-water polygon, avoiding active restricted zones. Interior waypoints thread the Strait of Hormuz channel.
- **Auto-reroute** when a new zone intersects a ship's path or surrounds it.
- **Geofence breach alerts** fire within 1 second of boundary crossing.
- **Proximity alerts** fire when any two ships come within 2 km.
- **Distress NLP** (rule-based local fallback) extracts severity, problem category, and impact from captain free-text messages.
- **Playback history** retained in memory for the last 60 minutes at 30-second resolution.

## Roles

- **CMD (Command):** full fleet view, issue directives, draw/toggle restricted zones, acknowledge alerts, playback controls.
- **CPT (Captain):** single-ship view, see pending directives, respond with `ACCEPT` or `ESCALATE_DISTRESS`.

## Verification

```bash
pnpm lint
pnpm build
```

Manual browser checks: live fleet updates, directive issue → captain accept/escalate, restricted-zone draw → auto-reroute, geofence breach alert → acknowledge, proximity alert, distress analysis, weather overlay, playback scrubbing.

## Assumptions

- `public/fleet.json` is immutable and contains exactly 15 ships, fixed ports, and the navigable-water polygon.
- Runtime state is in-memory only — restarting the server resets all ships, alerts, zones, directives, and history.
- Rule-based distress extraction is the local fallback; upgrade to an AI-backed extractor by setting an Anthropic API key and swapping the `analyzeDistressMessage` function in `lib/simulator/store.ts`.
- Open-Meteo is the default weather provider. Polling at 10-minute intervals is intentional — the free tier updates hourly, so more frequent polling returns identical data.
