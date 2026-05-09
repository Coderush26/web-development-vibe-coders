import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import type { CaptainResponseType } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as {
    directiveId?: string;
    responseType?: CaptainResponseType;
    distressMessage?: string;
  };

  if (
    !body.directiveId ||
    (body.responseType !== "ACCEPT" && body.responseType !== "ESCALATE_DISTRESS")
  ) {
    return NextResponse.json({ error: "Invalid captain response payload." }, { status: 400 });
  }

  const snapshot = getSimulatorStore().dispatch({
    type: "captain_response",
    directiveId: body.directiveId,
    responseType: body.responseType,
    distressMessage: body.distressMessage,
  });

  return NextResponse.json(snapshot);
}
