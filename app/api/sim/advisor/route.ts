import { NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import { getFleetAdvisorRecommendations } from "@/lib/simulator/advisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const snapshot = getSimulatorStore().snapshot();
  const recommendations = await getFleetAdvisorRecommendations(snapshot);
  return NextResponse.json({ recommendations, source: process.env.XAI_API_KEY ? "grok" : "local_rules" });
}
