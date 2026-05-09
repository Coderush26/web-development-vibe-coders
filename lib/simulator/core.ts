import { haversineDistanceKm, knotsToKmPerSecond } from "../geo.ts";
import type { LatLng, RoutePlan, ShipStatus, WeatherSample } from "../domain.ts";

export const SIM_TICK_MS = 1000;
export const BASE_FUEL_TONS_PER_KM = 0.08;
export const INSUFFICIENT_FUEL_BUFFER = 1.1;
export const HISTORY_INTERVAL_MS = 30_000;
export const HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const ADVERSE_WEATHER_RADIUS_KM = 75;

const stoppedStatuses = new Set<ShipStatus>(["arrived", "out_of_fuel", "stranded", "stopped"]);

export function isStoppedStatus(status: ShipStatus): boolean {
  return stoppedStatuses.has(status);
}

export function calculateRouteDistanceKm(waypoints: LatLng[]): number {
  return waypoints.reduce((distanceKm, waypoint, index) => {
    if (index === 0) {
      return distanceKm;
    }

    return distanceKm + haversineDistanceKm(waypoints[index - 1], waypoint);
  }, 0);
}

export function estimateFuelForDistance(distanceKm: number, multiplier = 1): number {
  return distanceKm * BASE_FUEL_TONS_PER_KM * multiplier;
}

export function calculateFuelBurnTons(distanceKm: number, weatherMultiplier: number): number {
  return estimateFuelForDistance(distanceKm, weatherMultiplier);
}

export function resolveWeatherMultiplier(
  position: LatLng,
  weatherSamples: WeatherSample[],
): number {
  if (weatherSamples.length === 0) {
    return 1;
  }

  const nearbyAdverseSample = weatherSamples.find(
    (sample) =>
      sample.adverse && haversineDistanceKm(position, sample.position) <= ADVERSE_WEATHER_RADIUS_KM,
  );

  return nearbyAdverseSample?.fuelMultiplier ?? 1;
}

export function calculateFuelLimitedDistanceKm(fuelTons: number, weatherMultiplier: number): number {
  if (weatherMultiplier <= 0) {
    return 0;
  }

  return fuelTons / (BASE_FUEL_TONS_PER_KM * weatherMultiplier);
}

export function calculateTickMovementBudgetKm(args: {
  speedKnots: number;
  deltaSeconds: number;
  fuelTons: number;
  weatherMultiplier: number;
}): number {
  const timeLimitedDistanceKm = knotsToKmPerSecond(args.speedKnots) * args.deltaSeconds;
  const fuelLimitedDistanceKm = calculateFuelLimitedDistanceKm(args.fuelTons, args.weatherMultiplier);

  return Math.max(0, Math.min(timeLimitedDistanceKm, fuelLimitedDistanceKm));
}

export function estimateDirectRoute(shipId: string, from: LatLng, to: LatLng): RoutePlan {
  const waypoints = [from, to];
  const distanceKm = calculateRouteDistanceKm(waypoints);

  return {
    shipId,
    waypoints,
    distanceKm,
    estimatedFuelTons: estimateFuelForDistance(distanceKm),
    weatherExposure: "clear",
    valid: true,
  };
}

export function updateRemainingRoute(args: {
  route: RoutePlan;
  currentPosition: LatLng;
  activeWaypointIndex: number;
  fallbackDestination: LatLng;
  weatherMultiplier: number;
}): RoutePlan {
  const remainingWaypoints =
    args.route.valid && args.route.waypoints.length >= 2
      ? args.route.waypoints.slice(
          Math.min(Math.max(1, args.activeWaypointIndex), args.route.waypoints.length - 1),
        )
      : [args.fallbackDestination];
  const waypoints = [args.currentPosition, ...remainingWaypoints];
  const distanceKm = calculateRouteDistanceKm(waypoints);

  return {
    ...args.route,
    waypoints,
    distanceKm,
    estimatedFuelTons: estimateFuelForDistance(distanceKm, args.weatherMultiplier),
  };
}

export function hasInsufficientFuel(args: {
  fuelTons: number;
  estimatedRouteFuelTons: number;
}): boolean {
  return args.fuelTons < args.estimatedRouteFuelTons * INSUFFICIENT_FUEL_BUFFER;
}

export function resolveMovingStatus(args: {
  currentStatus: ShipStatus;
  canMove: boolean;
  remainingFuelTons: number;
  inNavigableWater: boolean;
  hasInsufficientFuel: boolean;
}): ShipStatus {
  if (args.currentStatus === "arrived") {
    return "arrived";
  }

  if (args.remainingFuelTons <= 0 && args.canMove) {
    return "out_of_fuel";
  }

  if (!args.inNavigableWater) {
    return "stranded";
  }

  if (args.currentStatus === "distressed" || args.currentStatus === "stopped") {
    return args.currentStatus;
  }

  if (args.canMove && args.hasInsufficientFuel) {
    return "insufficient_fuel";
  }

  return "normal";
}
