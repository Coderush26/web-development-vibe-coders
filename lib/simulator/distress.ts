import type { AlertSeverity, DistressAnalysis } from "@/lib/domain";

type ImpactName =
  | "injuredCrew"
  | "missingCrew"
  | "waterIngressCm"
  | "enginePowerLossPercent"
  | "cargoLossTons"
  | "reportedCount";

// ─── Local rule-based fallback ────────────────────────────────────────────────

const criticalTerms = [
  "mayday",
  "critical",
  "fire",
  "explosion",
  "sinking",
  "abandon",
  "capsize",
  "collision",
];

const warningTerms = [
  "urgent",
  "injur",
  "medical",
  "engine",
  "propulsion",
  "flood",
  "water ingress",
  "taking water",
  "cargo",
  "spill",
  "leak",
];

function firstNumber(pattern: RegExp, text: string): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function setImpact(
  impacts: Record<string, number | string>,
  key: ImpactName,
  value: number | undefined,
): void {
  if (typeof value === "number") {
    impacts[key] = value;
  }
}

function classifyProblem(normalized: string): string {
  if (normalized.includes("fire") || normalized.includes("burn") || normalized.includes("explosion")) {
    return "fire";
  }

  if (
    normalized.includes("engine") ||
    normalized.includes("propulsion") ||
    normalized.includes("power loss") ||
    normalized.includes("blackout")
  ) {
    return "engine_failure";
  }

  if (
    normalized.includes("flood") ||
    normalized.includes("water ingress") ||
    normalized.includes("taking water") ||
    normalized.includes("sinking")
  ) {
    return "flooding";
  }

  if (
    normalized.includes("injur") ||
    normalized.includes("medical") ||
    normalized.includes("casualt") ||
    normalized.includes("missing")
  ) {
    return "medical";
  }

  if (
    normalized.includes("cargo") ||
    normalized.includes("spill") ||
    normalized.includes("leak") ||
    normalized.includes("container")
  ) {
    return "cargo_damage";
  }

  return "unknown";
}

function extractImpacts(normalized: string, problemCategory: string): Record<string, number | string> {
  const impacts: Record<string, number | string> = {};

  setImpact(
    impacts,
    "injuredCrew",
    firstNumber(/\b(\d{1,3})\s*(?:crew|people|personnel|sailors|persons)?\s*(?:injured|hurt|wounded|casualt)/, normalized) ??
      firstNumber(/\b(?:injured|hurt|wounded|casualt\w*)\s*(?:crew|people|personnel|sailors|persons)?\s*(\d{1,3})\b/, normalized),
  );
  setImpact(
    impacts,
    "missingCrew",
    firstNumber(/\b(\d{1,3})\s*(?:crew|people|personnel|sailors|persons)?\s*missing/, normalized) ??
      firstNumber(/\bmissing\s*(?:crew|people|personnel|sailors|persons)?\s*(\d{1,3})\b/, normalized),
  );
  setImpact(
    impacts,
    "waterIngressCm",
    firstNumber(/\b(\d{1,3})\s*(?:cm|centimeters?)\s*(?:water|ingress|flood)/, normalized),
  );
  setImpact(
    impacts,
    "enginePowerLossPercent",
    firstNumber(/\b(\d{1,3})\s*%\s*(?:engine|power|propulsion)\s*(?:loss|down|offline|failure)?/, normalized) ??
      firstNumber(/\b(?:engine|power|propulsion)\s*(?:loss|down|offline|failure)\s*(?:at|of)?\s*(\d{1,3})\s*%/, normalized),
  );
  setImpact(
    impacts,
    "cargoLossTons",
    firstNumber(/\b(\d{1,4})\s*(?:tons?|tonnes?)\s*(?:cargo|lost|loss|spill|spilled)/, normalized),
  );

  const genericCount = firstNumber(/\b(\d{1,4})\b/, normalized);
  if (typeof genericCount === "number" && Object.keys(impacts).length === 0) {
    impacts.reportedCount = genericCount;
  }

  if (problemCategory !== "unknown") {
    impacts.problem = problemCategory;
  }

  return impacts;
}

function scoreSeverity(normalized: string, impacts: Record<string, number | string>): AlertSeverity {
  let score = 0;

  if (criticalTerms.some((term) => normalized.includes(term))) {
    score += 3;
  }

  if (warningTerms.some((term) => normalized.includes(term))) {
    score += 1;
  }

  const injuredCrew = Number(impacts.injuredCrew ?? 0);
  const missingCrew = Number(impacts.missingCrew ?? 0);
  const waterIngressCm = Number(impacts.waterIngressCm ?? 0);
  const enginePowerLossPercent = Number(impacts.enginePowerLossPercent ?? 0);
  const cargoLossTons = Number(impacts.cargoLossTons ?? 0);

  if (injuredCrew > 0 || missingCrew > 0) {
    score += 1;
  }
  if (injuredCrew >= 5 || missingCrew > 0) {
    score += 2;
  }
  if (waterIngressCm >= 50 || enginePowerLossPercent >= 75 || cargoLossTons >= 100) {
    score += 2;
  } else if (waterIngressCm > 0 || enginePowerLossPercent > 0 || cargoLossTons > 0) {
    score += 1;
  }

  if (score >= 3) {
    return "critical";
  }

  if (score >= 1) {
    return "warning";
  }

  return "info";
}

function analyzeLocal(message: string): DistressAnalysis {
  const normalized = message.trim().toLowerCase();
  const problemCategory = classifyProblem(normalized);
  const impacts = extractImpacts(normalized, problemCategory);
  const severity = scoreSeverity(normalized, impacts);
  const confidence =
    problemCategory === "unknown" && Object.keys(impacts).length === 0
      ? 0.42
      : severity === "critical"
        ? 0.86
        : 0.74;

  return {
    severity,
    problemCategory,
    impacts,
    confidence,
    source: "local_rules",
  };
}

// ─── xAI / Grok AI analysis ───────────────────────────────────────────────────

const XAI_BASE = "https://api.x.ai/v1";
const XAI_MODEL = "grok-latest";

const SYSTEM_PROMPT = `You are a maritime emergency analyst. A ship captain has sent a distress message.
Extract structured information and respond with ONLY valid JSON — no markdown, no explanation.

JSON schema:
{
  "severity": "info" | "warning" | "critical",
  "problemCategory": "fire" | "engine_failure" | "flooding" | "medical" | "cargo_damage" | "unknown",
  "impacts": {
    "injuredCrew"?: number,
    "missingCrew"?: number,
    "waterIngressCm"?: number,
    "enginePowerLossPercent"?: number,
    "cargoLossTons"?: number
  },
  "confidence": number
}

Severity rules:
- critical: mayday, fire, explosion, sinking, capsize, collision, missing crew, 5+ injured, >= 50cm water ingress, >= 75% engine loss, >= 100 tons cargo loss
- warning: injury, flooding, engine issues, urgent medical, cargo spill
- info: minor incidents, precautionary reports`;

type GrokResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type ParsedGrokResult = {
  severity?: string;
  problemCategory?: string;
  impacts?: Record<string, number>;
  confidence?: number;
};

async function analyzeWithGrok(message: string): Promise<DistressAnalysis> {
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    throw new Error("XAI_API_KEY not set");
  }

  const response = await fetch(`${XAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Distress message: "${message}"` },
      ],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`xAI API ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as GrokResponse;
  const raw = data.choices?.[0]?.message?.content ?? "";

  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\n?/gi, "").trim();
  const parsed = JSON.parse(cleaned) as ParsedGrokResult;

  const severity =
    parsed.severity === "critical" || parsed.severity === "warning" || parsed.severity === "info"
      ? parsed.severity
      : "info";

  const validCategories = ["fire", "engine_failure", "flooding", "medical", "cargo_damage", "unknown"];
  const problemCategory =
    typeof parsed.problemCategory === "string" && validCategories.includes(parsed.problemCategory)
      ? parsed.problemCategory
      : "unknown";

  const rawImpacts = parsed.impacts ?? {};
  const impacts: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(rawImpacts)) {
    if (typeof value === "number" && value > 0) {
      impacts[key] = value;
    }
  }
  if (problemCategory !== "unknown") {
    impacts.problem = problemCategory;
  }

  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.8;

  return { severity, problemCategory, impacts, confidence, source: "grok" };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function analyzeDistressMessage(message: string): Promise<DistressAnalysis> {
  if (process.env.XAI_API_KEY) {
    try {
      return await analyzeWithGrok(message);
    } catch (err) {
      console.error("[distress] Grok failed, falling back to local rules:", err);
    }
  }

  return analyzeLocal(message);
}

export function formatDistressAnalysis(analysis: DistressAnalysis): string {
  const impactSummary = Object.entries(analysis.impacts)
    .filter(([key]) => key !== "problem")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

  return [
    `category=${analysis.problemCategory}`,
    `severity=${analysis.severity}`,
    `confidence=${Math.round(analysis.confidence * 100)}%`,
    impactSummary ? `impacts=${impactSummary}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}
