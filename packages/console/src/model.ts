// Console data model: what the jobber manages, stored as one JSON document for the pilot.
import type { Rule, StoreId, Transaction } from '../../engine/src/index.js';

/** Where a rule shows up in the console. Earn and redeem live on Reward rules, the rest on Offers. */
export type Section = 'earn' | 'redeem' | 'offer';

export interface ConsoleRule extends Rule {
  section: Section;
  /** Short line members see in the app, e.g. "Buy 8+ gallons and a sandwich in the same visit." */
  memberText?: string;
  /** Set on the welcome reward, which Program settings edits. */
  welcome?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleStore {
  id: StoreId;
  /** Site name, e.g. "VGO 01". */
  name: string;
  /** Street address. */
  address?: string;
  city: string;
  /** Two-letter state. */
  state: string;
  zip?: string;
  contactName?: string;
  email?: string;
  /** 10 digits. */
  phone?: string;
  groupIds: string[];
  pos: 'verifone-commander' | 'gilbarco-passport' | 'ncr-radiant' | 'other';
  /** The site ID the POS loyalty link uses for this store, filled in when the link is set up. */
  posSiteId?: string;
  loyaltyLive: boolean;
  /** POS categories mapped for this store, e.g. "sandwiches". Offers on unmapped categories get a warning. */
  mappedCategories: string[];
}

export interface StoreGroup {
  id: string;
  name: string;
}

export interface ConsoleMember {
  id: string;
  name: string;
  phone: string;
  homeStoreId?: StoreId;
  tags: string[];
  pointsBalance: number;
  visitCount: number;
  punches: Record<string, number>;
  joinedAt: string;
  lastVisitAt?: string;
  /** Agreed to offer texts at sign-up; can be changed in the app. */
  smsOptIn?: boolean;
  /** Offers the member added to their card in the app. */
  clippedRuleIds?: string[];
  /** Points redemptions the member picked in the app for their next visit. */
  nextVisitRedeem?: string[];
}

export interface Branding {
  programName: string;
  /** Data URL of the uploaded logo, or empty for the text logo. */
  logoDataUrl: string;
  mainColor: string;
  accentColor: string;
}

export interface ProgramSettings {
  /** Months without a visit before points expire; 0 means never. */
  pointsExpireMonths: number;
  fuelStacking: { mode: 'best' } | { mode: 'stack'; maxCentsPerGallon: number };
  maxStoreDiscountCents: number;
  storeManagersCanCreate: boolean;
  monthlyBudgetCents: number;
}

/** A processed POS transaction and what the program gave on it. `memberId` is empty for non-members. */
export interface LedgerEntry {
  tx: Transaction;
  /** Store-local date of the transaction, for daily, weekly and monthly limits. */
  ymd: string;
  memberId?: string;
  pointsEarned: number;
  pointsSpent: number;
  appliedRuleIds: string[];
  discounts: { ruleId: string; centsOff: number }[];
  sample?: boolean;
}

/** Member sign-in state for the app. Codes and tokens are stored hashed. */
export interface AppAuth {
  codes: Record<string, { hash: string; expiresAt: string; attempts: number; sentAt: string[] }>;
  sessions: Record<string, { memberId: string; expiresAt: string }>;
}

export interface ChangeEntry {
  at: string;
  userId: string;
  what: string;
}

export interface ConsoleData {
  version: 1;
  stores: ConsoleStore[];
  groups: StoreGroup[];
  rules: ConsoleRule[];
  members: ConsoleMember[];
  ledger: LedgerEntry[];
  branding: Branding;
  settings: ProgramSettings;
  history: ChangeEntry[];
  auth?: AppAuth;
  /** Data updates already applied to this file; see migrate.ts. */
  migrations?: string[];
  /** When the pilot started, for "day 45 of 90" on Results. */
  pilot: { storeId: StoreId; startedOn: string; days: number };
}
