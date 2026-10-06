// Runs one pretend sale through the POS link of a running server, the way the store POS will:
//   npm run pos:mock -- --url https://<your-app>.onrender.com --key <VGO_POS_KEY> --phone 8645551234
// Options: --site <POS site ID or store id> (default vgo-01), --gallons 10, --skip <rewardId>.
import { randomUUID } from 'node:crypto';
import { httpTransport, MockSale } from './mock-link.js';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) args.set(argv[i]!.slice(2), argv[i + 1] ?? ''), i++;

const url = args.get('url') ?? 'http://localhost:4310';
const phone = args.get('phone');
if (!phone) {
  console.error('Give a member phone number: --phone 8645551234');
  process.exit(1);
}
const send = httpTransport(url, args.get('key') ?? process.env.VGO_POS_KEY);
const sale = new MockSale(send, args.get('site') ?? 'vgo-01', `mock-${randomUUID().slice(0, 8)}`, new Date().toISOString());

const show = (label: string, data: unknown) => console.log(`\n${label}\n${JSON.stringify(data, null, 2)}`);
show('1. Member scanned', await sale.identify(phone));
sale.ring('coffee-16', 'Coffee', 199).ring('turkey-sub', 'Sandwiches', 599).ring('cigs', 'Tobacco', 899);
show('2. Rewards at pump authorization and register', await sale.getRewards());
sale.pump('UNL', Number(args.get('gallons') ?? 10), 319);
await sale.getRewards();
show('3. Finalized after payment', await sale.finalize(args.get('skip') ? [args.get('skip')!] : []));
