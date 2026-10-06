// Starts the console: `npm run console`, then open http://localhost:4310.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { freeGeocoder } from './geocode.js';
import { fileMediaStore, upstashMediaStore } from './media.js';
import { MemberApi } from './member-api.js';
import { upstashConfigFromEnv, upstashStore } from './remote-store.js';
import { Repo } from './repo.js';
import { seedData } from './seed.js';
import { createApp } from './server.js';
import { smsSenderFromEnv } from './sms.js';

const dataFile = resolve(process.env.VGO_DATA ?? 'data/console.json');
mkdirSync(dirname(dataFile), { recursive: true });
// With Upstash settings the data lives there (for hosts without a lasting disk); otherwise in the data file.
const upstash = upstashConfigFromEnv();
let repo: Repo;
if (upstash) {
  const store = upstashStore(upstash);
  const saved = await store.load();
  repo = new Repo(saved ?? seedData(new Date(), { realSites: true }), (d) => store.save(d));
  if (!saved || repo.migrated) repo.save();
  // Free hosts stop idle servers; finish the last save before exiting.
  process.once('SIGTERM', () => void store.idle().finally(() => process.exit(0)));
} else {
  repo = Repo.open(dataFile, () => seedData(new Date(), { realSites: true }));
}
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
// VGO_ADMIN_PASSWORD turns on portal sign-in ("admin" + this password is the master admin). It is required
// whenever the server is reachable from other machines. VGO_POS_KEY is what the POS link signs its calls with.
const adminPassword = process.env.VGO_ADMIN_PASSWORD || undefined;
if (!adminPassword && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error('Set VGO_ADMIN_PASSWORD before serving the console on a public address.');
  process.exit(1);
}
// VGO_DEV_CODES=1 puts sign-in codes in the app's API response for local testing.
// Leave it off anywhere real members sign in.
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM send real texts; without them codes go to the log.
const sms = smsSenderFromEnv();
const memberApi = new MemberApi(repo, sms.sender, () => new Date(), process.env.VGO_DEV_CODES === '1');
createApp(repo, resolve(process.env.VGO_PUBLIC ?? 'packages/console/public'), {
  appDir: resolve(process.env.VGO_APP ?? 'packages/app/public'),
  memberApi,
  adminPassword,
  posKey: process.env.VGO_POS_KEY || undefined,
  media: upstash ? upstashMediaStore(upstash) : fileMediaStore(resolve(dirname(dataFile), 'media')),
  // Fills in map spots for stores from their addresses. VGO_GEOCODE=0 turns it off.
  ...(process.env.VGO_GEOCODE === '0' ? {} : { geocoder: freeGeocoder }),
}).listen(port, host, () => {
  console.log(`VGO Rewards console: http://localhost:${port}   member app: http://localhost:${port}/app/   (data: ${upstash ? 'Upstash' : dataFile}, texts: ${sms.name})`);
});
