import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as {
    alertId?: string;
  };

  if (!body.alertId) {
    return NextResponse.json({ error: "Missing alertId." }, { status: 400 });
  }

  const snapshot = getSimulatorStore().dispatch({
    type: "ack_alert",
    alertId: body.alertId,
  });

  return NextResponse.json(snapshot);
}
