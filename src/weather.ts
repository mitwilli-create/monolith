// Open-Meteo forecast client: free, keyless. Cached in-process for 1h.
// Realizes the gem doc's "Dynamic Environmental API Integration" pathway.

import type { WeatherDay } from "./types.js";

export interface GeoMatch {
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
}

/**
 * City-name → coordinates via Open-Meteo's keyless geocoder, for the
 * intake's location step. Empty array on any failure: the intake form
 * falls back to asking outright.
 */
export async function geocode(q: string): Promise<GeoMatch[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}` +
    `&count=5&language=en&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      results?: {
        name: string;
        admin1?: string;
        country?: string;
        latitude: number;
        longitude: number;
      }[];
    };
    return (body.results ?? []).map((r) => ({
      city: r.name,
      region: r.admin1 ?? "",
      country: r.country ?? "",
      lat: r.latitude,
      lon: r.longitude,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

interface CacheEntry {
  at: number;
  days: WeatherDay[];
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000;

export async function getForecast(
  lat: number,
  lon: number,
  days = 7,
): Promise<WeatherDay[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.days;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
    `&temperature_unit=fahrenheit&forecast_days=${days}&timezone=auto`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const body = (await res.json()) as {
      daily?: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: (number | null)[];
        precipitation_sum: (number | null)[];
      };
    };
    const d = body.daily;
    if (!d) return [];
    const out: WeatherDay[] = d.time.map((date, i) => ({
      date,
      tMaxF: d.temperature_2m_max[i] ?? 0,
      tMinF: d.temperature_2m_min[i] ?? 0,
      precipProb: d.precipitation_probability_max[i] ?? 0,
      precipSumMm: d.precipitation_sum[i] ?? 0,
    }));
    cache.set(key, { at: Date.now(), days: out });
    return out;
  } catch {
    // Weather is advisory: never let it break a verdict.
    return hit?.days ?? [];
  } finally {
    clearTimeout(timer);
  }
}
