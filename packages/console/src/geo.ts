// Distance math for near-store (geofenced) offers.
import type { ConsoleStore } from './model.js';

export interface Spot {
  lat: number;
  lng: number;
}

const EARTH_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function milesBetween(a: Spot, b: Spot): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(x));
}

/** Reads a phone's reported location; anything else is treated as no location. */
export function spotFrom(lat: unknown, lng: unknown): Spot | undefined {
  const a = Number(lat);
  const b = Number(lng);
  if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return undefined;
  return { lat: a, lng: b };
}

/** The closest of these stores within `miles` of the member, if any has a map location. */
export function nearestWithin(stores: ConsoleStore[], at: Spot, miles: number): ConsoleStore | undefined {
  let best: { store: ConsoleStore; d: number } | undefined;
  for (const s of stores) {
    if (s.lat === undefined || s.lng === undefined) continue;
    const d = milesBetween(at, { lat: s.lat, lng: s.lng });
    if (d <= miles && (!best || d < best.d)) best = { store: s, d };
  }
  return best?.store;
}
