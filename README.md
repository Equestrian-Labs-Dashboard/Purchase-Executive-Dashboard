# Equestrian Labs — Purchase Executive Dashboard

**Alcance: CORRO únicamente.** Diseño Purchasing & Inventory Strategy Dashboard con métricas reales y campos pendientes explícitos, sin valores simulados.

## Instrucciones de esta versión (noviembre 2026)

**Lee primero [`README-NOVIEMBRE-2026.md`](README-NOVIEMBRE-2026.md)** para actualizar GitHub, consultar los CSV de Shopify, copiar JSON de Corro y verificar Actions. No necesitas ningún token de GitHub cruzado: el workflow Purchase consulta exclusivamente Corro con `CORRO_SHOPIFY_STORE` y `CORRO_SHOPIFY_TOKEN` ya presentes como Secrets, sin acceso al API de Cavali.

**Primer cron:** 1 de noviembre de 2026 a las 12:17 en Bolivia, archivo `.github/workflows/sync-purchase.yml`. No hay crons programados en octubre. La ejecución valida el historial desde enero 2026 antes de reemplazar el export. La Shopify API aún no se ha comprobado en vivo con los secretos privados, por lo que los datos existentes antes de la próxima extracción pertenecen a la fuente de octubre.

## Tabla de entradas y rotación

Campos: Vendor, Units In, COGS Value, Markup, Retail Value, Date Received, Sold in Receipt Month (con `Previous Stock` debajo), Units Sold / % Sold 30 Days, 60 Days, 90 Days, Remaining Units, Stock Value (COGS).

- Solo proveedores/recepciones verificadas; ajustes y devoluciones no son compras.
- `Sold in Receipt Month`: atribución FIFO estimada de las unidades ingresadas durante ese mes. No puede exceder las unidades que ingresaron.
- `Previous Stock`: ventas atribuibles a stock de apertura o entradas de meses anteriores, calculadas una vez, y solo cuando hay historial de stock inicial y ventas diarias completo.
- 30/60/90 son ventanas exactas desde el ingreso (días +29/59/89). `Pending` si están abiertas; `N/A` si faltan datos.
- El costo de la recepción debe estar documentado para mostrar valor COGS de recepción y remanente. El costo de catálogo **no reemplaza** al costo histórico.
- Corro se exporta en un JSON a `data/shopifyql-import/corro/AAAA-MM.json` para cada mes con reportes ShopifyQL; los mismos JSON se guardan en Inventory y Purchase.

## Verificar localmente

Node.js 24 (sin instalar dependencias npm):

```bash
npm run check
npm test
npm run build
npm run preview
```

Cloudflare Pages mantiene `npm run build` y carpeta de salida `dist`; no activa consultas Shopify desde la compilación. `site-config.json` conserva el enlace al dashboard Inventory.

## Autenticación y plan de acciones compartido (si ya lo tienes configurado)

El proyecto conserva las Cloudflare Pages Functions y el mismo flujo de acceso de Google, registro de usuarios y controles de permisos. No contiene credenciales privadas. Si tu entorno exige autenticación, conserva los valores existentes `AUTH_REQUIRED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CREDENTIALS`, `USER_REGISTRY_SHEET_ID`, `USER_REGISTRY_TAB` y `SESSION_SECRET` en Cloudflare, nunca en GitHub.

La tabla **Top Priorities & Action Plan** mantiene Target Date, Expected Result (KPI), Actual Result, Status, Next Step y Owner, además de las metas avanzadas anteriores en un panel plegable. Si usas planes compartidos entre miembros, conserva la vinculación de Cloudflare D1 llamada **PURCHASE_DB** y su migración `migrations/0001_priorities.sql`. Sin D1, las prioridades se guardan en el navegador y no se sincronizan entre miembros.

**Nota:** Compilación y tests locales no prueban el API de Shopify, ni el estado futuro de GitHub Actions o el despliegue Cloudflare. Si falta información de proveedor/stock inicial, los cálculos no se inventan.
