Purchase — ACTUALIZACION PARA REPOSITORIO EXISTENTE — 19 OCT 2026

Descomprime primero en tu computadora; NO subas el ZIP entero como archivo.
Sube a la raiz de Purchase cada archivo en la misma ruta mostrada aqui.
NO subas dist/, node_modules/, ni archivos con tokens.
GitHub Pages no es el despliegue Cloudflare. Mantén npm run build -> dist en Cloudflare Pages.
No ejecutar Shopify GitHub Actions antes del 1 Nov 2026; el workflow semanal no cambia.

ARCHIVOS:
- index.html
- package.json
- assets/js/app.mjs
- assets/js/sourceMetrics.mjs
- assets/js/stockAdditionsView.mjs
- assets/data/corro-stock-evidence.json
- scripts/build.mjs
- functions/api/priorities.js
- tests/source-metrics.test.mjs
- tests/stock-additions.test.mjs

VERIFICACION: npm run check && npm test && npm run build.
LIMITE: ajuste manual de stock != compra de proveedor. Fecha de ajuste != Date Received.
Los valores a 30/60/90 de compras requieren documentos de recepcion con SKU, fecha, cantidad, costo historico y stock anterior.
