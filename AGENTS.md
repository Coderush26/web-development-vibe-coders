# Repository Guidelines

## Project Structure & Module Organization

This is a Next.js App Router project for the Code Rush Web Dev Track fleet-crisis simulator. Application routes and layout live in `app/`: `app/page.tsx` is the main page, `app/layout.tsx` defines global HTML/body structure, and `app/globals.css` contains Tailwind and global theme styles. Static assets belong in `public/`, including `public/fleet.json` and `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf`. Root configuration files include `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, and `pnpm-workspace.yaml`.

Use `public/fleet.json` as the canonical fixed scenario data. It already contains the allowed seed data for the Strait of Hormuz operating area, bounding box, simplified navigable-water polygon, ports, and exactly 15 starting ships. Do not replace it with invented fleet data unless the user explicitly asks.

## Product Brief

Build an end-to-end real-time crisis command system for 15 commercial cargo ships moving through the Persian Gulf, Strait of Hormuz, and Gulf of Oman during a high-risk blockade scenario. The app should prioritize core simulator behavior before bonus features.

## Project Plan

Before large feature work, read `Plan.md`, `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf`, and `public/fleet.json`. `Plan.md` is the implementation sequencing source of truth, while the PDF remains the grading source of truth.

Core requirements from the project brief:

- Simulate exactly 15 active ships, advancing backend state at 1 Hz or faster.
- Broadcast ship state to all connected viewers through a persistent connection such as WebSocket. Do not use polling for live fleet sync.
- Deliver state updates within 500 ms for 95% of viewers, and support at least 5 simultaneous viewers without divergent state.
- Interpolate ship motion between updates so movement is smooth, physically plausible, and never teleports.
- Show all ships on an interactive ocean map within the provided operating area.
- Command users can view the whole fleet, issue directives to any ship, and draw or edit polygonal restricted zones.
- Captain users are scoped to a single ship, can see zones, and can respond to directives with `ACCEPT` or `ESCALATE_DISTRESS`.
- Captains can send free-form distress messages. Extract structured severity, problem details, and quantifiable impact, then feed that data into alert priority.
- Fire visual and audible alerts for restricted-zone breaches, proximity warnings, distress escalation, stranded ships, insufficient fuel, and other critical status changes.
- Keep restricted-zone breach alerts active until acknowledged or resolved, and fire them within 1 second of boundary crossing.
- Continuously check ship pairs and warn when any two ships are within 2 km.
- Pull real weather data from a free-tier service such as Open-Meteo or Stormglass. Apply a 30% fuel penalty when ships move through adverse weather.
- Compute routes through navigable water while avoiding operator-drawn restricted zones and the worst current weather when rerouting.
- If no valid path exists, mark the ship `stranded` and alert. If a ship starts inside a new zone, alert and attempt to route out. If fuel is insufficient for a new path, flag `insufficient fuel` but continue until fuel runs out.
- Save enough history for playback: the last hour of fleet positions and key events at 30-second resolution is sufficient.
- Document any required API keys, environment variables, and local startup assumptions in `README.md`.

Bonus ideas are lower priority and should only be attempted after the core works: multiple reroute options, ship-to-ship assistance, predictive alerts, and an AI fleet advisor.

## Build, Test, and Development Commands

Use pnpm because this repository includes `pnpm-lock.yaml`.

- `pnpm dev`: starts the local Next.js development server at `http://localhost:3000`.
- `pnpm build`: creates a production build and catches type/build issues.
- `pnpm start`: serves the production build after `pnpm build`.
- `pnpm lint`: runs ESLint with Next.js Core Web Vitals and TypeScript rules.

The finished system must run end-to-end on a laptop for judging. Do not introduce required cloud infrastructure that cannot be reproduced locally.

## Coding Style & Naming Conventions

Write TypeScript and React function components. Keep files and components focused: route files stay in `app/`, reusable UI should be split into clearly named components when the page grows. Use two-space indentation, double quotes, semicolons, and typed exports where helpful. Prefer Tailwind utility classes for styling, with shared design tokens in `app/globals.css`. The `@/*` path alias maps to the repository root.

For simulator and geospatial code, prefer well-named pure functions for distance checks, polygon containment, route validation, fuel burn, and status transitions. Keep units explicit in names or types where practical, especially for knots, kilometers, milliseconds, tons of fuel, and `[lat, lng]` coordinates.

## Data, State, and Assumptions

Hard-coded data is acceptable only where the brief explicitly allows it, such as basemap tiles or the provided fixed fleet scenario in `public/fleet.json`. Ship data after startup, alerts, directives, captain responses, weather effects, AI/NLP outputs, and playback history must be generated or updated live by the system.

When the brief does not specify behavior, document the assumption in `README.md` or close to the relevant implementation. Documented assumptions will be honored; undocumented assumptions may be judged against the strictest reasonable interpretation.

## UI/UX Guidelines

Design for an operational command interface, not a marketing page. Prioritize dense, scannable status, clear map interaction, low-latency feedback, and obvious alert severity. The first screen should be the usable fleet experience.

Make role boundaries visible in the UI:

- Command: full-fleet map, directives, restricted-zone drawing/editing, alert acknowledgement, playback controls.
- Captain: single-ship status, received directives, accept/escalate response flow, distress message input, visible restricted zones.

Alerts should be easy to triage by severity, source, timestamp, affected ship or ships, and acknowledgement state. Critical alerts must remain noticeable without blocking the operator from acting.

## Testing Guidelines

No dedicated test framework is configured yet. Until one is added, verify changes with `pnpm lint` and `pnpm build`.

For meaningful feature work, also manually verify the core flow in the browser: fleet updates, multi-viewer sync, map rendering, restricted-zone drawing, alert firing, captain response, distress extraction, and playback. Add focused tests when implementing reusable simulator, geospatial, routing, or alert-priority logic. Future tests should live near the code they cover with names like `Component.test.tsx`, and React Testing Library is preferred for UI behavior.

## Commit & Pull Request Guidelines

Recent commit history uses short, imperative summaries such as `initialize project` and `removed svgs and added project guide and fleet.json`. Keep commits concise and action-oriented. Pull requests should include a brief description, verification steps run, linked issues when applicable, and screenshots or screen recordings for visible UI changes.

## Agent-Specific Instructions

Do not commit generated build output such as `.next/` or `node_modules/`. Keep changes scoped to the requested feature or fix, and avoid rewriting unrelated project configuration. When adding dependencies, update `package.json` and `pnpm-lock.yaml` together.

Before implementing large features, reread `public/WEB DEVELOPMENT PROBLEM STATEMENT.pdf` and `public/fleet.json` so simulator behavior, grading constraints, and fixed scenario data stay aligned with the brief.
