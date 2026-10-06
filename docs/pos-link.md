# POS link

VGO Rewards is a Hybrid build: we run the offer engine, the console and the app, and rent a
certified Conexxus loyalty connection (the "link") that sits between the store POS (Verifone
Commander, Gilbarco Passport) and us. The link vendor handles certification with Verifone and
Gilbarco; we answer its loyalty calls.

```
Commander / Passport ──(Conexxus loyalty, vendor-certified)──> link vendor host ──(HTTPS, adapter)──> /api/pos/link/*
```

## The messages

All calls are `POST /api/pos/link/<op>` with `Authorization: Bearer <VGO_POS_KEY>` and a JSON body.
Field-by-field types are in `packages/console/src/pos/link.ts`.

| op | When the POS sends it | We answer |
| --- | --- | --- |
| `identify` | Barcode scanned or phone typed on the PIN pad | Member first name, points, points rewards they can pick at the register |
| `rewards` | Pump authorization and again before tender | Discounts to apply: fuel as cents per gallon with a gallon cap, item discounts with the line ids they go on, basket discounts |
| `finalize` | After payment, with what the POS actually applied | Points earned and spent, new balance, receipt lines. Repeating a finalize is answered with `duplicate`, never counted twice |
| `cancel` | Sale voided before payment | `ok`. Nothing is reserved between `rewards` and `finalize`, so nothing to undo |
| `prices` | Whenever the vendor or back office can push pump prices: `{siteId, prices: [{grade, pricePerGallonCents, at?}]}` | How many grades changed |

Pump prices also come from every `rewards` and `finalize` that carries fuel (`pricePerGallonCents` to a tenth of a
cent, so $3.199 is `319.9`). The newest price per grade is kept on the store, shown in the app's store list, and
hidden after 7 days without an update. Prices can also be typed in on the Locations page.

`GET /api/pos/feed?after=<cursor>&siteId=<site>&limit=<n>` lists recorded sales oldest first, for
the vendor's reconciliation and back-office exports. Pass the returned `next` as `after` to continue.

Members are found by `loyaltyId`: the phone number, typed or carried by the app barcode. Unknown
phones and non-members never block a sale; they get no rewards and the sale is still recorded for Results.

Line categories come from the uploaded items catalog (by UPC or SKU), then the department map in
program settings (`posDepartments`, e.g. `{"12": "tobacco"}`), then the department name.

The older `POST /api/pos/preview` and `/api/pos/transactions` still work for direct callers.

## Adding the chosen vendor

1. Get their API docs and a sandbox account.
2. Add `packages/console/src/pos/<vendor>.ts` implementing `PosLinkAdapter` (`read` their request into a
   `LinkRequest`, `write` our `LinkAnswer` into their response) and register it in `adapters.ts`.
   If they push offers to their host instead of calling us per sale, add a sync job beside it.
3. Test it with their sandbox, then in Render set `VGO_POS_LINK=<vendor>` and a long random `VGO_POS_KEY`
   (shared with the vendor only, never committed).
4. On the Locations page, enter each store's POS site ID exactly as the vendor names it.

## Trying it without a vendor

`npm run pos:mock -- --url http://localhost:4310 --phone <member phone>` runs a pretend Commander sale
(scan, pump authorization, fueling, register, finalize) against a running server and prints each answer.
Add `--key <VGO_POS_KEY>` for the hosted app, `--site <site id>` for another store and
`--skip <rewardId>` to act as if the cashier skipped a reward.
