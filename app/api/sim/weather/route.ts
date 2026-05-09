export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSimulatorStore } from "@/lib/simulator/store";
import { fetchWeatherSamples } from "@/lib/simulator/weather";

export async function POST(): Promise<NextResponse> {
  try {
    const samples = await fetchWeatherSamples();
    const store = getSimulatorStore();
    const snapshot = await store.dispatch({ type: "update_weather", samples });
    return NextResponse.json({ ok: true, sampleCount: samples.length, snapshot });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
