import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    alertId?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.alertId) {
    return NextResponse.json({ error: "Missing alertId." }, { status: 400 });
  }

  const snapshot = await getSimulatorStore().dispatch({
    type: "ack_alert",
    alertId: body.alertId,
  });

  return NextResponse.json(snapshot);
}
