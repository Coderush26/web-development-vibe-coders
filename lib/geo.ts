import type { BoundingBox, LatLng } from "./domain";

const EARTH_RADIUS_KM = 6371;
const KM_PER_NAUTICAL_MILE = 1.852;
const DEFAULT_SEGMENT_SAMPLES = 64;

// The seed water polygon is intentionally coarse; this prevents Gulf of Oman
// routes from cutting across the UAE/Oman land bridge instead of using the strait.
const COASTAL_LAND_EXCLUSIONS: LatLng[][] = [
  [
    [24.2, 55.0],
    [25.15, 55.4],
    [25.45, 56.0],
    [25.45, 56.35],
    [24.55, 56.55],
    [24.1, 55.8],
    [24.2, 55.0],
  ],
  [
    [24.35, 56.45],
    [24.9, 56.3],
    [25.25, 56.05],
    [25.55, 56.25],
    [25.62, 56.52],
    [25.42, 56.72],
    [24.75, 56.68],
    [24.35, 56.45],
  ],
  [
    [24.65, 56.62],
    [25.55, 56.45],
    [26.1, 56.5],
    [26.18, 56.85],
    [25.9, 57.05],
    [24.75, 57.02],
    [24.65, 56.62],
  ],
];

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function knotsToKmPerSecond(knots: number): number {
  return (knots * KM_PER_NAUTICAL_MILE) / 3600;
}

export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b[0] - a[0]);
  const dLng = toRadians(b[1] - a[1]);
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(value));
}

export function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from[0]);
  const lat2 = toRadians(to[0]);
  const dLng = toRadians(to[1] - from[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function movePosition(start: LatLng, headingDegrees: number, distanceKm: number): LatLng {
  const bearing = toRadians(headingDegrees);
  const lat1 = toRadians(start[0]);
  const lng1 = toRadians(start[1]);
  const angularDistance = distanceKm / EARTH_RADIUS_KM;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [toDegrees(lat2), ((toDegrees(lng2) + 540) % 360) - 180];
}

export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  const [lat, lng] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersects =
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

export function isPointInCoastalLandExclusion(point: LatLng): boolean {
  return COASTAL_LAND_EXCLUSIONS.some((polygon) => pointInPolygon(point, polygon));
}

export function isNavigableWaterPoint(point: LatLng, navigableWater: LatLng[]): boolean {
  return pointInPolygon(point, navigableWater) && !isPointInCoastalLandExclusion(point);
}

export function segmentStaysInNavigableWater(
  a: LatLng,
  b: LatLng,
  navigableWater: LatLng[],
  samples = DEFAULT_SEGMENT_SAMPLES,
): boolean {
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const sample: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!isNavigableWaterPoint(sample, navigableWater)) {
      return false;
    }
  }

  return true;
}

export function clampToBoundingBox(point: LatLng, box: BoundingBox): LatLng {
  return [
    Math.min(box.north, Math.max(box.south, point[0])),
    Math.min(box.east, Math.max(box.west, point[1])),
  ];
}

export function interpolateLatLng(from: LatLng, to: LatLng, progress: number): LatLng {
  const safeProgress = Math.min(1, Math.max(0, progress));
  return [
    from[0] + (to[0] - from[0]) * safeProgress,
    from[1] + (to[1] - from[1]) * safeProgress,
  ];
}

export function polygonCentroid(polygon: LatLng[]): LatLng {
  const sum = polygon.reduce<LatLng>(
    (acc, point) => [acc[0] + point[0], acc[1] + point[1]],
    [0, 0],
  );

  return [sum[0] / polygon.length, sum[1] / polygon.length];
}
