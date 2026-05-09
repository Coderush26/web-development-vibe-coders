import { NextRequest, NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import type { DirectiveType } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const directiveTypes: DirectiveType[] = [
  "HOLD_POSITION",
  "RESUME_COURSE",
  "CHANGE_SPEED",
  "REROUTE_PORT",
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as {
    targetShipId?: string;
    directiveType?: DirectiveType;
    payload?: Record<string, string | number | boolean>;
  };

  if (!body.targetShipId || !body.directiveType || !directiveTypes.includes(body.directiveType)) {
    return NextResponse.json({ error: "Invalid directive payload." }, { status: 400 });
  }

  const snapshot = getSimulatorStore().dispatch({
    type: "issue_directive",
    targetShipId: body.targetShipId,
    directiveType: body.directiveType,
    payload: body.payload ?? {},
  });

  return NextResponse.json(snapshot);
}
