# Purchase Executive — Corro manual Shopify CSV update

- This project is **Corro only**. Cavali is not used here.
- July–October 2026 data are already processed in `data/shopify-export/` and `data/shopifyql-import/corro/`.
- The supplied CSVs show **no dated, purchase-order-linked supplier receipts** during these four months. Manual stock adjustments are not called vendor purchases; missing 30/60/90 receipt performance is not estimated as factual supplier sell-through.
- The table uses purchase receipts only when supported by the source; sales and inventory figures are visible elsewhere.
- Date/owner/expected result/status action-plan fields stay as in the previously corrected Purchase UI.

## Upload to Purchase GitHub, without GitHub Actions

1. Extract `Purchase-PARCHES-Y-DATOS-CORRO-2026-10.zip`.
2. Update `.github/workflows/sync-purchase.yml` for the weekly Sunday schedule from 2026-11-01.
3. Upload `scripts/import-manual-shopify-history.mjs`, `scripts/export-portable-inventory.mjs`, `IMPORTAR-HISTORICO-SIN-ACTIONS.ps1`.
4. Upload four monthly JSONs and `CSV-IMPORT-AUDIT.json` to `data/shopifyql-import/corro/`.
5. Upload all `.json.gz` files into `data/shopify-export/` and **upload `manifest.json` in a second, final commit**. Do not delete old chunks until the new manifest is confirmed available.
6. Keep the existing HTML/CSS/JS and Cloudflare settings; the full ZIP has those if you need a complete replacement.

## Shopify secrets already present

`CORRO_SHOPIFY_STORE`, `CORRO_SHOPIFY_TOKEN`. Purchase does not require the Cavali secrets, although they can remain configured.

## Refresh with more CSVs

Run `IMPORTAR-HISTORICO-SIN-ACTIONS.ps1` in this project from PowerShell (Node 24), or send the Corro exports to ChatGPT to have the portable data generated. GitHub Actions are scheduled weekly, starting November 1, and may be delayed by GitHub. To see web changes before that date, an independent Cloudflare Pages build must be configured and triggered on Git commits; otherwise GitHub stores the new data until the next deployment.
