// Shared vocabularies for dropdowns, the rule drafter and labels.
// Category ids match the categories each store's POS items are mapped to.

export const CATEGORIES = [
  { id: 'coffee', label: 'Coffee', words: ['coffee', 'coffees', 'cappuccino', 'latte'] },
  { id: 'fountain', label: 'Fountain drinks', words: ['fountain', 'fountain drink', 'fountain drinks', 'soda', 'sodas', 'fountain soda'] },
  { id: 'sandwiches', label: 'Sandwiches', words: ['sandwich', 'sandwiches', 'sub', 'subs'] },
  { id: 'hot-food', label: 'Hot food', words: ['hot food', 'pizza', 'hot dog', 'hot dogs', 'chicken', 'roller grill'] },
  { id: 'snacks', label: 'Snacks', words: ['snack', 'snacks', 'chips'] },
  { id: 'candy', label: 'Candy', words: ['candy', 'candy bar', 'candy bars'] },
  { id: 'energy', label: 'Energy drinks', words: ['energy drink', 'energy drinks', 'energy'] },
  { id: 'cold-drinks', label: 'Cold drinks', words: ['cold drink', 'cold drinks', 'water', 'bottled drink', 'bottled drinks'] },
  { id: 'beer', label: 'Alcohol', words: ['beer', 'wine', 'alcohol', 'liquor'] },
  { id: 'ice', label: 'Ice', words: ['ice', 'bag of ice'] },
  { id: 'car-wash', label: 'Car wash', words: ['car wash', 'carwash', 'wash'] },
  { id: 'tobacco', label: 'Tobacco', words: ['tobacco', 'cigarettes', 'vape'] },
  { id: 'lottery', label: 'Lottery', words: ['lottery'] },
  { id: 'gift-cards', label: 'Gift cards', words: ['gift card', 'gift cards'] },
] as const;

export const FUEL_GRADES = [
  { id: 'regular', label: 'Regular', words: ['regular', 'unleaded'] },
  { id: 'midgrade', label: 'Midgrade', words: ['midgrade', 'mid-grade', 'plus'] },
  { id: 'premium', label: 'Premium', words: ['premium', 'super'] },
  { id: 'diesel', label: 'Diesel', words: ['diesel'] },
] as const;

/** Inside sales that never earn points by default. */
export const NO_EARN_CATEGORIES = ['tobacco', 'beer', 'lottery', 'gift-cards'];

export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function gradeLabel(id: string): string {
  return FUEL_GRADES.find((g) => g.id === id)?.label ?? id;
}

/** "Coffee and Fountain drinks", "Tobacco, Lottery and Gift cards". */
export function listLabel(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
