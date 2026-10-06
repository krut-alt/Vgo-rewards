// One-off: looks up map spots for the sites in migrate.ts and prints them.
import { readFileSync } from 'node:fs';
const src = readFileSync('packages/console/src/migrate.ts', 'utf8');
const sites = [...src.matchAll(/\[(\d+), '((?:[^'\\]|\\.)*)', '([^']+)', '([A-Z]{2})'(?:, '(\d+)')?\]|\[(\d+), "([^"]+)", '([^']+)', '([A-Z]{2})'\]/g)].map((m) =>
  m[1] ? { n: +m[1], street: m[2], city: m[3], state: m[4], zip: m[5] } : { n: +m[6], street: m[7], city: m[8], state: m[9] },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function census(q) {
  const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(q)}`);
  const j = await r.json();
  const m = j.result?.addressMatches?.[0];
  return m && { lat: m.coordinates.y, lng: m.coordinates.x, match: m.matchedAddress, src: 'census' };
}
async function osm(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'VGO Rewards store locator (one-off)' } });
  const j = await r.json();
  return j[0] && { lat: +j[0].lat, lng: +j[0].lon, match: j[0].display_name, src: 'osm' };
}
async function osmFuel(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'VGO Rewards store locator (one-off)' } });
  return (await r.json()).map((x) => `${x.lat},${x.lon} ${x.display_name}`);
}
for (const s of sites) {
  const q = `${s.street}, ${s.city}, ${s.state}${s.zip ? ` ${s.zip}` : ''}`;
  let hit = await census(q).catch((e) => console.log('census err', e.message));
  if (!hit) { await sleep(1100); hit = await osm(q).catch(() => null); }
  console.log(`SITE ${s.n} | ${q} | ${hit ? `${hit.lat.toFixed(6)},${hit.lng.toFixed(6)} | ${hit.src} | ${hit.match}` : 'NOT FOUND'}`);
  await sleep(1100);
}
for (const q of ['VGO Georgia Road Greenville SC', 'gas station W Georgia Rd Simpsonville SC', 'W Georgia Rd & S Main St Simpsonville SC', 'Mauldin Rd & Fairforest Way Greenville SC', 'gas station Mauldin Rd Fairforest Way Greenville SC']) {
  console.log(`EXTRA ${q} => ${JSON.stringify(await osmFuel(q).catch((e) => e.message))}`);
  await sleep(1100);
}
