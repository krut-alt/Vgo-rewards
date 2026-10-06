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
// Second pass: the two addresses the first pass missed, and better spots for #31 and #33.
const tries = [
  '2800 Greenville Hwy, Easley, SC 29640', '2800 Greenville Highway, Easley, SC', '2800 SC-124, Easley, SC', '2800 Hwy 124, Easley, SC', '2800 Greenville Hwy, Pelzer, SC', '2800 Greenville Hwy, Liberty, SC',
  '501 N Harper St, Laurens, SC 29360', '501 N Harper Street, Laurens, SC', '501 N Harper Street Ext, Laurens, SC', '501 Harper Rd, Laurens, SC',
  '1 W Georgia Rd, Simpsonville, SC', '100 W Georgia Rd, Simpsonville, SC', '700 W Georgia Rd, Simpsonville, SC', '1000 W Georgia Rd, Simpsonville, SC', '2000 W Georgia Rd, Simpsonville, SC',
];
for (const q of tries) {
  const c = await census(q).catch(() => null);
  await sleep(1100);
  const o = await osmFuel(q).catch((e) => [e.message]);
  console.log(`TRY ${q} | census ${c ? `${c.lat.toFixed(6)},${c.lng.toFixed(6)} ${c.match}` : '-'} | osm ${JSON.stringify(o)}`);
  await sleep(1100);
}
for (const q of ['fuel Easley SC Greenville Highway', 'fuel Laurens SC Harper', 'fuel Simpsonville SC West Georgia Road', 'fuel Mauldin Road Greenville SC', 'Harper Street Laurens SC', 'Greenville Highway Easley SC']) {
  console.log(`EXTRA ${q} => ${JSON.stringify(await osmFuel(q).catch((e) => e.message))}`);
  await sleep(1100);
}
