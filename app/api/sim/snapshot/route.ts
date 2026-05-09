import { NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): NextResponse {
  return NextResponse.json(getSimulatorStore().snapshot());
}
