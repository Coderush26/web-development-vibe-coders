import "server-only";

import {
  bearingDegrees,
  clampToBoundingBox,
  haversineDistanceKm,
  movePosition,
  pointInPolygon,
} from "@/lib/geo";
import { getFleetSeed } from "@/lib/fleet-seed";
import {
  calculateFuelBurnTons,
  calculateTickMovementBudgetKm,
  estimateDirectRoute,
  hasInsufficientFuel,
  HISTORY_INTERVAL_MS,
  HISTORY_WINDOW_MS,
  isStoppedStatus,
  resolveMovingStatus,
  SIM_TICK_MS,
  updateRemainingRoute,
} from "@/lib/simulator/core";
import type {
  Alert,
  AlertSeverity,
  CaptainResponse,
  Directive,
  DirectiveType,
  DistressAnalysis,
  HistorySnapshot,
  LatLng,
  RestrictedZone,
  ShipState,
  SimulatorCommand,
  SimulatorSnapshot,
  WeatherSample,
} from "@/lib/domain";

type Listener = (snapshot: SimulatorSnapshot) => void;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function analyzeDistressMessage(message: string): DistressAnalysis {
  const normalized = message.toLowerCase();
  const impacts: Record<string, number | string> = {};
  const numberMatch = normalized.match(/\b(\d{1,4})\b/);

  if (numberMatch) {
    impacts.reportedCount = Number(numberMatch[1]);
  }

  const category =
    normalized.includes("fire") || normalized.includes("burn")
      ? "fire"
      : normalized.includes("engine") || normalized.includes("propulsion")
        ? "engine_failure"
        : normalized.includes("flood") || normalized.includes("water")
          ? "flooding"
          : normalized.includes("injur") || normalized.includes("medical")
            ? "medical"
            : normalized.includes("cargo") || normalized.includes("spill")
              ? "cargo_damage"
              : "unknown";

  const severity: AlertSeverity =
    normalized.includes("mayday") ||
    normalized.includes("critical") ||
    normalized.includes("fire") ||
    normalized.includes("sinking") ||
    normalized.includes("explosion")
      ? "critical"
      : normalized.includes("urgent") ||
          normalized.includes("injur") ||
          normalized.includes("engine") ||
          normalized.includes("flood")
        ? "warning"
        : "info";

  if (category !== "unknown") {
    impacts.problem = category;
  }

  return {
    severity,
    problemCategory: category,
    impacts,
    confidence: category === "unknown" ? 0.45 : 0.78,
    source: "local_rules",
  };
}

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
  private timer?: NodeJS.Timeout;
  private lastTickAt = Date.now();
  private lastHistoryAt = 0;

  constructor() {
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
        currentRoute: estimateDirectRoute(ship.shipId, ship.position, destination.position),
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

    this.start();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), SIM_TICK_MS);
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
      boundingBox: this.seed.boundingBox,
      navigableWater: this.seed.navigableWater,
      ports: this.seed.ports,
      ships: this.ships,
      restrictedZones: this.restrictedZones,
      alerts: this.alerts,
      directives: this.directives,
      weatherSamples: this.weatherSamples,
      history: this.history,
      metrics: {
        connectedViewers: this.connectedViewers,
        tickHz: 1000 / SIM_TICK_MS,
        activeShips: this.ships.length,
      },
    };
  }

  dispatch(command: SimulatorCommand): SimulatorSnapshot {
    if (command.type === "issue_directive") {
      this.issueDirective(command.targetShipId, command.directiveType, command.payload);
    }

    if (command.type === "captain_response") {
      this.recordCaptainResponse(command.directiveId, command.responseType, command.distressMessage);
    }

    if (command.type === "create_zone") {
      this.createRestrictedZone(command.name, command.polygon);
    }

    if (command.type === "ack_alert") {
      this.acknowledgeAlert(command.alertId);
    }

    this.broadcast();
    return this.snapshot();
  }

  private tick(): void {
    const now = Date.now();
    const deltaSeconds = Math.max(0.25, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    this.tickCount += 1;

    this.applyQueuedAcceptedDirectives();
    this.ships = this.ships.map((ship) => this.advanceShip(ship, deltaSeconds, now));
    this.checkProximity();
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
    const routeWaypoints =
      ship.currentRoute.valid && ship.currentRoute.waypoints.length >= 2
        ? ship.currentRoute.waypoints
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
          weatherMultiplier: ship.weatherMultiplier,
        })
      : 0;
    const distanceKm = Math.min(movementBudgetKm, distanceToWaypointKm || distanceToDestinationKm);
    const movedPosition = clampToBoundingBox(
      movePosition(ship.position, headingDegrees, distanceKm),
      this.seed.boundingBox,
    );
    const inNavigableWater = pointInPolygon(movedPosition, this.seed.navigableWater);
    const nextPosition = inNavigableWater ? movedPosition : ship.position;
    const actualDistanceKm = inNavigableWater ? distanceKm : 0;
    const fuelBurn = calculateFuelBurnTons(actualDistanceKm, ship.weatherMultiplier);
    const remainingFuel = Math.max(0, ship.fuelTons - fuelBurn);
    const nextWaypointIndex =
      distanceToWaypointKm <= Math.max(distanceKm, 0.5)
        ? Math.min(waypointIndex + 1, routeWaypoints.length - 1)
        : waypointIndex;
    const remainingRoute = updateRemainingRoute({
      route: ship.currentRoute,
      currentPosition: nextPosition,
      activeWaypointIndex: nextWaypointIndex,
      fallbackDestination: destination.position,
      weatherMultiplier: ship.weatherMultiplier,
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

  private recordCaptainResponse(
    directiveId: string,
    responseType: "ACCEPT" | "ESCALATE_DISTRESS",
    distressMessage?: string,
  ): void {
    const directive = this.directives.find((candidate) => candidate.id === directiveId);

    if (!directive) {
      return;
    }

    const ship = this.ships.find((candidate) => candidate.id === directive.targetShipId);

    if (!ship) {
      return;
    }

    const distressAnalysis =
      responseType === "ESCALATE_DISTRESS" && distressMessage
        ? analyzeDistressMessage(distressMessage)
        : undefined;
    const response: CaptainResponse = {
      directiveId,
      shipId: ship.id,
      responseType,
      distressMessage,
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
        `${ship.name} escalated distress: ${distressMessage ?? "No details supplied."}`,
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
        return { ...ship, status: "normal", speedKnots: Math.max(ship.cruisingSpeedKnots, 1) };
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

        return {
          ...ship,
          destinationPortId,
          status: "rerouting",
          currentRoute: estimateDirectRoute(ship.id, ship.position, destination.position),
          activeWaypointIndex: 1,
        };
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

        return { ...ship, status: "rerouting" };
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
    this.history.unshift({
      timestamp: now,
      shipPositions: this.ships.map((ship) => ({
        shipId: ship.id,
        position: ship.position,
        status: ship.status,
        fuelTons: ship.fuelTons,
      })),
      keyEvents: this.keyEvents.splice(0, this.keyEvents.length),
      activeAlertCount: this.alerts.filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt).length,
      restrictedZoneCount: this.restrictedZones.filter((zone) => zone.active).length,
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
