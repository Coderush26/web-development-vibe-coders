import "server-only";

import type { AdvisorRecommendation, ShipState, SimulatorSnapshot, WeatherSample } from "@/lib/domain";
import { haversineDistanceKm } from "@/lib/geo";
import { resolveWeatherMultiplier } from "@/lib/simulator/core";

function makeRecommendationId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nearestShipWithFuel(ship: ShipState, ships: ShipState[], minFuelTons: number): ShipState | null {
  let nearest: ShipState | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;

  for (const candidate of ships) {
    if (candidate.id === ship.id) continue;
    if (candidate.fuelTons < minFuelTons) continue;
    if (candidate.status === "out_of_fuel" || candidate.status === "stranded") continue;
    const dist = haversineDistanceKm(ship.position, candidate.position);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = candidate;
    }
  }

  return nearest;
}

function nearestHealthyShip(ship: ShipState, ships: ShipState[]): ShipState | null {
  let nearest: ShipState | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;

  for (const candidate of ships) {
    if (candidate.id === ship.id) continue;
    if (candidate.status === "distressed" || candidate.status === "out_of_fuel" || candidate.status === "stranded") continue;
    const dist = haversineDistanceKm(ship.position, candidate.position);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = candidate;
    }
  }

  return nearest;
}

function localRulesAdvisor(snapshot: SimulatorSnapshot): AdvisorRecommendation[] {
  const recommendations: AdvisorRecommendation[] = [];
  const { ships, alerts } = snapshot;

  for (const ship of ships) {
    // Out-of-fuel: recommend fuel transfer from nearest ship with surplus
    if (ship.status === "out_of_fuel") {
      const donor = nearestShipWithFuel(ship, ships, 500);
      if (donor) {
        recommendations.push({
          id: makeRecommendationId(),
          shipId: ship.id,
          shipName: ship.name,
          action: "request_assistance",
          payload: { assistingShipId: donor.id, assistanceType: "fuel_transfer" },
          reason: `${ship.name} is out of fuel. ${donor.name} has ${Math.round(donor.fuelTons)} t available and is nearest.`,
          confidence: 0.95,
          priority: "high",
        });
      }
      continue;
    }

    // Distressed: recommend medical aid from nearest healthy ship
    if (ship.status === "distressed") {
      const responder = nearestHealthyShip(ship, ships);
      if (responder) {
        recommendations.push({
          id: makeRecommendationId(),
          shipId: ship.id,
          shipName: ship.name,
          action: "request_assistance",
          payload: { assistingShipId: responder.id, assistanceType: "medical_aid" },
          reason: `${ship.name} is in distress. ${responder.name} is the nearest available ship for medical aid.`,
          confidence: 0.90,
          priority: "high",
        });
      }
      continue;
    }

    // Insufficient fuel: recommend reducing speed
    if (ship.status === "insufficient_fuel" && ship.speedKnots > 8) {
      const reducedSpeed = Math.max(6, Math.round(ship.speedKnots * 0.7));
      recommendations.push({
        id: makeRecommendationId(),
        shipId: ship.id,
        shipName: ship.name,
        action: "CHANGE_SPEED",
        payload: { speedKnots: reducedSpeed },
        reason: `${ship.name} has insufficient fuel for its route at ${ship.speedKnots.toFixed(1)} kt. Reducing to ${reducedSpeed} kt cuts fuel burn by ~30%.`,
        confidence: 0.85,
        priority: "medium",
      });
      continue;
    }

    // Stopped ship that isn't distressed or out of fuel: suggest resume
    if (ship.status === "stopped") {
      recommendations.push({
        id: makeRecommendationId(),
        shipId: ship.id,
        shipName: ship.name,
        action: "RESUME_COURSE",
        payload: {},
        reason: `${ship.name} has been stopped. Resume course unless a hold is intentional.`,
        confidence: 0.60,
        priority: "low",
      });
      continue;
    }

    // Check if ship is in adverse weather and has healthy fuel reserves — suggest fuel-efficient reroute
    const weatherMultiplier = resolveWeatherMultiplier(ship.position, snapshot.weatherSamples as WeatherSample[]);
    if (weatherMultiplier > 1 && ship.fuelTons < ship.currentRoute.estimatedFuelTons * 1.4) {
      const destPort = snapshot.ports.find((p) => p.id === ship.destinationPortId);
      if (destPort) {
        recommendations.push({
          id: makeRecommendationId(),
          shipId: ship.id,
          shipName: ship.name,
          action: "REROUTE_PORT",
          payload: { destinationPortId: ship.destinationPortId },
          reason: `${ship.name} is in adverse weather with tight fuel margin. Recomputing a weather-avoiding route could save fuel.`,
          confidence: 0.70,
          priority: "medium",
        });
      }
    }
  }

  // Check for unacknowledged geofence breaches with no distress response — recommend escort
  const activeBreaches = alerts.filter(
    (a) => a.type === "restricted_zone_breach" && !a.acknowledgedAt && !a.resolvedAt,
  );
  for (const breach of activeBreaches) {
    const shipId = breach.affectedShipIds[0];
    if (!shipId) continue;
    const ship = ships.find((s) => s.id === shipId);
    if (!ship || ship.status === "distressed") continue;
    const alreadyRecommended = recommendations.some((r) => r.shipId === shipId);
    if (!alreadyRecommended) {
      recommendations.push({
        id: makeRecommendationId(),
        shipId,
        shipName: ship.name,
        action: "REROUTE_PORT",
        payload: { destinationPortId: ship.destinationPortId },
        reason: `${ship.name} is inside a restricted zone. Issue reroute to clear the zone boundary.`,
        confidence: 0.88,
        priority: "high",
      });
    }
  }

  // De-duplicate by shipId — keep highest priority per ship
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const best = new Map<string, AdvisorRecommendation>();
  for (const rec of recommendations) {
    const existing = best.get(rec.shipId);
    if (!existing || priorityOrder[rec.priority] < priorityOrder[existing.priority]) {
      best.set(rec.shipId, rec);
    }
  }

  return Array.from(best.values()).sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

async function grokAdvisor(snapshot: SimulatorSnapshot): Promise<AdvisorRecommendation[]> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return localRulesAdvisor(snapshot);

  const fleetSummary = snapshot.ships.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    fuelTons: Math.round(s.fuelTons),
    speedKnots: s.speedKnots.toFixed(1),
    destination: snapshot.ports.find((p) => p.id === s.destinationPortId)?.name ?? s.destinationPortId,
    routeFuelEstimate: Math.round(s.currentRoute.estimatedFuelTons),
    weatherMultiplier: s.weatherMultiplier,
  }));

  const activeAlerts = snapshot.alerts
    .filter((a) => !a.resolvedAt && !a.acknowledgedAt)
    .map((a) => ({ type: a.type, severity: a.severity, message: a.message.slice(0, 120) }));

  const prompt = `You are a maritime fleet command AI advisor. Analyze this fleet state and return a JSON array of prioritized recommendations.

Fleet (${fleetSummary.length} ships):
${JSON.stringify(fleetSummary, null, 2)}

Active alerts (${activeAlerts.length}):
${JSON.stringify(activeAlerts, null, 2)}

Return a JSON array (max 5 items) where each item has:
- shipId: string (must match a real ship id from the fleet)
- shipName: string
- action: one of "HOLD_POSITION" | "RESUME_COURSE" | "CHANGE_SPEED" | "REROUTE_PORT" | "request_assistance"
- payload: object (for CHANGE_SPEED include speedKnots; for REROUTE_PORT include destinationPortId; for request_assistance include assistingShipId and assistanceType)
- reason: string (concise, max 120 chars, actionable)
- confidence: number 0-1
- priority: "high" | "medium" | "low"

Focus on ships with critical status first. Return ONLY valid JSON, no markdown.`;

  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-latest",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return localRulesAdvisor(snapshot);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as unknown[];

    if (!Array.isArray(parsed)) return localRulesAdvisor(snapshot);

    const validShipIds = new Set(snapshot.ships.map((s) => s.id));
    return parsed
      .filter((r): r is AdvisorRecommendation => {
        if (typeof r !== "object" || r === null) return false;
        const rec = r as Record<string, unknown>;
        return (
          typeof rec.shipId === "string" &&
          validShipIds.has(rec.shipId) &&
          typeof rec.action === "string" &&
          typeof rec.reason === "string" &&
          typeof rec.confidence === "number" &&
          typeof rec.priority === "string"
        );
      })
      .slice(0, 5)
      .map((r) => ({ ...r, id: makeRecommendationId() }));
  } catch {
    return localRulesAdvisor(snapshot);
  }
}

export async function getFleetAdvisorRecommendations(
  snapshot: SimulatorSnapshot,
): Promise<AdvisorRecommendation[]> {
  return grokAdvisor(snapshot);
}
