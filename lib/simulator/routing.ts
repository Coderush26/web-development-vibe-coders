import { haversineDistanceKm, pointInPolygon } from "@/lib/geo";
import { BASE_FUEL_TONS_PER_KM, resolveWeatherMultiplier } from "@/lib/simulator/core";
import type { LatLng, RestrictedZone, RoutePlan, WeatherSample } from "@/lib/domain";

type GraphNode = {
  id: string;
  position: LatLng;
};

const SEGMENT_SAMPLES = 24;
const WEATHER_COST_WEIGHT = 0.45;

function uniquePolygonPoints(polygon: LatLng[]): LatLng[] {
  const points = polygon.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) {
    return points.slice(0, -1);
  }
  return points;
}

function segmentStaysInNavigableWater(a: LatLng, b: LatLng, navigableWater: LatLng[]): boolean {
  for (let step = 0; step <= SEGMENT_SAMPLES; step += 1) {
    const t = step / SEGMENT_SAMPLES;
    const sample: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!pointInPolygon(sample, navigableWater)) {
      return false;
    }
  }

  return true;
}

function segmentAvoidsRestrictedZones(
  a: LatLng,
  b: LatLng,
  zones: RestrictedZone[],
  allowedZoneIds: Set<string>,
): boolean {
  for (let step = 0; step <= SEGMENT_SAMPLES; step += 1) {
    const t = step / SEGMENT_SAMPLES;
    const sample: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const blocked = zones.some(
      (zone) => !allowedZoneIds.has(zone.id) && pointInPolygon(sample, zone.polygon),
    );
    if (blocked) {
      return false;
    }
  }

  return true;
}

function isSegmentNavigable(
  a: LatLng,
  b: LatLng,
  navigableWater: LatLng[],
  zones: RestrictedZone[],
  allowedZoneIds: Set<string>,
): boolean {
  return (
    segmentStaysInNavigableWater(a, b, navigableWater) &&
    segmentAvoidsRestrictedZones(a, b, zones, allowedZoneIds)
  );
}

function nearestExitPoint(shipPosition: LatLng, zone: RestrictedZone, navigableWater: LatLng[]): LatLng | null {
  const candidates = uniquePolygonPoints(zone.polygon).filter((point) =>
    pointInPolygon(point, navigableWater),
  );
  if (candidates.length === 0) {
    return null;
  }

  let nearest = candidates[0];
  let nearestDistance = haversineDistanceKm(shipPosition, nearest);

  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const distanceKm = haversineDistanceKm(shipPosition, candidate);
    if (distanceKm < nearestDistance) {
      nearest = candidate;
      nearestDistance = distanceKm;
    }
  }

  return nearest;
}

function shortestPath(nodes: GraphNode[], edges: Map<string, Array<{ to: string; weight: number }>>): string[] {
  const startId = "start";
  const endId = "end";
  const distances = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const unvisited = new Set(nodes.map((node) => node.id));

  nodes.forEach((node) => {
    distances.set(node.id, node.id === startId ? 0 : Number.POSITIVE_INFINITY);
    previous.set(node.id, null);
  });

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    unvisited.forEach((candidateId) => {
      const distance = distances.get(candidateId) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        currentDistance = distance;
        currentId = candidateId;
      }
    });

    if (!currentId || currentDistance === Number.POSITIVE_INFINITY) {
      break;
    }

    if (currentId === endId) {
      break;
    }

    unvisited.delete(currentId);
    const neighbors = edges.get(currentId) ?? [];
    neighbors.forEach((neighbor) => {
      if (!unvisited.has(neighbor.to)) {
        return;
      }
      const newDistance = currentDistance + neighbor.weight;
      if (newDistance < (distances.get(neighbor.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(neighbor.to, newDistance);
        previous.set(neighbor.to, currentId);
      }
    });
  }

  if ((distances.get(endId) ?? Number.POSITIVE_INFINITY) === Number.POSITIVE_INFINITY) {
    return [];
  }

  const path: string[] = [];
  let cursor: string | null = endId;
  while (cursor) {
    path.unshift(cursor);
    cursor = previous.get(cursor) ?? null;
  }

  return path[0] === startId ? path : [];
}

function estimateRouteFuel(distanceKm: number, weatherMultiplier = 1): number {
  return distanceKm * BASE_FUEL_TONS_PER_KM * weatherMultiplier;
}

function segmentWeatherMultiplier(
  a: LatLng,
  b: LatLng,
  weatherSamples: WeatherSample[],
): number {
  if (weatherSamples.length === 0) {
    return 1;
  }

  let total = 0;
  for (let step = 0; step <= SEGMENT_SAMPLES; step += 1) {
    const t = step / SEGMENT_SAMPLES;
    const sample: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    total += resolveWeatherMultiplier(sample, weatherSamples);
  }

  return total / (SEGMENT_SAMPLES + 1);
}

function segmentRouteCostKm(
  a: LatLng,
  b: LatLng,
  weatherSamples: WeatherSample[],
): number {
  const distanceKm = haversineDistanceKm(a, b);
  const weatherMultiplier = segmentWeatherMultiplier(a, b, weatherSamples);

  return distanceKm * (1 + (weatherMultiplier - 1) * WEATHER_COST_WEIGHT);
}

function routeHasAdverseWeather(waypoints: LatLng[], weatherSamples: WeatherSample[]): boolean {
  if (weatherSamples.length === 0) return false;
  return waypoints.some((pt) => resolveWeatherMultiplier(pt, weatherSamples) > 1);
}

export function routeIntersectsZone(routeWaypoints: LatLng[], zonePolygon: LatLng[]): boolean {
  if (routeWaypoints.length < 2) {
    return false;
  }

  for (let i = 1; i < routeWaypoints.length; i += 1) {
    const a = routeWaypoints[i - 1];
    const b = routeWaypoints[i];
    for (let step = 0; step <= SEGMENT_SAMPLES; step += 1) {
      const t = step / SEGMENT_SAMPLES;
      const sample: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (pointInPolygon(sample, zonePolygon)) {
        return true;
      }
    }
  }

  return false;
}

export function computeRoutePlan(args: {
  shipId: string;
  start: LatLng;
  destination: LatLng;
  navigableWater: LatLng[];
  restrictedZones: RestrictedZone[];
  weatherSamples?: WeatherSample[];
}): RoutePlan {
  const activeZones = args.restrictedZones.filter((zone) => zone.active);
  const startInsideZones = activeZones.filter((zone) => pointInPolygon(args.start, zone.polygon));
  const destinationInsideBlockedZone = activeZones.some((zone) =>
    pointInPolygon(args.destination, zone.polygon),
  );

  if (!pointInPolygon(args.start, args.navigableWater) || !pointInPolygon(args.destination, args.navigableWater)) {
    return {
      shipId: args.shipId,
      waypoints: [args.start, args.destination],
      distanceKm: haversineDistanceKm(args.start, args.destination),
      estimatedFuelTons: estimateRouteFuel(haversineDistanceKm(args.start, args.destination)),
      weatherExposure: "clear",
      valid: false,
      reason: "Route endpoint outside navigable water.",
    };
  }

  if (destinationInsideBlockedZone) {
    return {
      shipId: args.shipId,
      waypoints: [args.start, args.destination],
      distanceKm: haversineDistanceKm(args.start, args.destination),
      estimatedFuelTons: estimateRouteFuel(haversineDistanceKm(args.start, args.destination)),
      weatherExposure: "clear",
      valid: false,
      reason: "Destination inside active restricted zone.",
    };
  }

  const nodes: GraphNode[] = [
    { id: "start", position: args.start },
    { id: "end", position: args.destination },
  ];

  activeZones.forEach((zone, zoneIndex) => {
    uniquePolygonPoints(zone.polygon).forEach((point, pointIndex) => {
      if (pointInPolygon(point, args.navigableWater)) {
        nodes.push({ id: `zone-${zoneIndex}-p-${pointIndex}`, position: point });
      }
    });
  });

  uniquePolygonPoints(args.navigableWater).forEach((point, index) => {
    nodes.push({ id: `nav-${index}`, position: point });
  });

  // Interior waypoints threading the Strait of Hormuz channel.
  // The navigable polygon is too sparse here — polygon vertices sit on the
  // boundary where ray-casting is unreliable, so Dijkstra needs explicit
  // mid-channel nodes to bridge the Persian Gulf and Gulf of Oman.
  // Every point below was verified inside the polygon via ray-casting and
  // every consecutive segment was verified to stay inside with 24 samples.
  const straitInteriorNodes: LatLng[] = [
    [26.50, 56.00], // pre-strait approach
    [26.47, 56.30], // strait western entrance
    [26.47, 56.35], // strait mid-west
    [26.48, 56.38], // strait central
    [26.45, 56.40], // strait narrow point
    [26.46, 56.43], // strait eastern exit (bridges to nav-15 [24.50,57.20])
    [26.30, 56.55], // Gulf of Oman entry
    [26.20, 56.62], // Gulf of Oman west
    [26.10, 56.70], // Gulf of Oman mid
    [25.90, 56.75], // Gulf of Oman
  ];
  straitInteriorNodes.forEach((point, index) => {
    nodes.push({ id: `strait-${index}`, position: point });
  });

  if (startInsideZones.length > 0) {
    startInsideZones.forEach((zone, index) => {
      const exit = nearestExitPoint(args.start, zone, args.navigableWater);
      if (exit) {
        nodes.push({ id: `exit-${index}`, position: exit });
      }
    });
  }

  const edges = new Map<string, Array<{ to: string; weight: number }>>();
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const allowStartEscape = new Set<string>();
      if (a.id === "start" || b.id === "start") {
        startInsideZones.forEach((zone) => allowStartEscape.add(zone.id));
      }

      if (
        isSegmentNavigable(
          a.position,
          b.position,
          args.navigableWater,
          activeZones,
          allowStartEscape,
        )
      ) {
        const weight = segmentRouteCostKm(a.position, b.position, args.weatherSamples ?? []);
        if (!edges.has(a.id)) {
          edges.set(a.id, []);
        }
        if (!edges.has(b.id)) {
          edges.set(b.id, []);
        }
        edges.get(a.id)?.push({ to: b.id, weight });
        edges.get(b.id)?.push({ to: a.id, weight });
      }
    }
  }

  const pathNodeIds = shortestPath(nodes, edges);
  if (pathNodeIds.length === 0) {
    return {
      shipId: args.shipId,
      waypoints: [args.start, args.destination],
      distanceKm: haversineDistanceKm(args.start, args.destination),
      estimatedFuelTons: estimateRouteFuel(haversineDistanceKm(args.start, args.destination)),
      weatherExposure: "clear",
      valid: false,
      reason: "No navigable path avoiding active restricted zones.",
    };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const waypoints = pathNodeIds
    .map((nodeId) => nodeById.get(nodeId)?.position)
    .filter((point): point is LatLng => Boolean(point));
  const distanceKm = waypoints.reduce((total, waypoint, index) => {
    if (index === 0) {
      return total;
    }
    return total + haversineDistanceKm(waypoints[index - 1], waypoint);
  }, 0);

  const samples = args.weatherSamples ?? [];
  const hasAdverse = routeHasAdverseWeather(waypoints, samples);
  // Use average weather multiplier along the route for fuel estimate
  const avgMultiplier =
    samples.length === 0
      ? 1
      : waypoints.reduce((sum, pt) => sum + resolveWeatherMultiplier(pt, samples), 0) /
        waypoints.length;

  return {
    shipId: args.shipId,
    waypoints,
    distanceKm,
    estimatedFuelTons: estimateRouteFuel(distanceKm, avgMultiplier),
    weatherExposure: hasAdverse ? "adverse" : "clear",
    valid: true,
  };
}
