import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import type { AssistanceType } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const assistanceTypes: AssistanceType[] = ["fuel_transfer", "medical_aid", "escort", "cargo_offload"];

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    assistingShipId?: string;
    targetShipId?: string;
    assistanceType?: AssistanceType;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.assistingShipId || !body.targetShipId || !body.assistanceType || !assistanceTypes.includes(body.assistanceType)) {
    return NextResponse.json({ error: "assistingShipId, targetShipId, and valid assistanceType required." }, { status: 400 });
  }

  if (body.assistingShipId === body.targetShipId) {
    return NextResponse.json({ error: "A ship cannot assist itself." }, { status: 400 });
  }

  const snapshot = await getSimulatorStore().dispatch({
    type: "request_assistance",
    assistingShipId: body.assistingShipId,
    targetShipId: body.targetShipId,
    assistanceType: body.assistanceType,
  });

  return NextResponse.json(snapshot);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  let body: { assistanceId?: string };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.assistanceId) {
    return NextResponse.json({ error: "assistanceId required." }, { status: 400 });
  }

  const snapshot = await getSimulatorStore().dispatch({
    type: "cancel_assistance",
    assistanceId: body.assistanceId,
  });

  return NextResponse.json(snapshot);
}
