// Starts the console: `npm run console`, then open http://localhost:4310.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MemberApi } from './member-api.js';
import { upstashConfigFromEnv, upstashStore } from './remote-store.js';
import { Repo } from './repo.js';
import { seedData } from './seed.js';
import { createApp } from './server.js';
import { smsFromEnv } from './sms.js';

const dataFile = resolve(process.env.VGO_DATA ?? 'data/console.json');
mkdirSync(dirname(dataFile), { recursive: true });
// With Upstash settings the data lives there (for hosts without a lasting disk); otherwise in the data file.
const upstash = upstashConfigFromEnv();
let repo: Repo;
if (upstash) {
  const store = upstashStore(upstash);
  const saved = await store.load();
  repo = new Repo(saved ?? seedData(), (d) => store.save(d));
  if (!saved) repo.save();
  // Free hosts stop idle servers; finish the last save before exiting.
  process.once('SIGTERM', () => void store.idle().finally(() => process.exit(0)));
} else {
  repo = Repo.open(dataFile, () => seedData());
}
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
// VGO_ADMIN_PASSWORD protects the console. It is required whenever the server is reachable from other machines.
const adminPassword = process.env.VGO_ADMIN_PASSWORD || undefined;
if (!adminPassword && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error('Set VGO_ADMIN_PASSWORD before serving the console on a public address.');
  process.exit(1);
}
// VGO_DEV_CODES=1 puts sign-in codes in the app's API response for local testing.
// Leave it off anywhere real members sign in.
// TWILIO_VERIFY_SID (with the account SID and token) uses Twilio Verify, which works on trial accounts;
// TWILIO_FROM sends our own texts instead. Without either, codes go to the log.
const sms = smsFromEnv();
const memberApi = new MemberApi(repo, sms.sender, () => new Date(), process.env.VGO_DEV_CODES === '1', sms.codeService);
createApp(repo, resolve(process.env.VGO_PUBLIC ?? 'packages/console/public'), {
  appDir: resolve(process.env.VGO_APP ?? 'packages/app/public'),
  memberApi,
  adminPassword,
}).listen(port, host, () => {
  console.log(`VGO Rewards console: http://localhost:${port}   member app: http://localhost:${port}/app/   (data: ${upstash ? 'Upstash' : dataFile}, texts: ${sms.name})`);
});
