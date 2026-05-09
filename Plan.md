# Fleet Crisis Simulator Build Blueprint

## Project Goal

Build a local, end-to-end real-time command system for the Code Rush Web Dev Track scenario in `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf`. The product is an operational fleet-crisis simulator for exactly 15 commercial cargo ships moving through the Persian Gulf, Strait of Hormuz, and Gulf of Oman during a high-risk blockade event.

The system must keep the fleet visible, controllable, and alive through live ship tracking, command/captain role separation, restricted-zone management, weather-aware routing, distress-message analysis, alerts, and playback. Build the core requirements first; bonus features only matter after the judged flow works.

## Success Criteria

- Simulate exactly 15 active ships from `public/fleet.json`.
- Advance authoritative ship state on the backend at 1 Hz or faster.
- Broadcast live state through a persistent connection such as WebSocket; do not use polling for fleet sync.
- Deliver ship state to connected viewers within 500 ms, 95% of the time.
- Support at least 5 simultaneous viewers without divergent fleet state.
- Interpolate ship movement on the client so motion is smooth and physically plausible, with no teleporting or speed spikes.
- Fire geofence breach alerts within 1 second of a restricted-zone boundary crossing.
- Fire proximity warnings when any two ships come within 2 km.
- Apply a 30% extra fuel burn when a moving ship is in adverse weather.
- Keep the system reproducible on a laptop with documented environment variables and startup steps.

## Architecture

- Use the Next.js App Router application as the user-facing command and captain interface.
- Use `public/fleet.json` as immutable seed data for the scenario, operating bounds, navigable-water polygon, ports, and starting fleet. This file already contains the permitted fixed data for the judged scenario.
- Keep simulator state server-side and advance every ship from one authoritative tick loop.
- Use a persistent realtime channel for fleet snapshots, directives, captain responses, restricted-zone updates, alerts, alert acknowledgements, and playback events.
- Use client-side interpolation only for display between authoritative snapshots; never let the client become the source of truth for ship state.
- Store active runtime state in memory for judging simplicity: ships, zones, directives, alerts, weather samples, and recent history.
- Add optional local persistence only for playback or restart convenience. The app must still run locally without external infrastructure.
- Use Open-Meteo as the default weather provider because it has a free tier and can work without a required API key for basic weather data.
- Use a documented routing strategy first, such as grid/A* over the provided navigable polygon with restricted-zone avoidance and weather cost weighting.
- Use rule-based/local NLP extraction first if no AI key is configured; document how to upgrade the distress analyzer to an AI-backed extractor.

## Data Rules

- `public/fleet.json` is the allowed hard-coded scenario seed: it contains the operating area, navigable-water polygon, ports, and initial 15 ships.
- Hard-coded data is only acceptable where the spec explicitly allows it, like basemap tiles and the provided fleet scenario.
- Ship data after startup must be live simulator state, not static screen data.
- Alerts, directives, captain responses, weather effects, AI/NLP outputs, and playback history must be generated or updated live by the running system.
- If the spec does not say something, document the assumption in `README.md` or near the implementation. Documented assumptions will be honored; undocumented assumptions will be judged against the strictest reasonable interpretation.

## Domain Model

- `ShipState`: id, name, position `[lat, lng]`, speed in knots, heading, destination port id, fuel, cargo, operational status, current route, last update timestamp.
- `Port`: id, name, position `[lat, lng]`.
- `NavigableArea`: bounding box plus the simplified navigable-water polygon from `public/fleet.json`.
- `RestrictedZone`: id, polygon, createdBy, createdAt, updatedAt, active state, editable state.
- `Alert`: id, type, severity, affected ship ids, message, createdAt, acknowledgedAt, resolvedAt, source event id.
- `Directive`: id, target ship id, command type, payload, issuedBy, issuedAt, status.
- `CaptainResponse`: directive id, ship id, response type `ACCEPT` or `ESCALATE_DISTRESS`, optional distress message, respondedAt.
- `DistressAnalysis`: severity, problem category, extracted impacts such as injury count or damage estimate, confidence, source.
- `WeatherSample`: position or grid cell, timestamp, adverse flag, summary, route/fuel cost multiplier.
- `RoutePlan`: ship id, waypoints, distance, estimated fuel use, weather exposure, validity state.
- `HistorySnapshot`: timestamp, ship positions, key events, active alert summary, restricted zones.

## Implementation Phases

1. Foundation
   - Define shared TypeScript domain types for fleet data, runtime state, alerts, directives, weather, routing, and history.
   - Load and validate `public/fleet.json` once as fixed seed data.
   - Document local startup, environment variables, and any optional API keys in `README.md`.

2. Simulator Core
   - Create the authoritative server-side tick loop at 1 Hz or faster.
   - Advance each ship by speed, heading, and tick duration.
   - Update status for arrival, stopped, rerouting, distressed, insufficient fuel, stranded, and out of fuel.
   - Burn fuel every tick, applying the weather multiplier when applicable.

3. Realtime Sync
   - Add a persistent channel for snapshots and operational events.
   - Ensure every connected client receives the same authoritative fleet state.
   - Include timestamps so clients can interpolate between updates safely.

4. Map UI
   - Render an interactive ocean map centered on the provided Strait of Hormuz operating area.
   - Show all 15 ships, ports, navigable bounds, restricted zones, routes, and weather overlays when available.
   - Clicking a ship must show cargo, fuel, speed, destination, and operational status.

5. Roles and Directives
   - Provide a Command interface for full-fleet view, directives, zone editing, alert acknowledgement, and playback.
   - Provide a Captain interface scoped to a single ship.
   - Let captains respond to directives with `ACCEPT` or `ESCALATE_DISTRESS`.
   - Apply accepted course-changing directives on the next simulator tick.

6. Alerts
   - Route geofence breaches, proximity warnings, distress escalation, stranded ships, insufficient fuel, and out-of-fuel events through one alert pipeline.
   - Display visual alerts and play an audible cue for new critical alerts.
   - Keep breach alerts active until acknowledged or resolved.

7. Routing and Geofencing
   - Compute routes inside the navigable-water polygon.
   - Avoid all active restricted zones.
   - Reroute automatically when a new zone intersects a ship's current path.
   - Reroute after a captain accepts a directive that changes course, destination, waypoint, or hold state.
   - Mark a ship `stranded` and alert if no valid path exists.
   - If a zone is drawn around a ship already inside it, fire a geofence breach alert and attempt to route out.
   - If fuel is insufficient for the computed path, flag `insufficient fuel` but let the ship continue until fuel reaches zero.

8. Weather and Fuel
   - Fetch weather for the operational area from Open-Meteo by default.
   - Classify adverse weather with documented thresholds.
   - Apply the 30% extra fuel burn whenever a ship moves through adverse weather.
   - Weather alone does not trigger reroute; it affects fuel and route cost when a route is computed for another reason.

9. Distress NLP
   - Let captains submit free-form distress messages when escalating.
   - Extract severity, problem category, and quantifiable impact such as injuries, flooding, engine damage, or cargo loss.
   - Use extracted severity and impact to prioritize alerts.
   - If no AI key exists, use deterministic local rules and document the limitation.

10. Playback
    - Store the last hour of history at 30-second resolution.
    - Include fleet positions and key events in each snapshot.
    - Build a timeline that lets users scrub recent history without requiring exact full-state reconstruction at arbitrary timestamps.

11. Polish and Judging Readiness
    - Verify the system starts from one documented local command.
    - Make critical flows obvious and fast for judges: command map, captain response, zone breach, reroute, proximity alert, distress analysis, and playback.
    - Keep the UI dense, scannable, and operational rather than marketing-oriented.

## Core Before Bonus

Do not implement bonus features until all core requirements above are working end to end.

Bonus features, in priority order after core stability:

- Multiple route options with tradeoffs for faster, safer, and more fuel-efficient paths.
- Ship-to-ship assistance for fuel transfer, medical aid, escort, or cargo offload.
- Predictive alerts for future zone entry or fuel shortfall.
- AI fleet advisor that recommends command actions with accept/reject controls.

## Verification Checklist

Docs and setup:

- `Plan.md` matches the PDF constraints and does not contradict `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf`.
- `AGENTS.md` points future agents to `Plan.md`, the PDF, and `public/fleet.json`.
- `README.md` documents local startup, API keys, environment variables, and assumptions.
- `pnpm lint` passes.
- `pnpm build` passes.

Core simulator:

- Starting the app loads exactly 15 ships from `public/fleet.json`.
- The backend advances ship state at 1 Hz or faster.
- Ship movement respects speed, heading, fuel, status, and destination.
- Ships do not teleport between updates in the UI.

Realtime behavior:

- At least 5 viewers can connect and see the same fleet state.
- State reaches viewers within 500 ms for 95% of live updates.
- Directives, captain responses, alerts, and acknowledgements appear immediately for all connected viewers.

Map and roles:

- Command can view all ships and issue directives.
- Command can draw and edit restricted zones.
- Captains can see zones but cannot add or modify them.
- Captain view is scoped to one ship.
- Clicking a ship shows cargo, fuel, speed, destination, and status.

Alerts and routing:

- Restricted-zone breach alerts fire within 1 second and stay active until acknowledged or resolved.
- Proximity alerts fire when ships are within 2 km.
- New restricted zones that intersect a route trigger automatic reroute.
- A zone drawn around a ship already inside it triggers an alert and route-out attempt.
- No valid path marks the ship `stranded` and emits an alert.
- Insufficient fuel is flagged, but the ship continues until fuel is depleted.

Weather and NLP:

- Adverse weather applies 30% extra fuel burn while a ship is moving through it.
- Routing considers current weather when computing a new path.
- Distress messages produce structured severity, problem details, and quantifiable impact.
- Distress analysis affects alert priority.

Playback:

- The app stores the last hour of fleet positions and key events.
- Timeline scrubbing works at 30-second resolution.
- Playback does not break live fleet state when the operator returns to live mode.

## Assumptions

- `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf` is the grading authority.
- `Plan.md` is the implementation sequencing source of truth.
- `public/fleet.json` is immutable fixed scenario seed data, not a substitute for live runtime ship state.
- The first implementation target is a full judged app, with work sequenced from core systems to polish.
- Runtime state may be in memory for the judged local demo unless the user asks for durable persistence.
- Open-Meteo is the default weather provider unless a later implementation chooses another documented free-tier source.
- Rule-based distress extraction is acceptable as a local fallback when no AI credentials are configured.
