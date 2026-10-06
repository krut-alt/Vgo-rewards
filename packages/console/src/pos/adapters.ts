// Link adapters: each POS link vendor sends the Conexxus loyalty messages in its own wire format.
// An adapter reads the vendor's request into a LinkRequest and writes our LinkAnswer back in the
// vendor's shape. Add one file per vendor here once their API docs arrive, then pick it with
// VGO_POS_LINK on Render. `vgo` is our own JSON format: the mock link speaks it, and a vendor
// that lets the program host define the format can call it as is.
import { ConsoleError } from '../repo.js';
import type { LinkAnswer, LinkFinalize, LinkLine, LinkOp, LinkRequest, LinkSale } from './link.js';

export interface PosLinkAdapter {
  id: string;
  /** The vendor's request body to our message. Throws ConsoleError (400) on a bad request. */
  read(op: string, body: unknown): LinkRequest;
  /** Our answer to the vendor's response body. */
  write(answer: LinkAnswer): unknown;
}

const OPS: LinkOp[] = ['identify', 'rewards', 'finalize', 'cancel'];

function bad(message: string): never {
  throw new ConsoleError(message, 400);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${what} must be an object.`);
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') return required ? bad(`"${key}" is required.`) : undefined;
  if (typeof v !== 'string' && typeof v !== 'number') bad(`"${key}" must be text.`);
  return String(v);
}

function num(o: Record<string, unknown>, key: string, required = true): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return required ? bad(`"${key}" is required.`) : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad(`"${key}" must be a number, 0 or more.`);
  return v;
}

function readLine(v: unknown, i: number): LinkLine {
  const o = obj(v, `lines[${i}]`);
  const qty = num(o, 'qty')!;
  if (!Number.isInteger(qty)) bad(`lines[${i}].qty must be a whole number.`);
  return {
    lineId: str(o, 'lineId', false) ?? String(i + 1),
    posCode: str(o, 'posCode', false),
    department: str(o, 'department', false),
    description: str(o, 'description', false),
    qty,
    unitCents: Math.round(num(o, 'unitCents')!),
  };
}

function readSale(o: Record<string, unknown>): LinkSale {
  const lines = o.lines ?? [];
  if (!Array.isArray(lines)) bad('"lines" must be a list.');
  if (lines.length > 500) bad('A sale can have at most 500 lines.');
  const fuel = o.fuel === undefined || o.fuel === null ? undefined : obj(o.fuel, 'fuel');
  const redeem = o.redeem;
  if (redeem !== undefined && (!Array.isArray(redeem) || redeem.some((r) => typeof r !== 'string'))) bad('"redeem" must be a list of reward ids.');
  return {
    siteId: str(o, 'siteId')!,
    linkTxId: str(o, 'linkTxId')!,
    at: str(o, 'at')!,
    loyaltyId: str(o, 'loyaltyId', false),
    lines: lines.map(readLine),
    ...(fuel ? { fuel: { grade: str(fuel, 'grade')!, gallons: num(fuel, 'gallons', false), pricePerGallonCents: Math.round(num(fuel, 'pricePerGallonCents')!) } } : {}),
    ...(redeem ? { redeem: redeem as string[] } : {}),
  };
}

/** Our own JSON format, field for field the messages in link.ts. */
export const vgoAdapter: PosLinkAdapter = {
  id: 'vgo',
  read(op, body) {
    if (!OPS.includes(op as LinkOp)) throw new ConsoleError('Not found.', 404);
    const o = obj(body, 'The request');
    switch (op as LinkOp) {
      case 'identify':
        return { op: 'identify', siteId: str(o, 'siteId')!, loyaltyId: str(o, 'loyaltyId')! };
      case 'rewards':
        return { op: 'rewards', sale: readSale(o) };
      case 'finalize': {
        const applied = o.applied ?? [];
        if (!Array.isArray(applied)) bad('"applied" must be a list.');
        const sale: LinkFinalize = {
          ...readSale(o),
          applied: applied.map((a, i) => {
            const x = obj(a, `applied[${i}]`);
            return { rewardId: str(x, 'rewardId')!, centsOff: num(x, 'centsOff', false) };
          }),
        };
        return { op: 'finalize', sale };
      }
      case 'cancel':
        return { op: 'cancel', siteId: str(o, 'siteId')!, linkTxId: str(o, 'linkTxId')! };
    }
  },
  write(answer) {
    return answer;
  },
};

export const ADAPTERS: Record<string, PosLinkAdapter> = { vgo: vgoAdapter };

export function adapterFor(id: string | undefined): PosLinkAdapter {
  const a = ADAPTERS[id || 'vgo'];
  if (!a) throw new Error(`Unknown POS link adapter "${id}". Known: ${Object.keys(ADAPTERS).join(', ')}.`);
  return a;
}
