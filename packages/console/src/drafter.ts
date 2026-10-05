// Turns a sentence like "Earn 2x points on premium fuel on weekends at SC stores until Dec 31"
// into a rule. It always produces a paused rule: nothing goes live until someone reviews it.
// It reads the common ways people phrase c-store offers; anything it can't read is listed in
// `notes` so the jobber can set it with Adjust.
import type { Condition, Effect, Period, Schedule, Scope } from '../../engine/src/index.js';
import { CATEGORIES, FUEL_GRADES, NO_EARN_CATEGORIES, categoryLabel, gradeLabel, listLabel } from './catalog.js';
import { DAY_NAMES, addDays, dayList, localMidnight, localParts, monthIndex, shortDate } from './dates.js';
import { hourLabel, money, targetLabel } from './labels.js';
import type { ConsoleStore, StoreGroup } from './model.js';
import type { RuleInput } from './repo.js';

export interface DraftContext {
  stores: ConsoleStore[];
  groups: StoreGroup[];
  now: Date;
}

export type Draft =
  | { ok: true; rule: RuleInput; chips: string[]; notes: string[] }
  | { ok: false; error: string };

const EXAMPLES = [
  'Earn 2x points on premium fuel on weekends at SC stores until Dec 31',
  '10 cents off per gallon on Tuesdays at the pilot store',
  '$1 off any sandwich with a fill-up at VGO 01',
  'Buy 5 coffees, get the 6th free',
  '200 points for a free fountain drink',
];

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${escape(word)}([^a-z0-9]|$)`).test(text);

/** Category ids mentioned in the text, longest phrases first so "fountain drink" beats "drink". */
function findCategories(text: string, skip: string[] = []): string[] {
  const found: string[] = [];
  let rest = text;
  const phrases = CATEGORIES.flatMap((c) => c.words.map((w) => ({ id: c.id, w }))).sort((a, b) => b.w.length - a.w.length);
  for (const { id, w } of phrases) {
    if (skip.includes(id) || !hasWord(rest, w)) continue;
    if (!found.includes(id)) found.push(id);
    rest = rest.replace(new RegExp(`(^|[^a-z0-9])${escape(w)}(?=[^a-z0-9]|$)`, 'g'), '$1 ');
  }
  return found;
}

function findGrades(text: string): string[] {
  return FUEL_GRADES.filter((g) => g.words.some((w) => hasWord(text, w))).map((g) => g.id);
}

function to24(h: number, ampm?: string): number {
  if (ampm === 'pm' && h < 12) return h + 12;
  if (ampm === 'am' && h === 12) return 0;
  return h;
}

function parseDate(text: string, today: string): string | undefined {
  const [y] = today.split('-').map(Number);
  let m: RegExpExecArray | null;
  let month: number;
  let day: number;
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text))) {
    month = monthIndex(m[1]!) + 1;
    day = Number(m[2]);
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text))) {
    month = Number(m[1]);
    day = Number(m[2]);
    if (m[3]) {
      const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  } else return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // A date without a year is the next time that date comes around.
  let ymd = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (ymd < today) ymd = `${y! + 1}${ymd.slice(4)}`;
  return ymd;
}

function findScope(text: string, ctx: DraftContext): { scope?: Scope; label?: string } {
  if (/\b(all|every)\s+(\d+\s+)?(stores|locations|sites)\b|\bportfolio\b|\bchain[- ]wide\b|\beverywhere\b/.test(text)) return { scope: { kind: 'all' } };
  const storeIds = ctx.stores
    .filter((s) => {
      const num = s.name.match(/\d+/)?.[0];
      return (
        hasWord(text, s.name.toLowerCase()) ||
        (num !== undefined && new RegExp(`\\b(store|vgo|location|site)\\s*#?\\s*0*${Number(num)}\\b`).test(text)) ||
        (s.city !== '' && hasWord(text, s.city.toLowerCase()))
      );
    })
    .map((s) => s.id);
  if (storeIds.length) return { scope: { kind: 'stores', storeIds } };
  const stateNames: Record<string, string[]> = { sc: ['south carolina'], nc: ['north carolina'], ga: ['georgia'] };
  const groupIds = ctx.groups
    .filter((g) => {
      const name = g.name.toLowerCase();
      const short = name.replace(/\s+stores?$/, '');
      return hasWord(text, name) || hasWord(text, short) || (stateNames[g.id] ?? []).some((n) => hasWord(text, n));
    })
    .map((g) => g.id);
  if (groupIds.length) return { scope: { kind: 'groups', groupIds } };
  return {};
}

function findDays(text: string): number[] | undefined {
  if (/\bweekends?\b/.test(text)) return [0, 6];
  if (/\bweekdays?\b/.test(text)) return [1, 2, 3, 4, 5];
  const days = DAY_NAMES.map((d, i) => (new RegExp(`\\b${d.toLowerCase().slice(0, 3)}(${d.toLowerCase().slice(3)})?s?\\b`).test(text) ? i : -1)).filter(
    (i) => i >= 0,
  );
  return days.length ? days : undefined;
}

function findHours(text: string): { from: number; to: number } | undefined {
  let m = /\b(?:from|between)\s+(\d{1,2})\s*(am|pm)?\s*(?:to|and|-|until)\s*(\d{1,2})\s*(am|pm)\b/.exec(text);
  if (m) {
    const toAmPm = m[4]!;
    const from = to24(Number(m[1]), m[2] ?? (Number(m[1]) <= Number(m[3]) ? toAmPm : 'am'));
    return { from, to: to24(Number(m[3]), toAmPm) || 24 };
  }
  if ((m = /\b(\d{1,2})\s*(am|pm)\s*(?:-|to)\s*(\d{1,2})\s*(am|pm)\b/.exec(text)))
    return { from: to24(Number(m[1]), m[2]), to: to24(Number(m[3]), m[4]) || 24 };
  if ((m = /\bafter\s+(\d{1,2})\s*(am|pm)\b/.exec(text))) return { from: to24(Number(m[1]), m[2]), to: 24 };
  if ((m = /\bbefore\s+(\d{1,2})\s*(am|pm)\b/.exec(text))) return { from: 0, to: to24(Number(m[1]), m[2]) };
  if (/\bmornings?\b/.test(text)) return { from: 5, to: 11 };
  return undefined;
}

function findLimit(text: string): { count: number; period: Period } | undefined {
  const per = (w: string): Period => (w.startsWith('day') || w === 'daily' ? 'day' : w.startsWith('week') ? 'week' : 'month');
  let m = /\b(once|twice|(\d+)\s+times?)\s+(?:a|per|each)\s+(day|week|month)\b/.exec(text);
  if (m) return { count: m[1] === 'once' ? 1 : m[1] === 'twice' ? 2 : Number(m[2]), period: per(m[3]!) };
  if ((m = /\b(?:one|1)\s+per\s+(?:member|customer|person)\s+(?:a|per|each)\s+(day|week|month)\b/.exec(text))) return { count: 1, period: per(m[1]!) };
  if (/\b(?:one|1)\s+per\s+(?:member|customer|person)\b|\bonce per member\b|\bone time\b/.test(text)) return { count: 1, period: 'lifetime' };
  return undefined;
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function word(n: string): number {
  return NUM_WORDS[n] ?? Number(n);
}

export function draftRule(input: string, ctx: DraftContext): Draft {
  const text = ` ${input.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()} `;
  if (text.trim().length < 4) return { ok: false, error: `Describe the rule, for example: "${EXAMPLES[0]}".` };
  const today = localParts(ctx.now).ymd;
  const notes: string[] = [];
  const chips: string[] = [];
  const conditions: Condition[] = [];
  const fuelWords = /\b(gal|gals|gallons?|fuel|gas|fill[- ]?ups?|pump|premium|diesel|unleaded|regular|midgrade)\b/.test(text);
  const grades = findGrades(text);

  let effect: Effect | undefined;
  let section: RuleInput['section'] = 'offer';
  let stackingGroup: string | undefined;
  let name = '';
  let m: RegExpExecArray | null;

  // 1. Punch card: "buy 5 coffees, get the 6th free" / "buy 5 get 1 free".
  if ((m = /\bbuy\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b(.*?)\bget\b(.*?)\bfree\b/.exec(text))) {
    const every = word(m[1]!);
    const categories = findCategories(`${m[2]} ${m[3]}`);
    if (!categories.length) notes.push('Could not tell which items earn punches. Pick them with Adjust.');
    effect = { type: 'punchCard', cardId: `card-${categories.join('-') || 'items'}`, categories: categories.length ? categories : ['coffee'], every };
    const items = listLabel((categories.length ? categories : ['coffee']).map(categoryLabel)).toLowerCase();
    name = `Buy ${every} ${items}, ${ordinal(every + 1)} free`;
    chips.push(`Punch card: ${every} + 1 free`, listLabel((categories.length ? categories : ['coffee']).map(categoryLabel)));
  }

  // 2. Points redemption: "100 points = 10 cents a gallon" / "200 points for a free fountain drink".
  if (!effect && (m = /\b(\d[\d,]*)\s*(?:pts|points?)\s*(?:=|for|gets?|equals|to get|buys?|redeems? for)\s*(.+)/.exec(text))) {
    const costPoints = Number(m[1]!.replace(/,/g, ''));
    const rest = m[2]!;
    const cpg = /(\d+(?:\.\d+)?)\s*(?:¢|c\b|cents?)\s*(?:off\s*)?(?:\/|per|a|an|each)?\s*(?:gal|gallon)/.exec(rest);
    section = 'redeem';
    if (cpg) {
      const maxGallons = Number(/up to (\d+)\s*(?:gal|gallons)/.exec(text)?.[1] ?? 20);
      if (!/up to \d+\s*(?:gal|gallons)/.test(text)) notes.push('No gallon cap given, so it is capped at 20 gallons.');
      effect = { type: 'fuelDiscount', centsPerGallon: Math.round(Number(cpg[1])), maxGallons, costPoints };
      name = `${costPoints} points = ${effect.centsPerGallon}¢/gal`;
      chips.push(`${costPoints} points`, `${effect.centsPerGallon}¢/gal off, up to ${maxGallons} gal`);
    } else {
      const categories = findCategories(rest);
      if (!categories.length) return { ok: false, error: 'Could not tell what the points buy. Try "200 points for a free fountain drink".' };
      const off = /\$(\d+(?:\.\d{1,2})?)\s*off/.exec(rest);
      effect = off
        ? { type: 'itemDiscount', categories, centsOff: Math.round(Number(off[1]) * 100), maxQty: 1, costPoints }
        : { type: 'itemDiscount', categories, percentOff: 100, maxQty: 1, costPoints };
      const what = listLabel(categories.map(categoryLabel)).toLowerCase();
      name = off ? `${costPoints} points = ${money(effect.centsOff!)} off ${what}` : `${costPoints} points = free ${what}`;
      chips.push(`${costPoints} points`, off ? `${money(effect.centsOff!)} off ${what}` : `Free ${what}`);
    }
  }

  // 3. Fuel discount: "10 cents off per gallon", "10¢/gal", "a dime off a gallon".
  if (!effect && (m = /(\d+(?:\.\d+)?)\s*(?:¢|c\b|cents?)\s*(?:off\s*)?(?:\/|per|a|an|each|off)?\s*(?:gal|gallon)s?\b/.exec(text))) {
    const centsPerGallon = Math.round(Number(m[1]));
    const capMatch = /up to (\d+)\s*(?:gal|gallons)/.exec(text);
    const maxGallons = Number(capMatch?.[1] ?? 20);
    if (!capMatch) notes.push('No gallon cap given, so it is capped at 20 gallons.');
    effect = { type: 'fuelDiscount', centsPerGallon, maxGallons };
    name = `${/\bextra\b/.test(text) ? 'Extra ' : ''}${centsPerGallon}¢/gal off`;
    chips.push(`${centsPerGallon}¢/gal off, up to ${maxGallons} gal`);
  }

  // 4. Multiplier: "2x points on premium", "double points on snacks".
  if (!effect && (m = /\b(\d+)\s*x\b|\b(double|triple|quadruple)\b/.exec(text)) && /\bpoints?\b/.test(text)) {
    const mult = m[1] ? Number(m[1]) : { double: 2, triple: 3, quadruple: 4 }[m[2] as 'double'];
    section = 'earn';
    if (fuelWords || grades.length) {
      effect = { type: 'pointsPerGallon', points: mult };
      stackingGroup = 'earn-gallon';
      name = `${mult}x points on ${grades.length ? listLabel(grades.map(gradeLabel)).toLowerCase() : 'fuel'}`;
      chips.push(`Earn ${mult}x points`);
    } else {
      const categories = findCategories(text);
      effect = { type: 'pointsPerDollar', points: mult, ...(categories.length ? { categories } : { excludeCategories: NO_EARN_CATEGORIES }) };
      stackingGroup = 'earn-dollar';
      name = `${mult}x points on ${categories.length ? listLabel(categories.map(categoryLabel)).toLowerCase() : 'inside purchases'}`;
      chips.push(`Earn ${mult}x points`, categories.length ? listLabel(categories.map(categoryLabel)) : 'Inside purchases');
    }
    notes.push(`${mult}x replaces the normal earn rate while it runs; it does not add on top.`);
  }

  // 5. Earn rate: "3 points per dollar", "2 points per gallon".
  if (!effect && (m = /\b(\d+)\s*(?:pts|points?)\s*(?:per|for every|a|each)\s*(\$1|dollar|gallon|gal)\b/.exec(text))) {
    const points = Number(m[1]);
    section = 'earn';
    if (m[2]!.startsWith('gal')) {
      effect = { type: 'pointsPerGallon', points };
      stackingGroup = 'earn-gallon';
      name = `${points} ${points === 1 ? 'point' : 'points'} per gallon`;
    } else {
      const categories = findCategories(text, NO_EARN_CATEGORIES);
      effect = { type: 'pointsPerDollar', points, ...(categories.length ? { categories } : { excludeCategories: NO_EARN_CATEGORIES }) };
      stackingGroup = 'earn-dollar';
      name = `${points} ${points === 1 ? 'point' : 'points'} per $1${categories.length ? ` on ${listLabel(categories.map(categoryLabel)).toLowerCase()}` : ''}`;
    }
    chips.push(name.charAt(0).toUpperCase() + name.slice(1));
  }

  // 6. Flat bonus points: "50 bonus points on your first visit".
  if (!effect && (m = /\b(\d[\d,]*)\s*(?:bonus|extra)?\s*(?:pts|points?)\b/.exec(text))) {
    const points = Number(m[1]!.replace(/,/g, ''));
    effect = { type: 'pointsFlat', points };
    name = `${points} bonus points`;
    chips.push(`${points} bonus points`);
  }

  // 7. Item or basket discount: "$1 off any sandwich", "20% off snacks", "free coffee".
  if (!effect) {
    const dollars = /\$(\d+(?:\.\d{1,2})?)\s*off\b/.exec(text);
    const cents = /\b(\d+)\s*(?:¢|c|cents?)\s*off\b/.exec(text);
    const pct = /\b(\d{1,3})\s*%\s*off\b|\b(\d{1,3})\s*percent\s*off\b/.exec(text);
    const free = /\bfree\b/.test(text);
    // Items named after "with" are the qualifier (e.g. "with a coffee"), not the discounted item.
    const discountPart = text.split(/\bwith\b/)[0]!;
    const categories = findCategories(discountPart);
    if (dollars || cents || pct || free) {
      const centsOff = dollars ? Math.round(Number(dollars[1]) * 100) : cents ? Number(cents[1]) : undefined;
      const percentOff = pct ? Number(pct[1] ?? pct[2]) : !centsOff && free ? 100 : undefined;
      if (categories.length) {
        effect = { type: 'itemDiscount', categories, maxQty: 1, ...(percentOff !== undefined ? { percentOff } : { centsOff }) };
        const what = listLabel(categories.map(categoryLabel)).toLowerCase();
        name = percentOff === 100 ? `Free ${what}` : percentOff ? `${percentOff}% off ${what}` : `${money(centsOff!)} off ${what}`;
        conditions.push({ type: 'hasItem', categories });
      } else if (centsOff) {
        effect = { type: 'basketDiscount', centsOff };
        name = `${money(centsOff)} off the purchase`;
      } else {
        return { ok: false, error: 'Could not tell which item the discount is on. Try "20% off snacks".' };
      }
      chips.push(name);
    }
  }

  if (!effect) {
    return { ok: false, error: `Could not find the reward in that. Try something like "${EXAMPLES[1]}" or "${EXAMPLES[2]}".` };
  }

  // Qualifiers.
  if (grades.length && effect.type !== 'pointsFlat') {
    conditions.push({ type: 'fuelGrade', grades });
    chips.push(`${listLabel(grades.map(gradeLabel))} fuel`);
  }
  const gal = /\b(\d+(?:\.\d+)?)\s*\+?\s*(?:or more\s*)?(?:gal|gallons)\b/.exec(text.replace(/up to \d+\s*(?:gal|gallons)/g, ''));
  const fillUp = /\bwith (?:a |any )?(?:fill[- ]?up|fuel purchase|gas purchase|purchase of fuel)\b/.test(text);
  if (effect.type !== 'fuelDiscount' && effect.type !== 'pointsPerGallon' && (gal || fillUp)) {
    const gallons = gal ? Number(gal[1]) : 8;
    if (!gal) notes.push('A fill-up is set as 8 gallons or more.');
    conditions.push({ type: 'minGallons', gallons });
    chips.push(`With ${gallons}+ gallons`);
  }
  const withItem = /\bwith (?:a |an |any )?([a-z ]+?)(?: purchase)?(?: at | on | until | through | from | between | after | before |,|\.| $)/.exec(text);
  if (withItem && !/fill|fuel|gas/.test(withItem[1]!)) {
    const cats = findCategories(withItem[1]!);
    if (cats.length && !conditions.some((c) => c.type === 'hasItem' && c.categories?.join() === cats.join())) {
      conditions.push({ type: 'hasItem', categories: cats });
      chips.push(`With ${listLabel(cats.map(categoryLabel)).toLowerCase()}`);
    }
  }
  const spend = /\b(?:spend|spends|over|purchase of|orders? over)\s*\$(\d+(?:\.\d{1,2})?)/.exec(text);
  if (spend) {
    conditions.push({ type: 'minInsideSpend', cents: Math.round(Number(spend[1]) * 100), excludeCategories: NO_EARN_CATEGORIES });
    chips.push(`Spend $${spend[1]}+ inside`);
  }
  if (/\bfirst (?:visit|purchase|fill[- ]?up|time)\b|\bnew members?\b|\bwelcome\b/.test(text)) {
    conditions.push({ type: 'firstVisit' });
    chips.push('First visit');
  }

  // When.
  const schedule: Schedule = {};
  const days = findDays(text);
  if (days) {
    schedule.daysOfWeek = days;
    chips.push(days.join() === '0,6' ? 'Sat and Sun' : dayList(days));
  }
  const hours = findHours(text);
  if (hours) {
    schedule.hours = hours;
    chips.push(`${hourLabel(hours.from)} to ${hourLabel(hours.to)}`);
  }
  const range = /\b(?:from|starting|starts|beginning)\s+(.+?)\s+(?:to|until|through|thru|-)\s+(.+?)(?:$| at | on |,)/.exec(text);
  const startText = range?.[1] ?? /\b(?:starting|starts|beginning|from)\s+(?:on\s+)?(.+)/.exec(text)?.[1];
  const endText = range?.[2] ?? /\b(?:until|till|through|thru|ends?|ending)\s+(?:on\s+)?(.+)/.exec(text)?.[1];
  const start = startText ? parseDate(startText, today) : undefined;
  const end = endText ? parseDate(endText, today) : /\bthis weekend\b/.test(text) ? addDays(today, (7 - localParts(ctx.now).dayOfWeek) % 7) : undefined;
  if (/\bthis weekend\b/.test(text) && !start) schedule.startsAt = localMidnight(addDays(today, (6 - localParts(ctx.now).dayOfWeek + 7) % 7));
  if (start) {
    schedule.startsAt = localMidnight(start);
    chips.push(`Starts ${shortDate(start)}`);
  }
  if (end) {
    schedule.endsAt = localMidnight(addDays(end, 1));
    chips.push(`Ends ${shortDate(end)}`);
  }
  if (schedule.startsAt && schedule.endsAt && schedule.endsAt <= schedule.startsAt) {
    notes.push('The end date is before the start date. Fix the dates with Adjust.');
  }

  // Where.
  const { scope } = findScope(text, ctx);
  const finalScope: Scope = scope ?? { kind: 'all' };
  if (!scope) notes.push('No store or group named, so it targets all stores. Narrow it with Adjust.');
  chips.push(targetLabel(finalScope, ctx.stores, ctx.groups));

  // Limits and funding.
  const perMemberLimit = findLimit(text);
  if (perMemberLimit) chips.push(perMemberLimit.period === 'lifetime' ? `${perMemberLimit.count} per member` : perMemberLimit.period === 'year' ? `${perMemberLimit.count} per member per year` : `${perMemberLimit.count} per member per ${perMemberLimit.period}`);
  const fundedBy = /\b(manufacturer|brand)[- ]?(funded|pays|paid)?\b|\bskupos\b/.test(text)
    ? 'manufacturer'
    : /\bsplit\b|\b50\/50\b/.test(text)
      ? 'split'
      : /\bstore[- ](funded|pays|paid)\b/.test(text)
        ? 'store'
        : 'jobber';
  if (fundedBy !== 'jobber') chips.push(`Funded by ${fundedBy === 'split' ? 'jobber and store, 50/50' : fundedBy}`);

  if (days && !schedule.startsAt && !schedule.endsAt && effect.type === 'fuelDiscount') {
    notes.push('No dates given, so it runs every week until you end it.');
  }

  const rule: RuleInput = {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    section,
    status: 'paused',
    scope: finalScope,
    conditions,
    effect,
    fundedBy,
    ...(Object.keys(schedule).length ? { schedule } : {}),
    ...(perMemberLimit ? { perMemberLimit } : {}),
    ...(stackingGroup ? { stackingGroup } : {}),
  };
  return { ok: true, rule, chips, notes };
}

export { EXAMPLES as DRAFT_EXAMPLES };
