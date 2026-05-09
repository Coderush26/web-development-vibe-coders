import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import { computeRouteOptions } from "@/lib/simulator/routing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const shipId = request.nextUrl.searchParams.get("shipId");
  if (!shipId) {
    return NextResponse.json({ error: "shipId query param required." }, { status: 400 });
  }

  const store = getSimulatorStore();
  const snapshot = store.snapshot();
  const ship = snapshot.ships.find((s) => s.id === shipId);
  if (!ship) {
    return NextResponse.json({ error: "Ship not found." }, { status: 404 });
  }

  const destination = snapshot.ports.find((p) => p.id === ship.destinationPortId);
  if (!destination) {
    return NextResponse.json({ error: "Ship destination port not found." }, { status: 404 });
  }

  const options = computeRouteOptions({
    shipId,
    start: ship.position,
    destination: destination.position,
    navigableWater: snapshot.navigableWater,
    restrictedZones: snapshot.restrictedZones,
    weatherSamples: snapshot.weatherSamples,
  });

  return NextResponse.json({ options });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    shipId?: string;
    waypoints?: [number, number][];
    distanceKm?: number;
    estimatedFuelTons?: number;
    weatherExposure?: string;
    routeLabel?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.shipId || !body.waypoints || body.waypoints.length < 2) {
    return NextResponse.json({ error: "shipId and waypoints required." }, { status: 400 });
  }

  const snapshot = await getSimulatorStore().dispatch({
    type: "select_route",
    shipId: body.shipId,
    waypoints: body.waypoints as [number, number][],
    distanceKm: body.distanceKm ?? 0,
    estimatedFuelTons: body.estimatedFuelTons ?? 0,
    weatherExposure: (body.weatherExposure ?? "clear") as "clear" | "adverse",
    routeLabel: body.routeLabel ?? "custom",
  });

  return NextResponse.json(snapshot);
}
