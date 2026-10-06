import type { ItemCatalog } from './items.js';
import type { MediaInfo } from './media.js';
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
  /**
   * Near-store promo: the app only shows it to members within this many miles of a targeted
   * store, and they add it to their card there. Redeemed at the register like any card offer.
   */
  geofence?: { radiusMiles: number };
  /** Artwork shown on the reward in the app (an uploaded flyer or picture, stored at 1200×675). */
  artwork?: { mediaId: string };
  /** Built-in picture when there is no artwork: a picture id from the stock catalog, 'none' for a plain banner, or empty to pick by keywords. */
  stockArt?: string;
  /** Big promo text on the app card when there is no artwork, e.g. "25¢ OFF". Made from the reward when empty. */
  headline?: string;
  /** Shown in the big slider at the top of the app's home screen. */
  featured?: boolean;
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
  /** Map location, for near-store offers. */
  lat?: number;
  lng?: number;
  loyaltyLive: boolean;
  /** Store locator in the app: a photo from the artwork library, a short promo line and opening hours. */
  photoMediaId?: string;
  tagline?: string;
  hours?: string;
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
  /** Optional. The phone number stays the member ID and how they sign in. */
  email?: string;
  /** Agreed to offer emails; can be changed in the app. */
  emailOptIn?: boolean;
  /** When the member last turned offer texts or emails on, kept as proof of consent. */
  smsOptInAt?: string;
  emailOptInAt?: string;
  /** Month and day only (MM-DD), for birthday rewards. Kept in step with `birthDate`. */
  birthday?: string;
  /** Full date of birth (YYYY-MM-DD), asked at sign-up: members must be 18+, some offers 21+. */
  birthDate?: string;
  zip?: string;
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
  /** Who runs the program, shown on the app's terms and privacy pages. */
  legal?: ProgramContact;
  /**
   * POS department (number or name, as the POS link sends it) to our category, for lines the
   * items catalog does not know, e.g. { "12": "tobacco" }. Names like "Cold Drinks" match on their own.
   */
  posDepartments?: Record<string, string>;
}

export interface ProgramContact {
  companyName?: string;
  email?: string;
  phone?: string;
  address?: string;
  /** State whose laws govern the terms, two letters. */
  governingState?: string;
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

/** Someone who signs in to the back-office portal. */
export interface PortalUser {
  id: string;
  name: string;
  /** Lowercase; used to sign in. */
  email: string;
  /** Admins see and change everything; store users see only their own locations. */
  role: 'admin' | 'store';
  /** The locations a store user can see and run offers for. */
  storeIds: string[];
  /** scrypt$salt$hash */
  passwordHash: string;
  createdAt: string;
  lastSignInAt?: string;
}

/** Portal sign-in state. Session tokens are stored hashed. */
export interface PortalAuth {
  users: PortalUser[];
  sessions: Record<string, { userId: string; expiresAt: string }>;
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
  portal?: PortalAuth;
  /** Uploaded reward artwork; the image bytes live in the media store. */
  media?: MediaInfo[];
  /** The latest uploaded pricebook. */
  items?: ItemCatalog;
  /** Data updates already applied to this file; see migrate.ts. */
  migrations?: string[];
  /** When the pilot started, for "day 45 of 90" on Results. */
  pilot: { storeId: StoreId; startedOn: string; days: number };
}
