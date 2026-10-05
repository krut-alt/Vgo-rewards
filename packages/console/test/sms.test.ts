import { describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { smsSenderFromEnv, twilioConfigFromEnv, twilioSender } from '../src/sms.js';

const config = { accountSid: 'AC123', authToken: 'secret', from: '+18035550000' };

function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('Twilio texts', () => {
  it('posts the message to Twilio with basic auth', async () => {
    const f = fakeFetch(201, { sid: 'SM1' });
    await twilioSender(config, f.impl)('8035550199', '123456 is your code');
    expect(f.calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
    const body = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({ To: '+18035550199', From: '+18035550000', Body: '123456 is your code' });
  });

  it('explains an unverified number on a trial account', async () => {
    const f = fakeFetch(400, { code: 21608, message: 'unverified' });
    await expect(twilioSender(config, f.impl)('8035550199', 'x')).rejects.toThrow(/not on the test list/);
  });

  it('gives a generic message for other failures', async () => {
    const f = fakeFetch(500, { code: 20500 });
    await expect(twilioSender(config, f.impl)('8035550199', 'x')).rejects.toMatchObject({ status: 502 });
  });

  it('uses Twilio only when all three settings are present', () => {
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' })).toBeUndefined();
    expect(smsSenderFromEnv({}).name).toBe('server log');
    expect(smsSenderFromEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+18035550000' }).name).toBe('Twilio (+18035550000)');
  });

  it('a failed text does not use up the hourly limit or leave a code', async () => {
    const now = new Date('2026-10-05T16:00:00Z');
    const repo = new Repo(seedData(now), () => {}, () => now);
    const api = new MemberApi(repo, () => Promise.reject(new Error('down')), () => now);
    for (let i = 0; i < 6; i++) await expect(api.requestCode('8035550199')).rejects.toThrow('down');
    expect(repo.data.auth?.codes['8035550199']).toBeUndefined();
  });
});
