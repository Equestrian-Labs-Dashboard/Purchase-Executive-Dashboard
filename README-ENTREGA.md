# October 19, 2026 — GitHub upload instructions

## 1. Purchase first
Upload all files from `Purchase-CORRECCION-503-SOLO-CAMBIOS.zip` to the root of the **Purchase** GitHub repository, preserving paths. The code change is `assets/js/app.mjs`. It handles 503 and network errors from `/api/priorities` by falling back to local browser storage. This does **not** configure the missing Cloudflare D1 binding; shared editing still requires Cloudflare Pages > Settings > Bindings > D1 database with variable `PURCHASE_DB` and the existing `migrations/0001_priorities.sql` applied to that database. Do not run GitHub Actions in October.

## 2. Inventory next
Upload the content of `Inventory-CAVALI-CORRO-SOLO-CAMBIOS.zip` to the root of the **Inventory** GitHub repository, preserving the folders. In particular upload the entire `data/shopify-export/` folder and `data/shopifyql-import/cavali/`, plus `assets/js/tracking.js` and `dist/` only if your hosting uses committed dist. Upload manifest.json after the gzip files. Do not upload the zip itself. Cloudflare Pages should build with `npm run build` and output directory `dist`.

## 3. Caveats
This is a historical CSV import, NOT a verified purchase receipt import. It contains zero supplier purchase-linked receipts. Inventory stock additions are labeled unverified. Purchase remains Corro-only and was not modified with Cavali records. Weekly GitHub Actions still start November 1, 2026. Store-wide stock discrepancies and Shopify's October 1 change from available to on-hand inventory remain unresolved. The original Purchase priority 503 requires checking Cloudflare D1 configuration for shared persistence.

## 4. Verification
Purchase: `npm run check`, `npm test`, `npm run build` pass. Inventory: `npm run check`, `npm test`, `npm run build` pass. No live Shopify or Cloudflare deployment was performed.
