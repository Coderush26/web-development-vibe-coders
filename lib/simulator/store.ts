import "server-only";

import {
  bearingDegrees,
  clampToBoundingBox,
  haversineDistanceKm,
  isNavigableWaterPoint,
  movePosition,
  pointInPolygon,
} from "@/lib/geo";
import { getFleetSeed } from "@/lib/fleet-seed";
import {
  calculateFuelBurnTons,
  calculateTickMovementBudgetKm,
  hasInsufficientFuel,
  HISTORY_INTERVAL_MS,
  HISTORY_WINDOW_MS,
  isStoppedStatus,
  resolveWeatherMultiplier,
  resolveMovingStatus,
  SIM_TICK_MS,
  updateRemainingRoute,
} from "@/lib/simulator/core";
import { analyzeDistressMessage, formatDistressAnalysis } from "@/lib/simulator/distress";
import { computeRoutePlan, routeIntersectsZone, routeIsNavigable } from "@/lib/simulator/routing";
import { estimateDirectRoute } from "@/lib/simulator/core";
import { fetchWeatherSamples } from "@/lib/simulator/weather";
import type {
  Alert,
  AlertSeverity,
  CaptainResponse,
  Directive,
  DirectiveType,
  HistorySnapshot,
  LatLng,
  RestrictedZone,
  ShipAssistance,
  ShipState,
  SimulatorCommand,
  SimulatorSnapshot,
  WeatherSample,
} from "@/lib/domain";

type Listener = (snapshot: SimulatorSnapshot) => void;

// Refresh weather from Open-Meteo every 10 minutes
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// How many seconds ahead to project ships for predictive alerts
const PREDICTIVE_HORIZON_SECONDS = 300;
// Minimum fuel remaining ratio below which predictive shortfall fires
const PREDICTIVE_FUEL_RATIO = 0.15;
// Completion range for ship-to-ship assistance (km)
const ASSISTANCE_COMPLETION_KM = 2.5;
// Fuel transferred per assistance completion (tons)
const FUEL_TRANSFER_TONS = 500;

export class SimulatorStore {
  private readonly seed = getFleetSeed();
  private ships: ShipState[];
  private restrictedZones: RestrictedZone[] = [];
  private alerts: Alert[] = [];
  private directives: Directive[] = [];
  private pendingDirectiveIds = new Set<string>();
  private weatherSamples: WeatherSample[] = [];
  private history: HistorySnapshot[] = [];
  private keyEvents: string[] = [];
  private listeners = new Set<Listener>();
  private tickCount = 0;
  private stateVersion = 0;
  private timer?: NodeJS.Timeout;
  private weatherTimer?: NodeJS.Timeout;
  private lastTickAt = Date.now();
  private lastHistoryAt = 0;
  private assistanceMissions: ShipAssistance[] = [];

  constructor() {
    // Zones MUST be seeded before ships so initial routes can avoid them.
    this.seedRestrictedZones();

    this.ships = this.seed.fleet.map((ship) => {
      const destination = this.seed.ports.find((port) => port.id === ship.destination);

      if (!destination) {
        throw new Error(`Ship ${ship.shipId} points at unknown destination ${ship.destination}.`);
      }

      return {
        id: ship.shipId,
        name: ship.name,
        position: ship.position,
        previousPosition: ship.position,
        speedKnots: ship.speed,
        cruisingSpeedKnots: ship.speed,
        headingDegrees: ship.heading,
        destinationPortId: ship.destination,
        fuelTons: ship.fuel,
        cargo: ship.cargo,
        status: ship.status,
        currentRoute: computeRoutePlan({
          shipId: ship.shipId,
          start: ship.position,
          destination: destination.position,
          navigableWater: this.seed.navigableWater,
          restrictedZones: this.restrictedZones,   // now populated
          weatherSamples: this.weatherSamples,
        }),
        activeWaypointIndex: 1,
        lastUpdateAt: Date.now(),
        weatherMultiplier: 1,
      };
    });

    this.weatherSamples = [
      {
        id: "initial-clear",
        position: [26.3, 56.2],
        timestamp: Date.now(),
        adverse: false,
        summary: "Weather provider not connected yet; local clear sample active.",
        fuelMultiplier: 1,
      },
    ];

    // Now that ships exist, check which start inside a seeded zone.
    this.checkInitialZoneBreaches();
    this.start();
  }

  private seedRestrictedZones(): void {
    const now = Date.now();

    // Zone 1 — Hormuz Strait Iranian Military Zone
    // Covers the eastern Hormuz strait and Larak Island area.
    // Western boundary kept east of Bandar Abbas port (lng 56.27) so the port remains accessible.
    this.restrictedZones.push({
      id: "seed-zone-hormuz",
      name: "Hormuz Military Exclusion",
      polygon: [
        [26.88, 56.40],
        [27.30, 56.35],
        [27.72, 56.40],
        [27.68, 57.25],
        [27.30, 57.50],
        [27.00, 57.15],
        [26.88, 56.65],
        [26.88, 56.40],
      ] as LatLng[],
      createdBy: "command",
      createdAt: now,
      updatedAt: now,
      active: true,
      editable: true,
    });

    // Zone 5 — Musandam Peninsula (land barrier)
    // The Musandam peninsula (Oman) juts north into the strait. Ships must route around it
    // via the northern channel (Iranian waters) or the southern channel (UAE/Oman side).
    this.restrictedZones.push({
      id: "seed-zone-musandam",
      name: "Musandam Peninsula",
      polygon: [
        [26.05, 55.92],
        [26.20, 56.20],
        [26.00, 56.42],
        [25.78, 56.35],
        [25.72, 55.95],
        [26.05, 55.92],
      ] as LatLng[],
      createdBy: "command",
      createdAt: now,
      updatedAt: now,
      active: true,
      editable: false,
    });

    // Zone 2 — Qeshm Island Exclusion Zone
    // Qeshm Island (~26.85°N 55.9°E) is an Iranian strategic island used for naval operations.
    // Ships approaching from the west must route south of this zone.
    this.restrictedZones.push({
      id: "seed-zone-qeshm",
      name: "Qeshm Island Exclusion",
      polygon: [
        [26.65, 55.5 ],
        [27.05, 55.5 ],
        [27.05, 56.1 ],
        [26.65, 56.1 ],
        [26.65, 55.5 ],
      ] as LatLng[],
      createdBy: "command",
      createdAt: now,
      updatedAt: now,
      active: true,
      editable: true,
    });

    // Zone 3 — Abu Musa Disputed Island Zone
    // Abu Musa (~25.87°N 55.03°E) is a disputed island claimed by both Iran and UAE.
    // Vessels must maintain distance from this contested area.
    this.restrictedZones.push({
      id: "seed-zone-abumusa",
      name: "Abu Musa Restricted Area",
      polygon: [
        [25.72, 54.88],
        [26.05, 54.88],
        [26.05, 55.22],
        [25.72, 55.22],
        [25.72, 54.88],
      ] as LatLng[],
      createdBy: "command",
      createdAt: now,
      updatedAt: now,
      active: true,
      editable: true,
    });

    // Zone 4 — Farsi Island Patrol Zone (Central Gulf)
    // Iranian-held Farsi Island area. Marks the central Gulf hazard corridor
    // where several ships (Gharial, Cygnus, Kite) are currently transiting.
    this.restrictedZones.push({
      id: "seed-zone-farsi",
      name: "Farsi Island Patrol Zone",
      polygon: [
        [26.3, 53.85],
        [26.85, 53.85],
        [26.85, 54.5 ],
        [26.3,  54.5 ],
        [26.3,  53.85],
      ] as LatLng[],
      createdBy: "command",
      createdAt: now,
      updatedAt: now,
      active: true,
      editable: true,
    });

  }

  private checkInitialZoneBreaches(): void {
    for (const zone of this.restrictedZones) {
      for (const ship of this.ships) {
        if (pointInPolygon(ship.position, zone.polygon)) {
          this.upsertAlert(
            "restricted_zone_breach",
            "critical",
            [ship.id],
            `${ship.name} is inside ${zone.name} at scenario start.`,
            this.breachSourceId(ship.id, zone.id),
          );
        }
      }
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), SIM_TICK_MS);

    // Initial weather fetch on startup (non-blocking)
    this.refreshWeather();
    this.weatherTimer = setInterval(() => this.refreshWeather(), WEATHER_REFRESH_MS);
  }

  private refreshWeather(): void {
    fetchWeatherSamples()
      .then((samples) => {
        if (samples.length > 0) {
          this.weatherSamples = samples;
          this.stateVersion += 1;
          this.broadcast();
        }
      })
      .catch(() => {
        // Keep existing samples if fetch fails — sim continues with last known data
      });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  get connectedViewers(): number {
    return this.listeners.size;
  }

  snapshot(): SimulatorSnapshot {
    return {
      scenarioName: this.seed.scenario.name,
      serverTime: Date.now(),
      tick: this.tickCount,
      stateVersion: this.stateVersion,
      boundingBox: this.seed.boundingBox,
      navigableWater: this.seed.navigableWater,
      ports: this.seed.ports,
      ships: this.ships,
      restrictedZones: this.restrictedZones,
      alerts: this.alerts,
      directives: this.directives,
      weatherSamples: this.weatherSamples,
      history: this.history,
      assistanceMissions: this.assistanceMissions,
      metrics: {
        connectedViewers: this.connectedViewers,
        tickHz: 1000 / SIM_TICK_MS,
        activeShips: this.ships.length,
      },
    };
  }

  async dispatch(command: SimulatorCommand): Promise<SimulatorSnapshot> {
    if (command.type === "issue_directive") {
      this.issueDirective(command.targetShipId, command.directiveType, command.payload);
    }

    if (command.type === "captain_response") {
      await this.recordCaptainResponse(command.directiveId, command.responseType, command.distressMessage);
    }

    if (command.type === "create_zone") {
      this.createRestrictedZone(command.name, command.polygon);
    }

    if (command.type === "update_zone") {
      this.updateRestrictedZone(command.zoneId, command.name, command.polygon);
    }

    if (command.type === "set_zone_active") {
      this.setZoneActive(command.zoneId, command.active);
    }

    if (command.type === "ack_alert") {
      this.acknowledgeAlert(command.alertId);
    }

    if (command.type === "update_weather") {
      this.weatherSamples = command.samples;
    }

    if (command.type === "select_route") {
      this.applySelectedRoute(command.shipId, command.waypoints, command.distanceKm, command.estimatedFuelTons, command.weatherExposure as "clear" | "adverse", command.routeLabel);
    }

    if (command.type === "request_assistance") {
      this.requestAssistance(command.assistingShipId, command.targetShipId, command.assistanceType);
    }

    if (command.type === "cancel_assistance") {
      this.cancelAssistance(command.assistanceId);
    }

    this.stateVersion += 1;
    this.broadcast();
    return this.snapshot();
  }

  private tick(): void {
    const now = Date.now();
    const deltaSeconds = Math.max(0.25, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    this.tickCount += 1;
    this.stateVersion += 1;

    this.applyQueuedAcceptedDirectives();
    this.ships = this.ships.map((ship) => this.advanceShip(ship, deltaSeconds, now));
    this.processAssistanceMissions(now);
    this.checkProximity();
    this.checkPredictiveAlerts();
    this.captureHistory(now);
    this.broadcast();
  }

  private advanceShip(ship: ShipState, deltaSeconds: number, now: number): ShipState {
    const destination = this.seed.ports.find((port) => port.id === ship.destinationPortId);

    if (!destination) {
      return ship;
    }

    const distanceToDestinationKm = haversineDistanceKm(ship.position, destination.position);

    if (distanceToDestinationKm < 1) {
      this.upsertAlert(
        "arrival",
        "info",
        [ship.id],
        `${ship.name} arrived at ${destination.name}.`,
        `arrival:${ship.id}:${destination.id}`,
      );

      return {
        ...ship,
        previousPosition: ship.position,
        speedKnots: 0,
        status: "arrived",
        activeWaypointIndex: Math.max(ship.activeWaypointIndex, ship.currentRoute.waypoints.length - 1),
        lastUpdateAt: now,
      };
    }

    if (ship.fuelTons <= 0) {
      this.upsertAlert(
        "out_of_fuel",
        "critical",
        [ship.id],
        `${ship.name} is out of fuel and stopped.`,
        `out_of_fuel:${ship.id}`,
      );

      return {
        ...ship,
        previousPosition: ship.position,
        speedKnots: 0,
        fuelTons: 0,
        status: "out_of_fuel",
        lastUpdateAt: now,
      };
    }

    const canMove = !isStoppedStatus(ship.status);
    const weatherMultiplier = resolveWeatherMultiplier(ship.position, this.weatherSamples);
    const currentRouteStillNavigable =
      ship.currentRoute.valid &&
      routeIsNavigable({
        waypoints: ship.currentRoute.waypoints,
        navigableWater: this.seed.navigableWater,
        restrictedZones: this.restrictedZones,
      });
    const activeRoute = currentRouteStillNavigable
      ? ship.currentRoute
      : computeRoutePlan({
          shipId: ship.id,
          start: ship.position,
          destination: destination.position,
          navigableWater: this.seed.navigableWater,
          restrictedZones: this.restrictedZones,
          weatherSamples: this.weatherSamples,
        });
    const routeWaypoints =
      activeRoute.valid && activeRoute.waypoints.length >= 2
        ? activeRoute.waypoints
        : [ship.position, destination.position];
    const waypointIndex = Math.min(Math.max(1, ship.activeWaypointIndex), routeWaypoints.length - 1);
    const targetWaypoint = routeWaypoints[waypointIndex] ?? destination.position;
    const distanceToWaypointKm = haversineDistanceKm(ship.position, targetWaypoint);
    const headingDegrees = canMove ? bearingDegrees(ship.position, targetWaypoint) : ship.headingDegrees;
    const movementBudgetKm = canMove
      ? calculateTickMovementBudgetKm({
          speedKnots: ship.speedKnots,
          deltaSeconds,
          fuelTons: ship.fuelTons,
          weatherMultiplier,
        })
      : 0;
    const distanceKm = Math.min(movementBudgetKm, distanceToWaypointKm || distanceToDestinationKm);
    const movedPosition = clampToBoundingBox(
      movePosition(ship.position, headingDegrees, distanceKm),
      this.seed.boundingBox,
    );
    const inNavigableWater = isNavigableWaterPoint(movedPosition, this.seed.navigableWater);
    const nextPosition = inNavigableWater ? movedPosition : ship.position;
    const actualDistanceKm = inNavigableWater ? distanceKm : 0;
    const fuelBurn = calculateFuelBurnTons(actualDistanceKm, weatherMultiplier);
    const remainingFuel = Math.max(0, ship.fuelTons - fuelBurn);
    const nextWaypointIndex =
      distanceToWaypointKm <= Math.max(distanceKm, 0.5)
        ? Math.min(waypointIndex + 1, routeWaypoints.length - 1)
        : waypointIndex;
    const remainingRoute = updateRemainingRoute({
      route: activeRoute,
      currentPosition: nextPosition,
      activeWaypointIndex: nextWaypointIndex,
      fallbackDestination: destination.position,
      weatherMultiplier,
    });
    const nextHasInsufficientFuel = hasInsufficientFuel({
      fuelTons: remainingFuel,
      estimatedRouteFuelTons: remainingRoute.estimatedFuelTons,
    });
    const status = resolveMovingStatus({
      currentStatus: ship.status === "rerouting" ? "normal" : ship.status,
      canMove,
      remainingFuelTons: remainingFuel,
      inNavigableWater,
      hasInsufficientFuel: nextHasInsufficientFuel,
    });

    if (status === "out_of_fuel") {
      ship = { ...ship, speedKnots: 0 };
      this.upsertAlert(
        "out_of_fuel",
        "critical",
        [ship.id],
        `${ship.name} is out of fuel and stopped.`,
        `out_of_fuel:${ship.id}`,
      );
    } else {
      this.resolveAlert(`out_of_fuel:${ship.id}`);
    }

    if (status === "stranded") {
      ship = { ...ship, speedKnots: 0 };
      this.upsertAlert(
        "stranded",
        "critical",
        [ship.id],
        `${ship.name} cannot advance without leaving navigable water.`,
        `stranded:${ship.id}`,
      );
    } else {
      this.resolveAlert(`stranded:${ship.id}`);
    }

    if (status === "insufficient_fuel") {
      this.upsertAlert(
        "insufficient_fuel",
        "warning",
        [ship.id],
        `${ship.name} may not have enough fuel to reach ${destination.name}.`,
        `fuel:${ship.id}`,
      );
    } else {
      this.resolveAlert(`fuel:${ship.id}`);
    }

    this.syncRestrictedZoneAlerts(ship, nextPosition);

    return {
      ...ship,
      position: nextPosition,
      previousPosition: ship.position,
      headingDegrees,
      fuelTons: remainingFuel,
      speedKnots: isStoppedStatus(status) ? 0 : ship.speedKnots,
      status,
      currentRoute: remainingRoute,
      activeWaypointIndex: 1,
      lastUpdateAt: now,
      weatherMultiplier,
    };
  }

  private issueDirective(
    targetShipId: string,
    directiveType: DirectiveType,
    payload: Record<string, string | number | boolean>,
  ): void {
    const ship = this.ships.find((candidate) => candidate.id === targetShipId);

    if (!ship) {
      return;
    }

    this.directives.unshift({
      id: makeId("directive"),
      targetShipId,
      type: directiveType,
      payload,
      issuedBy: "command",
      issuedAt: Date.now(),
      status: "pending",
    });
    this.keyEvents.push(`Directive ${directiveType} issued to ${ship.name}.`);
  }

  private async recordCaptainResponse(
    directiveId: string,
    responseType: "ACCEPT" | "ESCALATE_DISTRESS",
    distressMessage?: string,
  ): Promise<void> {
    const directive = this.directives.find((candidate) => candidate.id === directiveId);

    if (!directive) {
      return;
    }

    const ship = this.ships.find((candidate) => candidate.id === directive.targetShipId);

    if (!ship) {
      return;
    }

    const normalizedDistressMessage = distressMessage?.trim();
    const distressAnalysis =
      responseType === "ESCALATE_DISTRESS" && normalizedDistressMessage
        ? await analyzeDistressMessage(normalizedDistressMessage)
        : undefined;
    const response: CaptainResponse = {
      directiveId,
      shipId: ship.id,
      responseType,
      distressMessage: normalizedDistressMessage,
      distressAnalysis,
      respondedAt: Date.now(),
    };

    directive.captainResponse = response;
    directive.status = responseType === "ACCEPT" ? "accepted" : "distress_escalated";

    if (responseType === "ACCEPT") {
      this.pendingDirectiveIds.add(directive.id);
      this.keyEvents.push(`${ship.name} accepted directive ${directive.type}; queued for next tick.`);
    } else {
      this.ships = this.ships.map((candidate) =>
        candidate.id === ship.id ? { ...candidate, status: "distressed" } : candidate,
      );
      this.upsertAlert(
        "distress_escalation",
        distressAnalysis?.severity ?? "warning",
        [ship.id],
        `${ship.name} escalated distress: ${
          normalizedDistressMessage ?? "No details supplied."
        }${
          distressAnalysis ? ` (${formatDistressAnalysis(distressAnalysis)})` : ""
        }`,
        `distress:${directive.id}`,
      );
      this.keyEvents.push(`${ship.name} escalated distress.`);
    }
  }

  private applyQueuedAcceptedDirectives(): void {
    if (this.pendingDirectiveIds.size === 0) {
      return;
    }

    const queuedDirectives = this.directives.filter((directive) => this.pendingDirectiveIds.has(directive.id));
    queuedDirectives.forEach((directive) => this.applyAcceptedDirective(directive));
    this.pendingDirectiveIds.clear();
  }

  private applyAcceptedDirective(directive: Directive): void {
    this.ships = this.ships.map((ship) => {
      if (ship.id !== directive.targetShipId) {
        return ship;
      }

      if (directive.type === "HOLD_POSITION") {
        return { ...ship, status: "stopped", speedKnots: 0 };
      }

      if (directive.type === "RESUME_COURSE") {
        return this.recomputeRouteForShip(
          {
            ...ship,
            status: "normal",
            speedKnots: Math.max(ship.cruisingSpeedKnots, 1),
          },
          "resumed course and recomputed route.",
        );
      }

      if (directive.type === "CHANGE_SPEED") {
        const speedKnots = Number(directive.payload.speedKnots);
        return Number.isFinite(speedKnots)
          ? {
              ...ship,
              status: "normal",
              speedKnots: Math.max(0, Math.min(28, speedKnots)),
              cruisingSpeedKnots: Math.max(0, Math.min(28, speedKnots)),
            }
          : ship;
      }

      if (directive.type === "REROUTE_PORT") {
        const destinationPortId = String(directive.payload.destinationPortId ?? ship.destinationPortId);
        const destination = this.seed.ports.find((port) => port.id === destinationPortId);

        if (!destination) {
          return ship;
        }

        return this.recomputeRouteForShip(
          {
          ...ship,
          destinationPortId,
          status: "rerouting",
          },
          `rerouted to ${destination.name}.`,
        );
      }

      return ship;
    });
  }

  private createRestrictedZone(name: string, polygon: LatLng[]): void {
    if (polygon.length < 3) {
      return;
    }

    const zone: RestrictedZone = {
      id: makeId("zone"),
      name: name.trim() || `Restricted Zone ${this.restrictedZones.length + 1}`,
      polygon,
      createdBy: "command",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      editable: true,
    };

    this.restrictedZones.unshift(zone);
    this.keyEvents.push(`${zone.name} created.`);

    this.ships = this.ships.map((ship) => {
      if (pointInPolygon(ship.position, polygon)) {
        this.upsertAlert(
          "restricted_zone_breach",
          "critical",
          [ship.id],
          `${ship.name} is already inside new zone ${zone.name}.`,
          this.breachSourceId(ship.id, zone.id),
        );

        return this.recomputeRouteForShip(
          { ...ship, status: "rerouting" },
          `${ship.name} forced reroute after entering ${zone.name}.`,
        );
      }

      if (routeIntersectsZone(ship.currentRoute.waypoints, polygon)) {
        return this.recomputeRouteForShip(
          { ...ship, status: "rerouting" },
          `${ship.name} route intersects ${zone.name}; auto-rerouting.`,
        );
      }

      return ship;
    });
  }

  private updateRestrictedZone(zoneId: string, name: string | undefined, polygon: LatLng[]): void {
    if (polygon.length < 3) {
      return;
    }

    const zone = this.restrictedZones.find((candidate) => candidate.id === zoneId);

    if (!zone || !zone.editable) {
      return;
    }

    zone.name = name?.trim() || zone.name;
    zone.polygon = polygon;
    zone.updatedAt = Date.now();
    this.keyEvents.push(`${zone.name} polygon updated.`);

    if (!zone.active) {
      return;
    }

    this.ships = this.ships.map((ship) => {
      const breachSourceId = this.breachSourceId(ship.id, zone.id);

      if (pointInPolygon(ship.position, polygon)) {
        this.upsertAlert(
          "restricted_zone_breach",
          "critical",
          [ship.id],
          `${ship.name} is inside edited zone ${zone.name}.`,
          breachSourceId,
        );

        return this.recomputeRouteForShip(
          { ...ship, status: "rerouting" },
          `${ship.name} forced reroute after ${zone.name} edit.`,
        );
      }

      this.resolveAlert(breachSourceId);

      if (routeIntersectsZone(ship.currentRoute.waypoints, polygon)) {
        return this.recomputeRouteForShip(
          { ...ship, status: "rerouting" },
          `${ship.name} route intersects edited ${zone.name}; auto-rerouting.`,
        );
      }

      return ship;
    });
  }

  private setZoneActive(zoneId: string, active: boolean): void {
    const zone = this.restrictedZones.find((candidate) => candidate.id === zoneId);

    if (!zone) {
      return;
    }

    zone.active = active;
    zone.updatedAt = Date.now();
    this.keyEvents.push(`${zone.name} ${active ? "activated" : "deactivated"}.`);

    if (!active) {
      const now = Date.now();
      this.alerts = this.alerts.map((alert) =>
        alert.sourceEventId.endsWith(`:${zone.id}`) && !alert.resolvedAt
          ? { ...alert, resolvedAt: now }
          : alert,
      );
      return;
    }

    this.ships = this.ships.map((ship) => {
      if (
        routeIntersectsZone(ship.currentRoute.waypoints, zone.polygon) ||
        pointInPolygon(ship.position, zone.polygon)
      ) {
        return this.recomputeRouteForShip(
          { ...ship, status: "rerouting" },
          `${ship.name} rerouted after ${zone.name} activation.`,
        );
      }
      return ship;
    });
  }

  private acknowledgeAlert(alertId: string): void {
    const now = Date.now();
    this.alerts = this.alerts.map((alert) =>
      alert.id === alertId ? { ...alert, acknowledgedAt: now } : alert,
    );
  }

  private checkProximity(): void {
    for (let i = 0; i < this.ships.length; i += 1) {
      for (let j = i + 1; j < this.ships.length; j += 1) {
        const a = this.ships[i];
        const b = this.ships[j];
        const distanceKm = haversineDistanceKm(a.position, b.position);

        if (distanceKm <= 2) {
          this.upsertAlert(
            "proximity_warning",
            "warning",
            [a.id, b.id],
            `${a.name} and ${b.name} are within ${distanceKm.toFixed(1)} km.`,
            `proximity:${a.id}:${b.id}`,
          );
        } else if (distanceKm >= 2.5) {
          this.resolveAlert(`proximity:${a.id}:${b.id}`);
        }
      }
    }
  }

  private syncRestrictedZoneAlerts(ship: ShipState, position: LatLng): void {
    this.restrictedZones
      .filter((zone) => zone.active)
      .forEach((zone) => {
        const sourceEventId = this.breachSourceId(ship.id, zone.id);

        if (pointInPolygon(position, zone.polygon)) {
          this.upsertAlert(
            "restricted_zone_breach",
            "critical",
            [ship.id],
            `${ship.name} is inside restricted zone ${zone.name}.`,
            sourceEventId,
          );
          return;
        }

        this.resolveAlert(sourceEventId);
      });
  }

  private breachSourceId(shipId: string, zoneId: string): string {
    return `breach:${shipId}:${zoneId}`;
  }

  private upsertAlert(
    type: Alert["type"],
    severity: AlertSeverity,
    affectedShipIds: string[],
    message: string,
    sourceEventId: string,
  ): void {
    const existing = this.alerts.find(
      (alert) => alert.sourceEventId === sourceEventId && !alert.resolvedAt,
    );

    if (existing) {
      return;
    }

    this.alerts.unshift({
      id: makeId("alert"),
      type,
      severity,
      affectedShipIds,
      message,
      createdAt: Date.now(),
      sourceEventId,
    });
    this.keyEvents.push(message);
  }

  private recomputeRouteForShip(ship: ShipState, eventMessage?: string): ShipState {
    const destination = this.seed.ports.find((port) => port.id === ship.destinationPortId);
    if (!destination) {
      return ship;
    }

    const nextRoute = computeRoutePlan({
      shipId: ship.id,
      start: ship.position,
      destination: destination.position,
      navigableWater: this.seed.navigableWater,
      restrictedZones: this.restrictedZones,
      weatherSamples: this.weatherSamples,
    });

    if (!nextRoute.valid) {
      this.upsertAlert(
        "stranded",
        "critical",
        [ship.id],
        `${ship.name} is stranded: ${nextRoute.reason ?? "No safe route available."}`,
        `stranded:${ship.id}`,
      );
      if (eventMessage) {
        this.keyEvents.push(eventMessage);
      }
      return {
        ...ship,
        status: "stranded",
        speedKnots: 0,
        currentRoute: nextRoute,
        activeWaypointIndex: 1,
      };
    }

    this.resolveAlert(`stranded:${ship.id}`);
    if (eventMessage) {
      this.keyEvents.push(eventMessage);
    }
    return {
      ...ship,
      currentRoute: nextRoute,
      activeWaypointIndex: 1,
    };
  }

  private applySelectedRoute(
    shipId: string,
    waypoints: LatLng[],
    distanceKm: number,
    estimatedFuelTons: number,
    weatherExposure: "clear" | "adverse",
    routeLabel: string,
  ): void {
    this.ships = this.ships.map((ship) => {
      if (ship.id !== shipId) return ship;
      return {
        ...ship,
        status: "rerouting",
        currentRoute: { shipId, waypoints, distanceKm, estimatedFuelTons, weatherExposure, valid: true },
        activeWaypointIndex: 1,
      };
    });
    const ship = this.ships.find((s) => s.id === shipId);
    if (ship) {
      this.keyEvents.push(`${ship.name} route set to ${routeLabel} option.`);
    }
  }

  private requestAssistance(assistingShipId: string, targetShipId: string, assistanceType: ShipAssistance["assistanceType"]): void {
    const assisting = this.ships.find((s) => s.id === assistingShipId);
    const target = this.ships.find((s) => s.id === targetShipId);
    if (!assisting || !target) return;

    // Cancel any existing active mission from the same assisting ship
    this.assistanceMissions = this.assistanceMissions.map((m) =>
      m.assistingShipId === assistingShipId && (m.status === "en_route" || m.status === "in_progress")
        ? { ...m, status: "cancelled" as const, completedAt: Date.now() }
        : m,
    );

    const mission: ShipAssistance = {
      id: makeId("assist"),
      assistingShipId,
      targetShipId,
      assistanceType,
      status: "en_route",
      createdAt: Date.now(),
      progressNote: `${assisting.name} en route to ${target.name}.`,
    };
    this.assistanceMissions.unshift(mission);
    this.keyEvents.push(`${assisting.name} dispatched to assist ${target.name} (${assistanceType.replace("_", " ")}).`);
  }

  private cancelAssistance(assistanceId: string): void {
    const mission = this.assistanceMissions.find((m) => m.id === assistanceId);
    if (!mission) return;
    mission.status = "cancelled";
    mission.completedAt = Date.now();
    const assisting = this.ships.find((s) => s.id === mission.assistingShipId);
    if (assisting) {
      // Return assisting ship to its original destination route
      this.ships = this.ships.map((s) =>
        s.id === mission.assistingShipId ? this.recomputeRouteForShip({ ...s, status: "rerouting" }, `${s.name} returned to assigned route.`) : s,
      );
    }
  }

  private processAssistanceMissions(now: number): void {
    for (const mission of this.assistanceMissions) {
      if (mission.status !== "en_route" && mission.status !== "in_progress") continue;

      const assisting = this.ships.find((s) => s.id === mission.assistingShipId);
      const target = this.ships.find((s) => s.id === mission.targetShipId);
      if (!assisting || !target) {
        mission.status = "cancelled";
        mission.completedAt = now;
        continue;
      }

      const distKm = haversineDistanceKm(assisting.position, target.position);

      if (distKm <= ASSISTANCE_COMPLETION_KM) {
        // Apply assistance effect
        this.ships = this.ships.map((s) => {
          if (s.id === mission.targetShipId) {
            if (mission.assistanceType === "fuel_transfer") {
              const transferred = Math.min(FUEL_TRANSFER_TONS, assisting.fuelTons * 0.4);
              return { ...s, fuelTons: s.fuelTons + transferred, status: s.status === "out_of_fuel" ? "normal" : s.status };
            }
            if (mission.assistanceType === "medical_aid" && s.status === "distressed") {
              return { ...s, status: "normal" };
            }
            if (mission.assistanceType === "escort") {
              // Escort: assisting ship tracks target each tick (handled below)
              return s;
            }
          }
          if (s.id === mission.assistingShipId && mission.assistanceType === "fuel_transfer") {
            const transferred = Math.min(FUEL_TRANSFER_TONS, s.fuelTons * 0.4);
            return { ...s, fuelTons: Math.max(0, s.fuelTons - transferred) };
          }
          return s;
        });

        if (mission.assistanceType !== "escort") {
          mission.status = "completed";
          mission.completedAt = now;
          mission.progressNote = `${assisting.name} completed ${mission.assistanceType.replace("_", " ")} for ${target.name}.`;
          this.keyEvents.push(mission.progressNote);
          this.upsertAlert("arrival", "info", [mission.assistingShipId, mission.targetShipId], mission.progressNote, `assist-complete:${mission.id}`);
          // Return assisting ship to its destination
          this.ships = this.ships.map((s) =>
            s.id === mission.assistingShipId ? this.recomputeRouteForShip({ ...s, status: "normal" }, undefined) : s,
          );
        } else {
          mission.status = "in_progress";
          mission.progressNote = `${assisting.name} escorting ${target.name}.`;
          // Escort: keep assisting ship routing toward target position
          const escortTarget = this.ships.find((s) => s.id === mission.targetShipId);
          if (escortTarget) {
            this.ships = this.ships.map((s) => {
              if (s.id !== mission.assistingShipId) return s;
              return {
                ...s,
                currentRoute: estimateDirectRoute(s.id, s.position, escortTarget.position),
                activeWaypointIndex: 1,
                status: "rerouting",
              };
            });
          }
        }
      } else {
        // En route — steer assisting ship toward target's current position
        const liveTarget = this.ships.find((s) => s.id === mission.targetShipId);
        if (liveTarget) {
          this.ships = this.ships.map((s) => {
            if (s.id !== mission.assistingShipId) return s;
            return {
              ...s,
              currentRoute: estimateDirectRoute(s.id, s.position, liveTarget.position),
              activeWaypointIndex: 1,
            };
          });
        }
        mission.progressNote = `${assisting.name} en route to ${target.name} — ${distKm.toFixed(1)} km away.`;
      }
    }
  }

  private checkPredictiveAlerts(): void {
    const activeZones = this.restrictedZones.filter((z) => z.active);

    for (const ship of this.ships) {
      if (ship.status === "stopped" || ship.status === "arrived" || ship.status === "out_of_fuel" || ship.status === "stranded") {
        this.resolveAlert(`pred-zone:${ship.id}`);
        this.resolveAlert(`pred-fuel:${ship.id}`);
        continue;
      }

      // Project position PREDICTIVE_HORIZON_SECONDS ahead
      const speedKmPerSec = (ship.speedKnots * 1.852) / 3600;
      const projectedDistKm = speedKmPerSec * PREDICTIVE_HORIZON_SECONDS;
      const projectedPos: LatLng = [
        ship.position[0] + (Math.cos((ship.headingDegrees * Math.PI) / 180) * projectedDistKm) / 111.32,
        ship.position[1] +
          (Math.sin((ship.headingDegrees * Math.PI) / 180) * projectedDistKm) /
            (111.32 * Math.cos((ship.position[0] * Math.PI) / 180)),
      ];

      // Check zone entry — sample 8 interpolated positions between now and projected
      const projSamples: LatLng[] = Array.from({ length: 8 }, (_, i) => {
        const t = (i + 1) / 8;
        return [
          ship.position[0] + (projectedPos[0] - ship.position[0]) * t,
          ship.position[1] + (projectedPos[1] - ship.position[1]) * t,
        ] as LatLng;
      });
      const predictedZone = activeZones.find((z) => {
        const alreadyBreaching = this.alerts.some(
          (a) => a.sourceEventId === this.breachSourceId(ship.id, z.id) && !a.resolvedAt,
        );
        return !alreadyBreaching && projSamples.some((pt) => pointInPolygon(pt, z.polygon));
      });

      if (predictedZone) {
        this.upsertAlert(
          "predictive_zone_entry",
          "warning",
          [ship.id],
          `${ship.name} projected to enter ${predictedZone.name} within ~${Math.round(PREDICTIVE_HORIZON_SECONDS / 60)} min at current heading.`,
          `pred-zone:${ship.id}`,
        );
      } else {
        this.resolveAlert(`pred-zone:${ship.id}`);
      }

      // Predictive fuel shortfall — will run dry before reaching destination
      const destination = this.seed.ports.find((p) => p.id === ship.destinationPortId);
      if (destination) {
        const fuelRatio = ship.fuelTons / Math.max(1, ship.currentRoute.estimatedFuelTons);
        if (fuelRatio < PREDICTIVE_FUEL_RATIO && ship.status !== "insufficient_fuel") {
          this.upsertAlert(
            "predictive_fuel_shortfall",
            "warning",
            [ship.id],
            `${ship.name} fuel critically low — only ${Math.round(fuelRatio * 100)}% of route fuel remaining. Shortfall imminent.`,
            `pred-fuel:${ship.id}`,
          );
        } else {
          this.resolveAlert(`pred-fuel:${ship.id}`);
        }
      }
    }
  }

  private resolveAlert(sourceEventId: string): void {
    const now = Date.now();
    this.alerts = this.alerts.map((alert) =>
      alert.sourceEventId === sourceEventId && !alert.resolvedAt
        ? { ...alert, resolvedAt: now }
        : alert,
    );
  }

  private captureHistory(now: number): void {
    if (now - this.lastHistoryAt < HISTORY_INTERVAL_MS) {
      return;
    }

    this.lastHistoryAt = now;
    const statusCounts = this.ships.reduce<Partial<Record<ShipState["status"], number>>>(
      (counts, ship) => ({
        ...counts,
        [ship.status]: (counts[ship.status] ?? 0) + 1,
      }),
      {},
    );

    this.history.unshift({
      timestamp: now,
      tick: this.tickCount,
      shipPositions: this.ships.map((ship) => ({
        shipId: ship.id,
        position: ship.position,
        status: ship.status,
        fuelTons: ship.fuelTons,
      })),
      keyEvents: this.keyEvents.splice(0, this.keyEvents.length),
      activeAlertCount: this.alerts.filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt).length,
      restrictedZoneCount: this.restrictedZones.filter((zone) => zone.active).length,
      statusCounts,
    });
    this.history = this.history.filter((snapshot) => now - snapshot.timestamp <= HISTORY_WINDOW_MS);
  }

  private broadcast(): void {
    if (this.listeners.size === 0) {
      return;
    }

    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

const globalForSimulator = globalThis as typeof globalThis & {
  __fleetSimulatorStore?: SimulatorStore;
};

export function getSimulatorStore(): SimulatorStore {
  if (!globalForSimulator.__fleetSimulatorStore) {
    globalForSimulator.__fleetSimulatorStore = new SimulatorStore();
  }

  return globalForSimulator.__fleetSimulatorStore;
}
