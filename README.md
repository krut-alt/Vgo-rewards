# VGO Rewards

Jobber-owned loyalty platform for VGO convenience stores (SC, NC, GA).
Pilot: one unbranded Verifone Commander store, then the remaining Verifone and Gilbarco sites.

## How it fits together

- **Rules engine** (`packages/engine`): every earn rule, reward and offer is data the jobber
  creates, edits, pauses and retires in the console. Rules target one store, store groups,
  or all stores, with schedules, per-member limits and stacking groups.
- **Console** (`packages/console`): where the jobber manages offers, reward rules, stores and
  groups, members, branding and pilot results. Includes a plain-English rule drafter that turns
  "Earn 2x points on premium fuel on weekends at SC stores until Dec 31" into a paused rule.
  The POS link calls `POST /api/pos/preview` before payment and `POST /api/pos/transactions` after.
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
| Controls | per-member limit per day/week/month/lifetime, stacking group (best one wins), priority, monthly budget cap, who funds it (jobber, store, split 50/50, manufacturer) |
| Program | points redemptions apply only when the member picks them; fuel discounts either "largest wins" or stack up to a cents-per-gallon cap |

Store managers can only create small, store-funded offers for their own store; fuel
discounts and earn rules stay with the jobber (`permissions.ts`).

## Develop

```sh
npm install
npm run typecheck
npm test
npm run console   # http://localhost:4310
```

The console keeps its data in `data/console.json` (set `VGO_DATA` to move it). A new console
starts with the 13 stores, the pilot rules from the program design and about 45 days of
clearly marked sample visits so Results has numbers; clear them from the Results screen.
Store cities, the state split and POS for stores 02 to 13 are placeholders until confirmed.

There is no sign-in yet, so the console listens on localhost only. Sign-in and roles
(jobber admin, jobber marketer, store manager) come before it is hosted.
