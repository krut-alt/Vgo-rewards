// Keeps the data file in Upstash Redis, for hosts with no lasting disk (such as Render's free plan).
// The JSON is gzipped so it stays small; saves are coalesced so only the latest copy is sent.
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ConsoleData } from './model.js';

export interface UpstashConfig {
  /** UPSTASH_REDIS_REST_URL, like https://xxx.upstash.io */
  url: string;
  /** UPSTASH_REDIS_REST_TOKEN */
  token: string;
  key?: string;
}

export function upstashConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UpstashConfig | undefined {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token, key: env.VGO_DATA_KEY?.trim() || undefined } : undefined;
}

export function upstashStore(config: UpstashConfig, fetchImpl: typeof fetch = fetch) {
  const key = config.key ?? 'vgo-rewards:data';

  async function command(args: string[]): Promise<unknown> {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Upstash ${res.status}: ${body.error ?? 'request failed'}`);
    return body.result;
  }

  let inFlight: Promise<void> | undefined;
  let pending: ConsoleData | undefined;

  async function flush(): Promise<void> {
    while (pending) {
      const data = pending;
      pending = undefined;
      try {
        await command(['SET', key, gzipSync(JSON.stringify(data)).toString('base64')]);
      } catch (err) {
        console.error('[data] save to Upstash failed, will retry with the next change:', err);
      }
    }
  }

  function kick(): void {
    inFlight ??= flush().finally(() => {
      inFlight = undefined;
      if (pending) kick();
    });
  }

  return {
    async load(): Promise<ConsoleData | undefined> {
      const stored = await command(['GET', key]);
      if (typeof stored !== 'string') return undefined;
      return JSON.parse(gunzipSync(Buffer.from(stored, 'base64')).toString('utf8')) as ConsoleData;
    },
    /** For Repo's persist hook: never blocks, always ends with the latest data saved. */
    save(data: ConsoleData): void {
      pending = structuredClone(data);
      kick();
    },
    /** Resolves once everything queued so far is sent. */
    async idle(): Promise<void> {
      while (inFlight) await inFlight;
    },
  };
}
