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
