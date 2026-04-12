/**
 * Distance calculation service for mileage expenses.
 *
 * Supports two providers:
 *  - OpenRouteService (ORS_API_KEY)
 *  - Google Maps (GOOGLE_MAPS_API_KEY)
 *
 * Falls back to manual-miles-only mode if neither key is set.
 */

import axios from "axios";
import type { DistanceResult } from "../types.js";

export function isDistanceConfigured(): boolean {
  return !!(process.env.ORS_API_KEY || process.env.GOOGLE_MAPS_API_KEY);
}

/**
 * Calculate driving distance between two addresses.
 * Tries OpenRouteService first, then Google Maps.
 */
export async function calculateDistance(
  origin: string,
  destination: string
): Promise<DistanceResult> {
  if (process.env.ORS_API_KEY) {
    return calculateWithORS(origin, destination);
  }
  if (process.env.GOOGLE_MAPS_API_KEY) {
    return calculateWithGoogle(origin, destination);
  }
  throw new Error(
    "No distance API configured. Set ORS_API_KEY or GOOGLE_MAPS_API_KEY, or provide manual miles instead."
  );
}

// ── OpenRouteService ─────────────────────────────────────────────────────────

async function geocodeORS(address: string): Promise<[number, number]> {
  const apiKey = process.env.ORS_API_KEY!;
  const response = await axios.get<{
    features: Array<{ geometry: { coordinates: [number, number] } }>;
  }>("https://api.openrouteservice.org/geocode/search", {
    params: { api_key: apiKey, text: address, size: 1, "boundary.country": "GB" },
    timeout: 15_000,
  });

  const features = response.data.features;
  if (!features || features.length === 0) {
    throw new Error(`Could not geocode address: "${address}"`);
  }
  return features[0]!.geometry.coordinates; // [lng, lat]
}

async function calculateWithORS(
  origin: string,
  destination: string
): Promise<DistanceResult> {
  const [originCoords, destCoords] = await Promise.all([
    geocodeORS(origin),
    geocodeORS(destination),
  ]);

  const apiKey = process.env.ORS_API_KEY!;
  const response = await axios.post<{
    routes: Array<{ summary: { distance: number } }>;
  }>(
    "https://api.openrouteservice.org/v2/directions/driving-car",
    { coordinates: [originCoords, destCoords] },
    {
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      timeout: 15_000,
    }
  );

  const routes = response.data.routes;
  if (!routes || routes.length === 0) {
    throw new Error("No driving route found between the two addresses.");
  }

  const distanceMetres = routes[0]!.summary.distance;
  const distanceMiles = distanceMetres / 1609.344;

  return {
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    origin,
    destination,
    provider: "openrouteservice",
  };
}

// ── Google Maps ──────────────────────────────────────────────────────────────

async function calculateWithGoogle(
  origin: string,
  destination: string
): Promise<DistanceResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY!;
  const response = await axios.get<{
    rows: Array<{
      elements: Array<{
        status: string;
        distance: { value: number };
      }>;
    }>;
  }>("https://maps.googleapis.com/maps/api/distancematrix/json", {
    params: {
      origins: origin,
      destinations: destination,
      mode: "driving",
      units: "imperial",
      key: apiKey,
    },
    timeout: 15_000,
  });

  const element = response.data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    throw new Error(
      `Google Maps could not calculate distance. Status: ${element?.status ?? "NO_RESULT"}`
    );
  }

  const distanceMetres = element.distance.value;
  const distanceMiles = distanceMetres / 1609.344;

  return {
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    origin,
    destination,
    provider: "google_maps",
  };
}
