import { describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { smsFromEnv, twilioConfigFromEnv, twilioSender, twilioVerify } from '../src/sms.js';

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

  it('explains texting the program’s own number', async () => {
    const f = fakeFetch(400, { code: 21266, message: 'To and From cannot be the same' });
    await expect(twilioSender(config, f.impl)('8035550000', 'x')).rejects.toThrow(/our texting number/);
  });

  it('names setup problems and shows the Twilio error number', async () => {
    const f = fakeFetch(401, { code: 20003, message: 'Authenticate' });
    await expect(twilioSender(config, f.impl)('8035550199', 'x')).rejects.toThrow('Twilio rejected the account SID or auth token. (Twilio error 20003)');
    const g = fakeFetch(400, { code: 21659, message: 'not a Twilio phone number' });
    await expect(twilioSender(config, g.impl)('8035550199', 'x')).rejects.toThrow(/not a Twilio number/);
  });

  it('gives a generic message for other failures', async () => {
    const f = fakeFetch(500, { code: 20500 });
    await expect(twilioSender(config, f.impl)('8035550199', 'x')).rejects.toMatchObject({ status: 502 });
  });

  it('ignores quotes and spaces pasted around settings', () => {
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: ' "AC1" ', TWILIO_AUTH_TOKEN: "'tok'", TWILIO_FROM: '+17372583478 ' })).toEqual({
      accountSid: 'AC1', authToken: 'tok', from: '+17372583478',
    });
  });

  it('uses Twilio only when all three settings are present', () => {
    expect(twilioConfigFromEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' })).toBeUndefined();
    expect(smsFromEnv({}).name).toBe('server log');
    expect(smsFromEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+18035550000' }).name).toBe('Twilio (+18035550000)');
  });

  it('a failed text does not use up the hourly limit or leave a code', async () => {
    const now = new Date('2026-10-05T16:00:00Z');
    const repo = new Repo(seedData(now), () => {}, () => now);
    const api = new MemberApi(repo, () => Promise.reject(new Error('down')), () => now);
    for (let i = 0; i < 6; i++) await expect(api.requestCode('8035550199')).rejects.toThrow('down');
    expect(repo.data.auth?.codes['8035550199']).toBeUndefined();
  });
});

describe('Twilio Verify sign-in', () => {
  const verifyConfig = { accountSid: 'AC123', authToken: 'secret', serviceSid: 'VA9' };

  function fakeVerify(code: string) {
    const calls: string[] = [];
    let approved = false;
    const impl = (async (url: string, init: RequestInit) => {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push(url.replace('https://verify.twilio.com/v2/Services/VA9', ''));
      if (url.endsWith('/Verifications')) return new Response(JSON.stringify({ status: 'pending' }), { status: 201 });
      if (approved) return new Response(JSON.stringify({ code: 20404 }), { status: 404 }); // used up
      approved = form.Code === code;
      return new Response(JSON.stringify({ status: approved ? 'approved' : 'pending' }));
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('lets Twilio send and check the code, and the sign-up step reuse it', async () => {
    const f = fakeVerify('482913');
    const now = new Date('2026-10-05T16:00:00Z');
    const repo = new Repo(seedData(now), () => {}, () => now);
    const api = new MemberApi(repo, () => Promise.reject(new Error('should not text')), () => now, false, twilioVerify(verifyConfig, f.impl));
    expect(await api.requestCode('8643250000')).toEqual({ sent: true });
    await expect(api.verify('8643250000', '000000')).rejects.toThrow(/does not match/);
    expect(await api.verify('8643250000', '482913')).toEqual({ needsSignup: true });
    const joined = await api.verify('8643250000', '482913', { firstName: 'Krut' });
    expect(joined).toMatchObject({ isNew: true });
    expect(f.calls).toEqual(['/Verifications', '/VerificationCheck', '/VerificationCheck']);
  });

  it('is picked when the Verify service SID is set', () => {
    const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+17372583478', TWILIO_VERIFY_SID: 'VA9' };
    expect(smsFromEnv(env).name).toBe('Twilio Verify (VA9)');
    expect(smsFromEnv(env).codeService).toBeDefined();
  });
});
