import { describe, expect, it } from 'vitest';
import { upstashConfigFromEnv, upstashStore } from '../src/remote-store.js';
import type { ConsoleData } from '../src/model.js';
import { seedData } from '../src/seed.js';

function fakeUpstash() {
  const kv = new Map<string, string>();
  const sets: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const [cmd, key, value] = JSON.parse(String(init.body)) as string[];
    if (cmd === 'SET') {
      kv.set(key!, value!);
      sets.push(value!);
      return new Response(JSON.stringify({ result: 'OK' }));
    }
    return new Response(JSON.stringify({ result: kv.get(key!) ?? null }));
  }) as unknown as typeof fetch;
  return { kv, sets, impl };
}

const config = { url: 'https://x.upstash.io', token: 't' };

describe('Upstash data store', () => {
  it('returns nothing before the first save, then the saved data', async () => {
    const f = fakeUpstash();
    const store = upstashStore(config, f.impl);
    expect(await store.load()).toBeUndefined();
    const data = seedData(new Date('2026-10-05T16:00:00Z'));
    store.save(data);
    await store.idle();
    expect(await upstashStore(config, f.impl).load()).toEqual(data);
    expect(f.sets[0]!.length).toBeLessThan(JSON.stringify(data).length / 4); // gzipped
  });

  it('sends only the latest copy when changes pile up', async () => {
    const f = fakeUpstash();
    const store = upstashStore(config, f.impl);
    const data = seedData(new Date('2026-10-05T16:00:00Z'));
    for (let i = 1; i <= 5; i++) store.save({ ...data, members: data.members.slice(0, i) } as ConsoleData);
    await store.idle();
    expect(f.sets.length).toBeLessThanOrEqual(2);
    expect((await store.load())!.members).toHaveLength(5);
  });

  it('reads its settings from the environment', () => {
    expect(upstashConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/' })).toBeUndefined();
    expect(upstashConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 't' })).toMatchObject({ url: 'https://x.upstash.io' });
  });
});
