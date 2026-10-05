// Text message senders for sign-in codes. Twilio is used when its settings are present;
// otherwise codes go to the server log.
import type { SmsSender } from './member-api.js';
import { logSender } from './member-api.js';
import { ConsoleError } from './repo.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The Twilio number texts come from, as +1XXXXXXXXXX. */
  from: string;
}

/** Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM; undefined when any is missing. */
export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | undefined {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM?.trim();
  return accountSid && authToken && from ? { accountSid, authToken, from } : undefined;
}

// Twilio error codes a member can do something about.
const TWILIO_MESSAGES: Record<number, string> = {
  21211: 'That phone number is not valid.',
  21608: 'This number is not on the test list yet. Ask VGO to add it.', // trial accounts text verified numbers only
  21610: 'This number has opted out of texts. Text START to our number, then try again.',
  21614: 'That number can’t receive texts. Use a mobile number.',
};

export function twilioSender(config: TwilioConfig, fetchImpl: typeof fetch = fetch): SmsSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  return async (phone, text) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: `+1${phone}`, From: config.from, Body: text }),
      });
    } catch (err) {
      console.error('[sms] Twilio unreachable:', err);
      throw new ConsoleError('We couldn’t send the text right now. Try again in a minute.', 502);
    }
    if (res.ok) return;
    const detail = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    console.error(`[sms] Twilio ${res.status} ${detail.code ?? ''}: ${detail.message ?? ''}`);
    const known = detail.code !== undefined ? TWILIO_MESSAGES[detail.code] : undefined;
    throw new ConsoleError(known ?? 'We couldn’t send the text right now. Try again in a minute.', known ? 400 : 502);
  };
}

/** Twilio when configured, else the server log. */
export function smsSenderFromEnv(env: NodeJS.ProcessEnv = process.env): { sender: SmsSender; name: string } {
  const config = twilioConfigFromEnv(env);
  return config ? { sender: twilioSender(config), name: `Twilio (${config.from})` } : { sender: logSender, name: 'server log' };
}
