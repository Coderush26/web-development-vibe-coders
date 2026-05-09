import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import type { CaptainResponseType } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    directiveId?: string;
    shipId?: string;
    responseType?: CaptainResponseType;
    distressMessage?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    !body.directiveId ||
    !body.shipId ||
    (body.responseType !== "ACCEPT" && body.responseType !== "ESCALATE_DISTRESS")
  ) {
    return NextResponse.json({ error: "Invalid captain response payload." }, { status: 400 });
  }

  const current = getSimulatorStore().snapshot();
  const directive = current.directives.find((candidate) => candidate.id === body.directiveId);

  if (!directive || directive.targetShipId !== body.shipId) {
    return NextResponse.json({ error: "Directive is not scoped to this captain ship." }, { status: 403 });
  }

  const snapshot = await getSimulatorStore().dispatch({
    type: "captain_response",
    directiveId: body.directiveId,
    responseType: body.responseType,
    distressMessage: body.distressMessage,
  });

  return NextResponse.json(snapshot);
}
