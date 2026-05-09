# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev        # Start dev server at http://localhost:3000
pnpm build      # Production build (catches type and build errors)
pnpm lint       # ESLint with Next.js Core Web Vitals + TypeScript rules
pnpm start      # Serve production build after pnpm build
```

No test framework is configured. Verify with `pnpm lint` and `pnpm build`, then manually exercise core flows in the browser.

## Project Context

Before implementing large features, read `Plan.md`, `AGENTS.md`, and `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf`. `Plan.md` is the implementation sequencing source of truth; the PDF is the grading authority. `public/fleet.json` is immutable seed data — never replace it with invented data.

## Architecture

### Data flow

```
public/fleet.json (immutable seed)
    └─► lib/fleet-seed.ts          loads + validates at startup
            └─► lib/simulator/store.ts  singleton SimulatorStore
                    ├─ 1 Hz tick loop   advances all ships
                    ├─ dispatch()       mutates state (directives, zones, acks)
                    └─ broadcast()      pushes SimulatorSnapshot to SSE listeners

app/api/sim/stream/route.ts    persistent SSE endpoint → EventSource on client
app/api/sim/*/route.ts         thin POST handlers: validate → dispatch → return snapshot

app/page.tsx                   single React page
    ├─ EventSource(/api/sim/stream)   live snapshot updates
    ├─ interpolateLatLng()            100 ms timer smooths ship motion between 1 Hz ticks
    └─ postJson()                     all mutations (directives, responses, zones, acks)
```

### Key files

| Concern | File |
|---------|------|
| Domain types | `lib/domain.ts` |
| Geospatial math | `lib/geo.ts` |
| Simulator constants & physics | `lib/simulator/core.ts` |
| Authoritative state + tick loop | `lib/simulator/store.ts` |
| Fleet seed loader | `lib/fleet-seed.ts` |
| UI (map, fleet list, panels) | `app/page.tsx` |
| SSE stream | `app/api/sim/stream/route.ts` |
| Directives API | `app/api/sim/directives/route.ts` |
| Captain responses API | `app/api/sim/responses/route.ts` |
| Restricted zones API | `app/api/sim/zones/route.ts` |
| Alert acknowledgement API | `app/api/sim/alerts/ack/route.ts` |

### Simulator store (`lib/simulator/store.ts`)

`SimulatorStore` is a module-level singleton (Next.js Node.js runtime only). It owns the tick loop and all mutable state: ships, restricted zones, alerts, directives, weather samples, and history snapshots.

**State mutation always goes through `dispatch(command)`** — never write state directly from API routes. Commands: `issue_directive`, `captain_response`, `create_zone`, `ack_alert`.

**Broadcast** calls every registered listener with a `SimulatorSnapshot`. SSE clients subscribe via `subscribe(listener)` and unsubscribe on disconnect.

**History** is captured every 30 s and windowed to 60 minutes (`HISTORY_WINDOW_MS`).

### Ship physics (`lib/simulator/core.ts`)

- `SIM_TICK_MS = 1000` — tick period
- `BASE_FUEL_TONS_PER_KM = 0.08` — clear-weather fuel rate
- Movement budget = min(speed-limited distance, fuel-limited distance)
- Fuel burn = `distanceKm × 0.08 × weatherMultiplier` (1.3× in adverse weather)
- Status resolution priority: stopped/distressed > out_of_fuel > stranded > insufficient_fuel > normal
- Insufficient fuel check: `currentFuel < routeRemainingFuel × 1.1`

### Domain types (`lib/domain.ts`)

`ShipState` carries `position`, `previousPosition`, `lastUpdateAt` — clients use these three fields for interpolation. `currentRoute` holds the active `RoutePlan` with `waypoints[]` and `activeWaypointIndex`. `ShipStatus` enum: `normal | rerouting | distressed | stopped | insufficient_fuel | stranded | out_of_fuel | arrived`.

### Client interpolation (`app/page.tsx`)

A 100 ms `setInterval` increments the `now` frame counter. The map renders each ship at `interpolateLatLng(previousPosition, position, (now - lastUpdateAt) / 1000)` to smooth the 1 Hz backend ticks into continuous motion. The client is display-only — it never mutates ship state.

### Map rendering

SVG canvas (1000×620 px). Lat/lng projected to pixel space using the scenario bounding box. Ships are rotated triangles; ports are squares; restricted zones are dashed polygons. Role-based panels sit left and right of the SVG.

### Roles

- **Command** — full fleet view, issue directives, draw/edit restricted zones, acknowledge alerts, playback controls.
- **Captain** — single-ship view, see pending directives, `ACCEPT` or `ESCALATE_DISTRESS`, submit distress messages.

Role is toggled client-side. When captain mode is active, the UI is scoped to `captainShipId`.

### API routes

All routes under `app/api/sim/` set `export const dynamic = "force-dynamic"` and `export const runtime = "nodejs"`. Every POST: parse JSON body → validate required fields → `dispatch` → return snapshot. The SSE route registers a listener, keeps the connection alive with 15 s heartbeats, and removes the listener on client disconnect.

### Geospatial utilities (`lib/geo.ts`)

`haversineDistanceKm`, `bearingDegrees`, `movePosition`, `pointInPolygon` (ray-casting), `clampToBoundingBox`, `knotsToKmPerSecond`. All coordinates are `[lat, lng]` tuples.

## Constraints

- **No polling** — fleet sync must use the SSE persistent connection, not HTTP polling.
- **No external services required** — the app must run end-to-end on a laptop. Weather (Open-Meteo free tier) is optional; rule-based distress extraction is the local fallback.
- **In-memory state only** — no database. SimulatorStore is the single source of truth; restarting the server resets all runtime state.
- **`public/fleet.json` is immutable** — exactly 15 ships, fixed ports and navigable-water polygon.
- Geofence breach alerts must fire within 1 s of boundary crossing and stay active until acknowledged or resolved.
- Proximity alerts fire when any two ships are within 2 km.

## Coding conventions

TypeScript, React function components, two-space indentation, double quotes, semicolons. Tailwind utility classes for styling; shared tokens in `app/globals.css`. The `@/*` alias maps to the repository root. Keep units explicit in names — knots, km, ms, tons, `[lat, lng]`.
