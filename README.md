# TLM Bill of Lading Maker

Standalone document generator for The Leopard Mark — `bol.tlmbg.co`.

Lets anyone with the link (Daniel included) fill in a form and print/PDF a
Delivery Receipt or a Straight (freight) Bill of Lading, without touching the
full `inventory.tlmbg.co` dashboard or its login/movement-logging workflow.

## Architecture

Static frontend only (this repo, on Vercel). It calls the same Apps Script
backend as `inventory.tlmbg.co` (`assets/js/config.js` — same
`APPS_SCRIPT_URL`), but **read-only**: it fetches `accounts`, `skus`,
`locations`, and `commodities` to populate dropdowns, and never calls
`addEvent` or any write action. Generating a document here does **not**
create a row in the Inventory Ledger and does not affect stock — it is
paperwork only.

`assets/js/bol.js` is the exact same renderer used by the inventory app
(`renderBolHtml` / `renderDeliveryReceiptHtml` / `renderFreightBolHtml`),
copied verbatim so the printed document looks identical either way.

## Document numbers

Because this tool never writes to the ledger, it can't use the inventory
app's real `BOL-<location>-<yymmdd>-<seq>` sequence (that's derived from
actual ledger rows). Instead it generates its own `DR-<yymmdd>-####` /
`BOL-<yymmdd>-####` numbers, editable before printing in case a specific
number needs to match something else.

## Warehouse item numbers

The `SKU` column on every generated document prints the **receiving
warehouse's own item number**, not our bare SKU Master code — the printed
document is what the warehouse types into their search box, and their search
is exact-match.

`WAREHOUSE_ITEM_NUMBERS` in `assets/js/bol.js` holds WLA's (Balmuth & Co.,
Wilmington) codes, transcribed from their "Leopard Mark Inventory"
lot-balance export. They append `-M` to kegs and `-6PK` to cases, and store
the glassware with no `TLM-` prefix at all. SKUs not in that table fall
through to the old blanket `TLM-` prefix.

When WLA sends a new inventory export, diff the `Product` column against
that table. Two known quirks are intentional, not typos to "fix":

- `SGB1AKSB01` → `TLM-SBG1AKSB01-M`. WLA has the brand letters transposed
  on that one item. It is their typo, but it is what their search matches.
- `GLW-PT-16-CNT-01` maps to itself, with no prefix.

## Files

- `index.html` — the form UI (doc-type toggle, delivery receipt fields,
  freight BOL fields)
- `assets/js/app.js` — form logic: loads reference data, builds line-item
  rows, assembles the `d` object `bol.js` expects, opens the print window
- `assets/js/bol.js` — shared renderer, copied from
  `TheLeopardMark-Inventory/assets/js/bol.js`
- `assets/js/config.js` — Apps Script backend URL (same one the inventory
  app uses)

## Updating

If the inventory app's `bol.js` renderer changes (new fields, styling), copy
the updated file over here to keep the two in sync — this repo intentionally
does not share a package/build with `TheLeopardMark-Inventory`.
