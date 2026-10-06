// Finds a store's map spot from its street address, so new locations get a dot on the app's map
// without anyone copying coordinates. Free services, no keys: the U.S. Census geocoder first,
// then OpenStreetMap's (which also knows intersections and landmarks).
import type { Spot } from './geo.js';
import type { ConsoleStore } from './model.js';
import type { Repo } from './repo.js';

export type Geocoder = (address: string) => Promise<Spot | undefined>;

export const addressOf = (s: ConsoleStore) => [s.address, s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter((x) => x?.trim()).join(', ');

const census: Geocoder = async (address) => {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return undefined;
  const hit = ((await res.json()) as { result?: { addressMatches?: { coordinates: { x: number; y: number } }[] } }).result?.addressMatches?.[0];
  return hit ? { lat: hit.coordinates.y, lng: hit.coordinates.x } : undefined;
};

const openStreetMap: Geocoder = async (address) => {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'VGO Rewards store locator' } });
  if (!res.ok) return undefined;
  const hit = ((await res.json()) as { lat: string; lon: string }[])[0];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : undefined;
};

/** Tries each service in turn; a service that errors counts as not found. */
export function chainGeocoders(...list: Geocoder[]): Geocoder {
  return async (address) => {
    for (const g of list) {
      const spot = await g(address).catch(() => undefined);
      if (spot && Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) return spot;
    }
    return undefined;
  };
}

export const freeGeocoder = chainGeocoders(census, openStreetMap);

/**
 * Looks up every store that has an address but no map spot, one at a time (OpenStreetMap allows
 * one lookup a second). An address that can't be found is remembered in `mapLookupFailed` so it
 * isn't retried until someone changes it; the portal then asks for the coordinates by hand.
 */
export function storeSpotFiller(repo: Repo, geocode: Geocoder, pauseMs = 1100) {
  let running: Promise<void> | null = null;
  let again = false;
  const pending = () => repo.data.stores.filter((s) => s.lat === undefined && s.address?.trim() && s.mapLookupFailed !== addressOf(s));
  async function run() {
    do {
      again = false;
      for (const s of pending()) {
        const address = addressOf(s);
        const spot = await geocode(address);
        const now = repo.data.stores.find((x) => x.id === s.id);
        // Skip if the store changed while we were looking.
        if (!now || now.lat !== undefined || addressOf(now) !== address) continue;
        if (spot) {
          now.lat = Math.round(spot.lat * 1e6) / 1e6;
          now.lng = Math.round(spot.lng * 1e6) / 1e6;
          delete now.mapLookupFailed;
        } else now.mapLookupFailed = address;
        repo.save();
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
    } while (again);
  }
  /** Starts a lookup pass, or queues one if a pass is already running. */
  return function fill(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => (running = null));
    return running;
  };
}
