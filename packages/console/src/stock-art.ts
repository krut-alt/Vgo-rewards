import type { ConsoleRule } from './model.js';
import type { ItemCatalog } from './items.js';

/**
 * Built-in reward pictures (original illustrations in public/stock), used when a reward has no
 * uploaded artwork. The app shows the picture on the colored banner next to the headline.
 * Keywords are matched against the reward's name, headline, member text, categories and the
 * names of the items it covers. Earlier entries win ties, so specific pictures come first.
 */
export interface StockArt {
  id: string;
  title: string;
  keywords: string[];
}

export const STOCK_ART: StockArt[] = [
  { id: 'pump', title: 'VGO fuel pump', keywords: ['fuel', 'gas', 'gallon', 'gallons', 'pump', 'diesel', 'unleaded', 'e85', 'fill up', 'fill-up'] },
  { id: 'cake', title: 'Birthday cake', keywords: ['birthday', 'bday', 'cake', 'celebrate', 'anniversary'] },
  { id: 'energy', title: 'Energy drink', keywords: ['energy', 'red bull', 'redbull', 'monster', 'celsius', 'rockstar', 'bang', 'reign', 'ghost', 'c4', 'alani', '5-hour'] },
  { id: 'soda', title: 'Soda can', keywords: ['coca-cola', 'coca cola', 'coke', 'pepsi', 'cola', 'soda', 'pop', 'sprite', 'dr pepper', 'dr. pepper', 'mountain dew', 'mtn dew', 'fanta', 'cheerwine', 'canned drink'] },
  { id: 'coffee', title: 'Hot coffee', keywords: ['coffee', 'cappuccino', 'latte', 'espresso', 'hot chocolate', 'cocoa', 'hot drink', 'hot beverage', 'brew'] },
  { id: 'fountain', title: 'Fountain drink', keywords: ['fountain', 'refill', 'slushie', 'slush', 'icee', 'frozen drink', 'big gulp', 'tea', 'sweet tea', 'lemonade'] },
  { id: 'water', title: 'Bottled water', keywords: ['water', 'dasani', 'aquafina', 'smartwater', 'fiji', 'gatorade', 'powerade', 'sports drink', 'cold-drinks', 'cold drink', 'bodyarmor'] },
  { id: 'beer', title: 'Beer', keywords: ['beer', 'ale', 'lager', 'ipa', 'bud light', 'budweiser', 'coors', 'miller', 'michelob', 'corona', 'modelo', 'seltzer', 'white claw', 'truly', 'wine'] },
  { id: 'chips', title: 'Bag of chips', keywords: ['chips', 'chip', 'frito', 'fritos', 'frito-lay', 'frito lay', "lay's", 'lays', 'doritos', 'cheetos', 'tostitos', 'ruffles', 'pringles', 'funyuns', 'takis', 'popcorn', 'pretzels', 'snack', 'snacks', 'jerky'] },
  { id: 'candy', title: 'Candy bar', keywords: ['candy', 'chocolate', 'snickers', 'm&m', "m&m's", 'hershey', "hershey's", "reese's", 'reeses', 'kitkat', 'kit kat', 'twix', 'skittles', 'starburst', 'gum', 'mints', 'sweets'] },
  { id: 'donut', title: 'Donut', keywords: ['donut', 'donuts', 'doughnut', 'pastry', 'pastries', 'muffin', 'honey bun', 'cinnamon roll', 'bakery', 'cookie', 'cookies'] },
  { id: 'pizza', title: 'Pizza slice', keywords: ['pizza', 'slice', 'pepperoni', 'hunt brothers'] },
  { id: 'hotdog', title: 'Hot dog', keywords: ['hot dog', 'hotdog', 'hot dogs', 'roller', 'roller grill', 'taquito', 'taquitos', 'sausage', 'corn dog', 'tornado'] },
  { id: 'chicken', title: 'Fried chicken', keywords: ['chicken', 'wings', 'wing', 'tenders', 'drumstick', 'nuggets', 'fried', 'hot-food', 'hot food', 'meal'] },
  { id: 'sandwich', title: 'Sandwich', keywords: ['sandwich', 'sandwiches', 'sub', 'subs', 'hoagie', 'wrap', 'biscuit', 'breakfast', 'burrito', 'burger', 'deli', 'lunch'] },
  { id: 'carwash', title: 'Car wash', keywords: ['car wash', 'carwash', 'wash', 'detail', 'vacuum'] },
  { id: 'points', title: 'Bonus points', keywords: ['points', 'point', 'bonus', 'double', 'triple', '2x', '3x', 'earn'] },
  { id: 'gift', title: 'Gift', keywords: ['gift', 'free', 'reward', 'surprise', 'welcome', 'thank you', 'prize'] },
];

const byId = new Map(STOCK_ART.map((a) => [a.id, a]));
export const stockArtUrl = (id: string) => `/stock/${id}.svg`;
export const isStockArtId = (id: unknown): id is string => typeof id === 'string' && byId.has(id);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9&'.-]+/g, ' ')} `;
/** Whole-word match, plurals included ("coffees", "sandwiches"). */
const has = (text: string, kw: string) => {
  const k = norm(kw).trim();
  return [k, `${k}s`, `${k}es`].some((w) => text.includes(` ${w} `));
};

/** Best picture for a reward, by keywords, then by the kind of reward. */
export function pickStockArt(rule: ConsoleRule, items?: ItemCatalog): StockArt {
  const e = rule.effect;
  if (e.type === 'fuelDiscount') return byId.get('pump')!;
  if (rule.conditions?.some((c) => c.type === 'birthday')) return byId.get('cake')!;
  if (e.type === 'pointsPerGallon' || rule.conditions?.some((c) => c.type === 'fuelGrade')) return byId.get('pump')!;
  const cats = [...('categories' in e ? (e.categories ?? []) : []), ...(rule.conditions ?? []).flatMap((c) => ('categories' in c ? (c.categories ?? []) : []))];
  const skus = new Set([...('skus' in e ? (e.skus ?? []) : []), ...(rule.conditions ?? []).flatMap((c) => ('skus' in c ? (c.skus ?? []) : []))]);
  const itemNames = skus.size && items ? items.items.filter((i) => skus.has(i.sku) || (i.upc && skus.has(i.upc))).map((i) => i.name) : [];
  const sources: [string, number][] = [
    [norm(rule.name), 4],
    [norm(rule.headline ?? ''), 3],
    [norm(itemNames.join(' | ')), 2],
    [norm(cats.join(' ')), 2],
    [norm(rule.memberText ?? ''), 1],
  ];
  let best: StockArt | undefined;
  let bestScore = 0;
  for (const art of STOCK_ART) {
    if (art.id === 'gift') continue;
    const score = sources.reduce((sum, [text, w]) => sum + (art.keywords.some((k) => has(text, k)) ? w : 0), 0);
    if (score > bestScore) [best, bestScore] = [art, score];
  }
  if (best) return best;
  if (e.type === 'pointsPerDollar' || e.type === 'pointsFlat') return byId.get('points')!;
  return byId.get('gift')!;
}

/**
 * The stock picture a reward shows, or undefined when it has uploaded artwork or the picture is
 * turned off. `rule.stockArt` pins one picture; empty means pick automatically.
 */
export function stockArtFor(rule: ConsoleRule, items?: ItemCatalog): StockArt | undefined {
  if (rule.artwork || rule.stockArt === 'none') return undefined;
  return (rule.stockArt && byId.get(rule.stockArt)) || pickStockArt(rule, items);
}
