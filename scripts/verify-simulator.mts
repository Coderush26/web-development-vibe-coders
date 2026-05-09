import {
  calculateFuelBurnTons,
  calculateRouteDistanceKm,
  calculateTickMovementBudgetKm,
  estimateDirectRoute,
  hasInsufficientFuel,
  isStoppedStatus,
  resolveMovingStatus,
  updateRemainingRoute,
} from "../lib/simulator/core.ts";
import {
  bearingDegrees,
  haversineDistanceKm,
  isNavigableWaterPoint,
  movePosition,
  segmentStaysInNavigableWater,
} from "../lib/geo.ts";
import type { FleetSeed, LatLng, ShipState } from "../lib/domain.ts";
import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}. Expected ${expected}, got ${actual}.`);
  }
}

const start: LatLng = [26.55, 56.2];
const waypoint: LatLng = [26.3, 56.6];
const destination: LatLng = [23.92, 58.58];
const route = estimateDirectRoute("MV-1", start, destination);

assert(route.valid, "Direct route should be valid.");
assert(route.waypoints.length === 2, "Direct route should include start and destination.");
assert(route.distanceKm > 300, "Direct route distance should be realistic for Hormuz to Muscat.");

const multiWaypointDistance = calculateRouteDistanceKm([start, waypoint, destination]);
assert(
  multiWaypointDistance > route.distanceKm,
  "Route distance should include intermediate waypoint legs.",
);

const oneSecondBudget = calculateTickMovementBudgetKm({
  speedKnots: 14,
  deltaSeconds: 1,
  fuelTons: 100,
  weatherMultiplier: 1,
});
assertClose(oneSecondBudget, 0.007202, 0.0001, "14 knots should advance roughly 0.0072 km/sec.");

const fuelLimitedBudget = calculateTickMovementBudgetKm({
  speedKnots: 20,
  deltaSeconds: 60,
  fuelTons: 0.01,
  weatherMultiplier: 1,
});
assertClose(fuelLimitedBudget, 0.125, 0.001, "Movement should be limited by available fuel.");

const adverseFuelBurn = calculateFuelBurnTons(10, 1.3);
assertClose(adverseFuelBurn, 1.04, 0.001, "Adverse weather should apply 30 percent fuel penalty.");

const remainingRoute = updateRemainingRoute({
  route: {
    ...route,
    waypoints: [start, waypoint, destination],
    distanceKm: multiWaypointDistance,
  },
  currentPosition: waypoint,
  activeWaypointIndex: 2,
  fallbackDestination: destination,
  weatherMultiplier: 1,
});
assert(remainingRoute.waypoints[0] === waypoint, "Remaining route should begin at current position.");
assert(
  remainingRoute.distanceKm < multiWaypointDistance,
  "Remaining route distance should shrink after passing a waypoint.",
);

assert(
  hasInsufficientFuel({ fuelTons: 10, estimatedRouteFuelTons: 10 }),
  "Fuel buffer should flag marginal routes as insufficient.",
);
assert(
  !hasInsufficientFuel({ fuelTons: 12, estimatedRouteFuelTons: 10 }),
  "Fuel buffer should allow sufficiently fueled routes.",
);

assert(
  resolveMovingStatus({
    currentStatus: "normal",
    canMove: true,
    remainingFuelTons: 0,
    inNavigableWater: true,
    hasInsufficientFuel: false,
  }) === "out_of_fuel",
  "Out-of-fuel status should outrank normal movement.",
);
assert(
  resolveMovingStatus({
    currentStatus: "distressed",
    canMove: true,
    remainingFuelTons: 10,
    inNavigableWater: true,
    hasInsufficientFuel: false,
  }) === "distressed",
  "Distressed status should persist until an explicit command changes it.",
);

const fleetSeed = JSON.parse(readFileSync("public/fleet.json", "utf8")) as FleetSeed;
assert(fleetSeed.fleet.length === 15, "Canonical fleet seed must contain exactly 15 ships.");

assert(
  !segmentStaysInNavigableWater([24.55, 56.9], [25.25, 56.15], fleetSeed.navigableWater),
  "Routes from Sohar toward the Gulf must not cut across the UAE/Oman landmass.",
);
assert(
  !segmentStaysInNavigableWater([24.56, 56.9], [25.6, 56.55], fleetSeed.navigableWater),
  "Routes from Sohar must not cut across the Fujairah/Oman coastal land strip.",
);
assert(
  segmentStaysInNavigableWater([25.55, 56.82], [25.6, 56.55], fleetSeed.navigableWater),
  "Routes from Sohar should still be able to approach the Strait by open water.",
);
assert(
  segmentStaysInNavigableWater([24.56, 56.9], [24.9, 56.95], fleetSeed.navigableWater),
  "Routes from Sohar should still be able to depart into the offshore lane.",
);

const ships: ShipState[] = fleetSeed.fleet.map((ship) => {
  const port = fleetSeed.ports.find((candidate) => candidate.id === ship.destination);
  if (!port) {
    throw new Error(`Ship ${ship.shipId} destination should exist.`);
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
    currentRoute: estimateDirectRoute(ship.shipId, ship.position, port.position),
    activeWaypointIndex: 1,
    lastUpdateAt: 0,
    weatherMultiplier: 1,
  };
});

const advancedShips = ships.map((ship) => {
  const port = fleetSeed.ports.find((candidate) => candidate.id === ship.destinationPortId);
  if (!port) {
    throw new Error(`Ship ${ship.id} destination should exist after initialization.`);
  }

  const heading = bearingDegrees(ship.position, port.position);
  const movementBudgetKm = isStoppedStatus(ship.status)
    ? 0
    : calculateTickMovementBudgetKm({
        speedKnots: ship.speedKnots,
        deltaSeconds: 10,
        fuelTons: ship.fuelTons,
        weatherMultiplier: ship.weatherMultiplier,
      });
  const nextPosition = movePosition(ship.position, heading, movementBudgetKm);
  const inNavigableWater = isNavigableWaterPoint(nextPosition, fleetSeed.navigableWater);
  const actualDistanceKm = inNavigableWater ? haversineDistanceKm(ship.position, nextPosition) : 0;
  const remainingFuel = ship.fuelTons - calculateFuelBurnTons(actualDistanceKm, ship.weatherMultiplier);

  return {
    ...ship,
    previousPosition: ship.position,
    position: inNavigableWater ? nextPosition : ship.position,
    headingDegrees: heading,
    fuelTons: remainingFuel,
  };
});

assert(
  advancedShips.every((ship) => Number.isFinite(ship.position[0]) && Number.isFinite(ship.position[1])),
  "All advanced ship positions should remain finite.",
);
assert(
  advancedShips.some((ship, index) => haversineDistanceKm(ship.position, ships[index].position) > 0),
  "At least one active ship should move over a 10-second simulation window.",
);
assert(
  advancedShips.every((ship) => ship.fuelTons <= ships.find((initial) => initial.id === ship.id)!.fuelTons),
  "Fuel should never increase during simulator advancement.",
);

console.log("Simulator core checks passed.");
