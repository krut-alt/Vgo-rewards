// Starts the console: `npm run console`, then open http://localhost:4310.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Repo } from './repo.js';
import { seedData } from './seed.js';
import { createApp } from './server.js';

const dataFile = resolve(process.env.VGO_DATA ?? 'data/console.json');
mkdirSync(dirname(dataFile), { recursive: true });
const repo = Repo.open(dataFile, () => seedData());
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
createApp(repo, resolve(process.env.VGO_PUBLIC ?? 'packages/console/public')).listen(port, host, () => {
  console.log(`VGO Rewards console: http://localhost:${port}  (data: ${dataFile})`);
});
