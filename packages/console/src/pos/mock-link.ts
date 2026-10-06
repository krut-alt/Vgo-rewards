// A pretend store POS that drives sales through the link the way a Commander or Passport would:
// scan the member, ask for rewards, apply them, pay, finalize. Tests run it in process; the
// mock-cli script runs it against a live server so the whole path can be tried before the vendor is.
import type { LinkAnswer, LinkFuel, LinkLine, LinkOp, LinkReward } from './link.js';

/** Sends one link message and returns the answer, e.g. over HTTP to /api/pos/link/<op>. */
export type LinkTransport = (op: LinkOp, body: Record<string, unknown>) => Promise<LinkAnswer>;

type RewardsAnswer = Extract<LinkAnswer, { op: 'rewards' }>;
type FinalizeAnswer = Extract<LinkAnswer, { op: 'finalize' }>;

export class MockSale {
  readonly lines: LinkLine[] = [];
  fuel?: LinkFuel;
  loyaltyId?: string;
  redeem: string[] = [];
  offered: LinkReward[] = [];

  constructor(
    private send: LinkTransport,
    readonly siteId: string,
    readonly linkTxId: string,
    readonly at: string,
  ) {}

  /** Cashier scans the app barcode, or the customer types their phone on the PIN pad. */
  async identify(loyaltyId: string) {
    this.loyaltyId = loyaltyId;
    return this.send('identify', { siteId: this.siteId, loyaltyId });
  }

  ring(posCode: string, department: string, unitCents: number, qty = 1): this {
    this.lines.push({ lineId: String(this.lines.length + 1), posCode, department, qty, unitCents });
    return this;
  }

  private body(extra: Record<string, unknown> = {}) {
    return { siteId: this.siteId, linkTxId: this.linkTxId, at: this.at, loyaltyId: this.loyaltyId, lines: this.lines, fuel: this.fuel, redeem: this.redeem, ...extra };
  }

  /** Before fueling or before tender: what does the member get? */
  async getRewards(): Promise<RewardsAnswer> {
    const answer = (await this.send('rewards', this.body())) as RewardsAnswer;
    this.offered = answer.rewards;
    return answer;
  }

  /** Customer pumps fuel; the fuel discount from getRewards is applied per gallon, up to its cap. */
  pump(grade: string, gallons: number, pricePerGallonCents: number): this {
    this.fuel = { grade, gallons, pricePerGallonCents };
    return this;
  }

  /**
   * Payment done. The POS reports what it applied: by default everything offered on the last
   * getRewards, with fuel cents worked out from the gallons pumped.
   */
  async finalize(skip: string[] = []): Promise<FinalizeAnswer> {
    const applied = this.offered
      .filter((r) => !skip.includes(r.rewardId))
      .map((r) => ({
        rewardId: r.rewardId,
        centsOff: r.centsPerGallon !== undefined ? Math.round(Math.min(this.fuel?.gallons ?? 0, r.maxGallons ?? Infinity) * r.centsPerGallon) : r.centsOff,
      }));
    return (await this.send('finalize', this.body({ applied }))) as FinalizeAnswer;
  }

  async cancel() {
    return this.send('cancel', { siteId: this.siteId, linkTxId: this.linkTxId });
  }
}

/** A transport that posts to a running server with the POS key. */
export function httpTransport(baseUrl: string, posKey?: string): LinkTransport {
  return async (op, body) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/pos/link/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(posKey ? { authorization: `Bearer ${posKey}` } : {}) },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as LinkAnswer & { error?: string };
    if (!res.ok) throw new Error(`${op}: ${res.status} ${data.error ?? ''}`.trim());
    return data;
  };
}
