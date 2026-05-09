import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import type { LatLng } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isLatLng(value: unknown): value is LatLng {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    name?: string;
    polygon?: unknown[];
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.polygon || body.polygon.length < 3 || !body.polygon.every(isLatLng)) {
    return NextResponse.json({ error: "Restricted zones need at least three [lat,lng] points." }, { status: 400 });
  }

  const snapshot = getSimulatorStore().dispatch({
    type: "create_zone",
    name: body.name ?? "Restricted Zone",
    polygon: body.polygon,
  });

  return NextResponse.json(snapshot);
}
