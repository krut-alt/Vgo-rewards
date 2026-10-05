// Starts the console: `npm run console`, then open http://localhost:4310.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MemberApi } from './member-api.js';
import { Repo } from './repo.js';
import { seedData } from './seed.js';
import { createApp } from './server.js';
import { smsSenderFromEnv } from './sms.js';

const dataFile = resolve(process.env.VGO_DATA ?? 'data/console.json');
mkdirSync(dirname(dataFile), { recursive: true });
const repo = Repo.open(dataFile, () => seedData());
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
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM send real texts; without them codes go to the log.
const sms = smsSenderFromEnv();
const memberApi = new MemberApi(repo, sms.sender, () => new Date(), process.env.VGO_DEV_CODES === '1');
createApp(repo, resolve(process.env.VGO_PUBLIC ?? 'packages/console/public'), {
  appDir: resolve(process.env.VGO_APP ?? 'packages/app/public'),
  memberApi,
  adminPassword,
}).listen(port, host, () => {
  console.log(`VGO Rewards console: http://localhost:${port}   member app: http://localhost:${port}/app/   (data: ${dataFile}, texts: ${sms.name})`);
});
