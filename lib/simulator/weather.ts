import "server-only";

import type { LatLng, WeatherSample } from "@/lib/domain";

// Thresholds for classifying adverse weather
// Wind speed ≥ 15 m/s (~30 knots) or wave height ≥ 2 m is considered adverse.
// Fuel multiplier is 1.3 (30% extra burn) for adverse conditions.
const ADVERSE_WIND_SPEED_MS = 15;
const ADVERSE_WAVE_HEIGHT_M = 2;
const ADVERSE_FUEL_MULTIPLIER = 1.3;

// Sample grid covering the Persian Gulf, Strait of Hormuz, and Gulf of Oman.
// Each point is verified to be within or near the operational bounding box.
const WEATHER_GRID: LatLng[] = [
  [26.5, 50.5], // Northern Persian Gulf (west)
  [26.5, 53.0], // Northern Persian Gulf (centre)
  [26.5, 55.5], // Northern Persian Gulf (east)
  [25.0, 51.5], // Central Persian Gulf (west)
  [25.0, 53.5], // Central Persian Gulf (centre)
  [25.0, 55.5], // Central Persian Gulf (east)
  [23.5, 51.5], // Southern Persian Gulf (west)
  [23.5, 53.5], // Southern Persian Gulf (centre)
  [23.5, 55.5], // Southern Persian Gulf (east)
  [26.3, 56.3], // Strait of Hormuz (west)
  [26.5, 56.7], // Strait of Hormuz (east)
  [25.0, 57.5], // Gulf of Oman (west)
  [23.5, 57.5], // Gulf of Oman (centre)
  [22.5, 59.0], // Gulf of Oman (east)
];

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function classifySample(
  position: LatLng,
  windSpeedMs: number,
  waveHeightM: number,
): WeatherSample {
  const adverse = windSpeedMs >= ADVERSE_WIND_SPEED_MS || waveHeightM >= ADVERSE_WAVE_HEIGHT_M;
  const summary = adverse
    ? `Adverse: wind ${windSpeedMs.toFixed(1)} m/s, wave ${waveHeightM.toFixed(1)} m`
    : `Clear: wind ${windSpeedMs.toFixed(1)} m/s, wave ${waveHeightM.toFixed(1)} m`;

  return {
    id: makeId("wx"),
    position,
    timestamp: Date.now(),
    adverse,
    summary,
    fuelMultiplier: adverse ? ADVERSE_FUEL_MULTIPLIER : 1,
  };
}

type OpenMeteoHourlyResponse = {
  hourly: {
    time: string[];
    windspeed_10m: number[];
    wave_height?: number[];
  };
};

async function fetchPointWeather(position: LatLng): Promise<WeatherSample> {
  const [lat, lng] = position;
  // Open-Meteo Marine API: wave height + wind speed (no API key required)
  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}` +
    `&hourly=wave_height&forecast_days=1&timezone=UTC`;
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&hourly=windspeed_10m&forecast_days=1&timezone=UTC`;

  const now = new Date();
  const currentHour = now.getUTCHours();

  let windSpeedMs = 0;
  let waveHeightM = 0;

  try {
    const [forecastRes, marineRes] = await Promise.all([
      fetch(forecastUrl, { signal: AbortSignal.timeout(8000) }),
      fetch(marineUrl, { signal: AbortSignal.timeout(8000) }),
    ]);

    if (forecastRes.ok) {
      const data = (await forecastRes.json()) as OpenMeteoHourlyResponse;
      const rawWind = data.hourly?.windspeed_10m?.[currentHour];
      if (typeof rawWind === "number") {
        windSpeedMs = rawWind / 3.6; // km/h → m/s
      }
    }

    if (marineRes.ok) {
      const data = (await marineRes.json()) as OpenMeteoHourlyResponse;
      const rawWave = data.hourly?.wave_height?.[currentHour];
      if (typeof rawWave === "number") {
        waveHeightM = rawWave;
      }
    }
  } catch {
    // Network failure — return a clear sample so the sim can continue
  }

  return classifySample(position, windSpeedMs, waveHeightM);
}

export async function fetchWeatherSamples(): Promise<WeatherSample[]> {
  // Fetch all grid points concurrently but cap concurrency to avoid rate limiting
  const BATCH_SIZE = 4;
  const samples: WeatherSample[] = [];

  for (let i = 0; i < WEATHER_GRID.length; i += BATCH_SIZE) {
    const batch = WEATHER_GRID.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchPointWeather));
    samples.push(...results);
  }

  return samples;
}

export { ADVERSE_FUEL_MULTIPLIER, ADVERSE_WAVE_HEIGHT_M, ADVERSE_WIND_SPEED_MS };
