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
/** Trims spaces and any quotes pasted along with a value from a .env file. */
export function cleanSetting(value: string | undefined): string | undefined {
  return value?.trim().replace(/^(["'])(.*)\1$/, '$2').trim() || undefined;
}

export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | undefined {
  const accountSid = cleanSetting(env.TWILIO_ACCOUNT_SID);
  const authToken = cleanSetting(env.TWILIO_AUTH_TOKEN);
  const from = cleanSetting(env.TWILIO_FROM);
  return accountSid && authToken && from ? { accountSid, authToken, from } : undefined;
}

// Twilio error codes a member can do something about.
const TWILIO_MESSAGES: Record<number, string> = {
  20003: 'Texting is not set up right: Twilio rejected the account SID or auth token.',
  21212: 'Texting is not set up right: the sending number is not valid. Use +1 and 10 digits.',
  21606: 'Texting is not set up right: the sending number is not a Twilio number on this account.',
  21659: 'Texting is not set up right: the sending number is not a Twilio number on this account.',
  21211: 'That phone number is not valid.',
  21266: 'That is our texting number. Enter your own mobile number.',
  21608: 'This number is not on the test list yet. Ask VGO to add it.', // trial accounts text verified numbers only
  60200: 'That phone number is not valid.',
  60203: 'Too many codes sent to this number. Try again later.',
  60202: 'Too many tries. Send a new code.',
  20404: 'Texting is not set up right: Twilio can’t find the Verify service.',
  21610: 'This number has opted out of texts. Text START to our number, then try again.',
  21614: 'That number can’t receive texts. Use a mobile number.',
};

/** POSTs a form to Twilio and turns its errors into messages a member can act on. */
async function twilioPost(url: string, auth: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch (err) {
    console.error('[sms] Twilio unreachable:', err);
    throw new ConsoleError('We couldn’t send the text right now. Try again in a minute.', 502);
  }
  return res;
}

async function twilioError(res: Response): Promise<never> {
  const detail = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  console.error(`[sms] Twilio ${res.status} ${detail.code ?? ''}: ${detail.message ?? ''}`);
  const known = detail.code !== undefined ? TWILIO_MESSAGES[detail.code] : undefined;
  const ref = ` (Twilio error ${detail.code ?? res.status})`;
  throw new ConsoleError(known ? known + ref : `We couldn’t send the text right now.${ref}`, known ? 400 : 502);
}

const basicAuth = (c: { accountSid: string; authToken: string }) => Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');

export function twilioSender(config: TwilioConfig, fetchImpl: typeof fetch = fetch): SmsSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const auth = basicAuth(config);
  return async (phone, text) => {
    const res = await twilioPost(url, auth, { To: `+1${phone}`, From: config.from, Body: text }, fetchImpl);
    if (!res.ok) await twilioError(res);
  };
}

/**
 * Sends and checks sign-in codes through Twilio Verify, which writes the text itself.
 * Trial accounts can use Verify, but not custom message text.
 */
export interface CodeService {
  start(phone: string): Promise<void>;
  /** True when the code is right; false when it is wrong or expired. */
  check(phone: string, code: string): Promise<boolean>;
}

export interface TwilioVerifyConfig {
  accountSid: string;
  authToken: string;
  /** The Verify service SID, starting with VA. */
  serviceSid: string;
}

export function twilioVerifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioVerifyConfig | undefined {
  const accountSid = cleanSetting(env.TWILIO_ACCOUNT_SID);
  const authToken = cleanSetting(env.TWILIO_AUTH_TOKEN);
  const serviceSid = cleanSetting(env.TWILIO_VERIFY_SID);
  return accountSid && authToken && serviceSid ? { accountSid, authToken, serviceSid } : undefined;
}

export function twilioVerify(config: TwilioVerifyConfig, fetchImpl: typeof fetch = fetch): CodeService {
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.serviceSid)}`;
  const auth = basicAuth(config);
  return {
    async start(phone) {
      const res = await twilioPost(`${base}/Verifications`, auth, { To: `+1${phone}`, Channel: 'sms' }, fetchImpl);
      if (!res.ok) await twilioError(res);
    },
    async check(phone, code) {
      const res = await twilioPost(`${base}/VerificationCheck`, auth, { To: `+1${phone}`, Code: code }, fetchImpl);
      if (res.status === 404) return false; // expired, used up or never sent
      if (!res.ok) await twilioError(res);
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return body.status === 'approved';
    },
  };
}

/** Twilio Verify when its service SID is set, else Twilio texts, else the server log. */
export function smsFromEnv(env: NodeJS.ProcessEnv = process.env): { sender: SmsSender; codeService?: CodeService; name: string } {
  const verify = twilioVerifyConfigFromEnv(env);
  if (verify) return { sender: logSender, codeService: twilioVerify(verify), name: `Twilio Verify (${verify.serviceSid})` };
  const config = twilioConfigFromEnv(env);
  return config ? { sender: twilioSender(config), name: `Twilio (${config.from})` } : { sender: logSender, name: 'server log' };
}
