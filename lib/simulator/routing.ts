import { haversineDistanceKm, pointInPolygon } from "@/lib/geo";
import { BASE_FUEL_TONS_PER_KM, resolveWeatherMultiplier } from "@/lib/simulator/core";
import type { LatLng, RestrictedZone, RouteOption, RoutePlan, WeatherSample } from "@/lib/domain";

type GraphNode = {
  id: string;
  position: LatLng;
};

const SEGMENT_SAMPLES = 24;
const WEATHER_COST_WEIGHT = 0.45;

const ROUTE_COST_PROFILES = {
  fastest: 0,
  balanced: 0.45,
  fuel_efficient: 2.0,
} as const;

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

  // Interior waypoints for the Strait of Hormuz channel — the navigable
  // polygon is too sparse here, so Dijkstra needs explicit mid-channel nodes.
  // Bypass nodes around each seeded restricted zone are also included so the
  // router has guaranteed-clear corridors on every side of each zone.
  const interiorNodes: LatLng[] = [
    // ── North channel through the Strait of Hormuz (Iranian side) ────────
    [26.50, 56.00], // pre-strait approach from west
    [26.45, 56.25], // bypass south of Qeshm zone (26.65–27.05 N)
    [26.42, 56.50], // north channel central passage (above Musandam)
    [26.38, 56.75], // north channel eastern section
    [26.30, 56.55], // Gulf of Oman entry (north)
    [26.20, 56.62], // Gulf of Oman west (north lane)
    [26.10, 56.70], // Gulf of Oman mid
    [25.90, 56.75], // Gulf of Oman south

    // ── South channel through the Strait (below Musandam peninsula) ──────
    [25.60, 55.95], // south channel approach from west
    [25.55, 56.25], // south channel mid (below Musandam zone)
    [25.60, 56.55], // south channel east (clear of Musandam)

    // ── Bypass south of Hormuz Military Exclusion (starts at lng 56.40) ──
    [26.60, 56.00], // west of Qeshm zone (moved south from 26.80 which was inside Qeshm)
    [26.75, 56.50], // below Hormuz zone centre
    [26.75, 57.00], // below Hormuz zone eastern edge

    // ── Bypass around Abu Musa zone (25.72–26.05 N, 54.88–55.22 E) ──────
    [26.10, 54.80], // north-west of Abu Musa
    [26.10, 55.30], // north-east of Abu Musa
    [25.60, 54.80], // south-west of Abu Musa (stays in open Gulf)
    [25.60, 55.30], // south-east of Abu Musa

    // ── Bypass around Farsi Island zone (26.3–26.85 N, 53.85–54.5 E) ────
    [26.20, 53.75], // south-west of Farsi zone
    [26.20, 54.55], // south-east of Farsi zone
    [26.90, 53.75], // north-west of Farsi zone
    [26.90, 54.55], // north-east of Farsi zone
  ];
  interiorNodes.forEach((point, index) => {
    nodes.push({ id: `interior-${index}`, position: point });
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

function computeRoutePlanWithCostWeight(
  args: Parameters<typeof computeRoutePlan>[0],
  weatherCostWeight: number,
): RoutePlan {
  // Temporarily override the segment cost function by injecting weight via closure
  // We rebuild edges using a local cost function instead of the module-level WEATHER_COST_WEIGHT
  const activeZones = args.restrictedZones.filter((zone) => zone.active);
  const startInsideZones = activeZones.filter((zone) => pointInPolygon(args.start, zone.polygon));
  const destinationInsideBlockedZone = activeZones.some((zone) =>
    pointInPolygon(args.destination, zone.polygon),
  );

  if (
    !pointInPolygon(args.start, args.navigableWater) ||
    !pointInPolygon(args.destination, args.navigableWater) ||
    destinationInsideBlockedZone
  ) {
    return computeRoutePlan(args);
  }

  const nodes: Array<{ id: string; position: LatLng }> = [
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

  const interiorNodes: LatLng[] = [
    [26.50, 56.00], [26.45, 56.25], [26.42, 56.50], [26.38, 56.75],
    [26.30, 56.55], [26.20, 56.62], [26.10, 56.70], [25.90, 56.75],
    [25.60, 55.95], [25.55, 56.25], [25.60, 56.55],
    [26.60, 56.00], [26.75, 56.50], [26.75, 57.00],
    [26.10, 54.80], [26.10, 55.30], [25.60, 54.80], [25.60, 55.30],
    [26.20, 53.75], [26.20, 54.55], [26.90, 53.75], [26.90, 54.55],
  ];
  interiorNodes.forEach((point, index) => {
    nodes.push({ id: `interior-${index}`, position: point });
  });

  if (startInsideZones.length > 0) {
    startInsideZones.forEach((zone, index) => {
      const exit = nearestExitPoint(args.start, zone, args.navigableWater);
      if (exit) nodes.push({ id: `exit-${index}`, position: exit });
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
      if (isSegmentNavigable(a.position, b.position, args.navigableWater, activeZones, allowStartEscape)) {
        const distanceKm = haversineDistanceKm(a.position, b.position);
        const weatherMultiplier = segmentWeatherMultiplier(a.position, b.position, args.weatherSamples ?? []);
        const weight = distanceKm * (1 + (weatherMultiplier - 1) * weatherCostWeight);
        if (!edges.has(a.id)) edges.set(a.id, []);
        if (!edges.has(b.id)) edges.set(b.id, []);
        edges.get(a.id)?.push({ to: b.id, weight });
        edges.get(b.id)?.push({ to: a.id, weight });
      }
    }
  }

  const pathNodeIds = shortestPath(nodes, edges);
  if (pathNodeIds.length === 0) {
    return computeRoutePlan(args);
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const waypoints = pathNodeIds
    .map((id) => nodeById.get(id)?.position)
    .filter((p): p is LatLng => Boolean(p));
  const distanceKm = waypoints.reduce((total, wp, i) => {
    if (i === 0) return total;
    return total + haversineDistanceKm(waypoints[i - 1], wp);
  }, 0);
  const samples = args.weatherSamples ?? [];
  const hasAdverse = routeHasAdverseWeather(waypoints, samples);
  const avgMultiplier =
    samples.length === 0
      ? 1
      : waypoints.reduce((sum, pt) => sum + resolveWeatherMultiplier(pt, samples), 0) / waypoints.length;

  return {
    shipId: args.shipId,
    waypoints,
    distanceKm,
    estimatedFuelTons: estimateRouteFuel(distanceKm, avgMultiplier),
    weatherExposure: hasAdverse ? "adverse" : "clear",
    valid: true,
  };
}

export function computeRouteOptions(args: Parameters<typeof computeRoutePlan>[0]): RouteOption[] {
  const options: Array<{ label: RouteOption["label"]; weight: number }> = [
    { label: "fastest", weight: ROUTE_COST_PROFILES.fastest },
    { label: "balanced", weight: ROUTE_COST_PROFILES.balanced },
    { label: "fuel_efficient", weight: ROUTE_COST_PROFILES.fuel_efficient },
  ];

  return options.map(({ label, weight }) => {
    const plan = computeRoutePlanWithCostWeight(args, weight);
    const km = Math.round(plan.distanceKm);
    const fuel = Math.round(plan.estimatedFuelTons);
    const weather = plan.weatherExposure === "adverse" ? "adverse weather" : "clear skies";

    let tradeoffSummary = "";
    if (label === "fastest") {
      tradeoffSummary = `${km} km · ${fuel} t fuel · ${weather}. Shortest path; ignores weather cost.`;
    } else if (label === "balanced") {
      tradeoffSummary = `${km} km · ${fuel} t fuel · ${weather}. Default routing; mild weather avoidance.`;
    } else {
      tradeoffSummary = `${km} km · ${fuel} t fuel · ${weather}. Longer path; avoids adverse weather corridors.`;
    }

    return { ...plan, label, tradeoffSummary };
  });
}
