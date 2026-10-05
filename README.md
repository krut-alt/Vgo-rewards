# VGO Rewards

Jobber-owned loyalty platform for VGO convenience stores (SC, NC, GA).
Pilot: one unbranded Verifone Commander store, then the remaining Verifone and Gilbarco sites.

## How it fits together

- **Rules engine** (`packages/engine`): every earn rule, reward and offer is data the jobber
  creates, edits, pauses and retires in the console. Rules target one store, store groups,
  or all stores, with schedules, per-member limits and stacking groups.
- **Console API and UI** (next): where the jobber manages stores, groups, members and rules.
- **Customer app** (later): sign-up, offers, points and rewards.
- **POS link** (rented): a certified Conexxus loyalty connection to Commander and Passport
  calls the engine for each transaction and applies discounts at the pump and register.

## Rule building blocks

| Part | Options |
| --- | --- |
| Target | all stores, chosen stores, store groups |
| When | start/end dates, days of week, hours |
| Conditions | minimum inside spend, has item/category, minimum gallons, fuel grade, member tag, first visit |
| Effects | points per dollar, points per gallon, flat points, cents-per-gallon fuel discount (optionally paid with points), item discount, basket discount, punch card |
| Controls | per-member limit per day/week/month/lifetime, stacking group (best one wins), priority, who funds it |

Store managers can only create small, store-funded offers for their own store; fuel
discounts and earn rules stay with the jobber (`permissions.ts`).

## Develop

```sh
npm install
npm run typecheck
npm test
```
