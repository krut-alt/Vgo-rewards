// Core data model for the VGO Rewards rules engine.
// Every reward, earn rule and offer is data, so the jobber can create, edit,
// pause and retire them in the console without a code change.
// Money is integer cents. Fuel volume is gallons (decimal).

export type StoreId = string;
export type GroupId = string;
export type MemberId = string;

export interface Store {
  id: StoreId;
  name: string;
  groupIds: GroupId[];
  pos: 'verifone-commander' | 'gilbarco-passport' | 'ncr-radiant' | 'other';
  loyaltyLive: boolean;
}

/** Where a rule applies. Nothing is chain-wide unless the scope says `all`. */
export type Scope =
  | { kind: 'all' }
  | { kind: 'stores'; storeIds: StoreId[] }
  | { kind: 'groups'; groupIds: GroupId[] };

export type RuleStatus = 'draft' | 'active' | 'paused' | 'retired';
/** `split` means jobber and store each pay half. */
export type FundedBy = 'jobber' | 'store' | 'split' | 'manufacturer';
export type Period = 'day' | 'week' | 'month' | 'year' | 'lifetime';

export interface Schedule {
  startsAt?: string; // ISO date-time, inclusive
  endsAt?: string; // ISO date-time, exclusive
  daysOfWeek?: number[]; // 0 = Sunday
  hours?: { from: number; to: number }; // local store hour, from inclusive, to exclusive
}

export type Condition =
  | { type: 'minInsideSpend'; cents: number; excludeCategories?: string[] }
  | { type: 'hasItem'; skus?: string[]; categories?: string[]; minQty?: number }
  | { type: 'minGallons'; gallons: number }
  | { type: 'fuelGrade'; grades: string[] }
  | { type: 'memberTag'; tags: string[] }
  | { type: 'firstVisit' }
  /**
   * The member's birthday: on the day itself, the 7 days starting on it, or the whole month.
   * Needs the member's birthday (month and day) and the transaction's store-local date.
   */
  | { type: 'birthday'; window: 'day' | 'week' | 'month' }
  /** Only members at least this old on the store's local date, e.g. 21 for alcohol and tobacco. */
  | { type: 'minAge'; years: number };

export type Effect =
  | { type: 'pointsPerDollar'; points: number; categories?: string[]; excludeCategories?: string[] }
  | { type: 'pointsPerGallon'; points: number; maxGallons?: number }
  | { type: 'pointsFlat'; points: number }
  /**
   * Cents off per gallon. With `costPoints` it is a points redemption: it applies only
   * when the member chose it for this visit (`Transaction.redeemRuleIds`).
   */
  | { type: 'fuelDiscount'; centsPerGallon: number; maxGallons: number; costPoints?: number }
  | {
      type: 'itemDiscount';
      skus?: string[];
      categories?: string[];
      centsOff?: number;
      percentOff?: number;
      maxQty: number;
      /** Points redemption, chosen by the member like a fuel redemption. */
      costPoints?: number;
    }
  | { type: 'basketDiscount'; centsOff: number }
  /** Buy `every` matching items, the next one free (cheapest matching item). */
  | { type: 'punchCard'; cardId: string; skus?: string[]; categories?: string[]; every: number };

export interface Rule {
  id: string;
  name: string;
  status: RuleStatus;
  scope: Scope;
  schedule?: Schedule;
  conditions: Condition[];
  effect: Effect;
  /** Max times one member can receive this rule per period. */
  perMemberLimit?: { count: number; period: Period };
  /**
   * Rules sharing a stacking group are exclusive: only the most valuable one applies.
   * All fuel discounts share the `fuel` group by default.
   */
  stackingGroup?: string;
  priority?: number;
  /** The member has to add it to their card in the app before it applies. */
  requiresClip?: boolean;
  /** Most discount (cents) this rule may give in a calendar month across all members. */
  monthlyBudgetCents?: number;
  fundedBy: FundedBy;
  createdBy: { role: Role; userId: string; storeId?: StoreId };
}

export type Role = 'jobber-admin' | 'jobber-marketer' | 'store-manager';

export interface LineItem {
  sku: string;
  category: string;
  qty: number;
  unitCents: number;
}

export interface FuelLine {
  grade: string;
  gallons: number;
  pricePerGallonCents: number;
}

export interface Transaction {
  id: string;
  storeId: StoreId;
  at: string; // ISO date-time
  localHour: number; // store-local hour 0-23
  localDayOfWeek: number; // store-local 0 = Sunday
  /** Store-local date, YYYY-MM-DD. Needed for birthday rules. */
  localDate?: string;
  items: LineItem[];
  fuel?: FuelLine;
  /** Points redemptions the member picked in the app or at the register for this visit. */
  redeemRuleIds?: string[];
}

export interface Member {
  id: MemberId;
  tags: string[];
  pointsBalance: number;
  visitCount: number;
  punches: Record<string, number>;
  /** Offers the member added to their card in the app. */
  clippedRuleIds?: string[];
  /** Month and day, MM-DD. */
  birthday?: string;
  /** Full date of birth, YYYY-MM-DD, given when joining. Age-limited rules need it. */
  birthDate?: string;
}

/** How often each rule was already used by this member, per period. */
export type UsageLookup = (ruleId: string, period: Period) => number;

/** Program-wide controls the jobber sets in the console. */
export interface EvaluateOptions {
  /** Discount cents a rule already gave this calendar month, for `monthlyBudgetCents`. */
  budgetUsed?: (ruleId: string) => number;
  /**
   * `best`: one fuel discount per fill-up, the largest wins (default).
   * `stack`: fuel discounts add up, capped at `maxCentsPerGallon`.
   */
  fuelStacking?: { mode: 'best' } | { mode: 'stack'; maxCentsPerGallon: number };
}

export interface AppliedDiscount {
  ruleId: string;
  kind: 'fuel' | 'item' | 'basket' | 'punch';
  centsOff: number;
  /** Set for fuel discounts, so the POS can apply cents per gallon at the pump. */
  centsPerGallon?: number;
  maxGallons?: number;
  pointsSpent?: number;
  fundedBy: FundedBy;
}

export interface EvaluationResult {
  pointsEarned: number;
  pointsSpent: number;
  discounts: AppliedDiscount[];
  punches: Record<string, number>; // new punch count per card after this transaction
  appliedRuleIds: string[];
}
