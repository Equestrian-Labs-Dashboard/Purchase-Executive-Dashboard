# Purchase Executive Dashboard

Proyecto independiente de Inventory by Month. Diseño premium blanco cálido y verde ecuestre inspirado en la referencia de Ceci; datos visibles SOLO de Corro. Filtros Category, Brand, Vendor, Month, Quarter y YTD, tabla de recepciones con 30/60/90 días, dos filas de KPI, cinco prioridades mensuales y revisión de cinco proveedores. No contiene cifras de ejemplo del mockup.

## Ejecutar

Node.js 24, sin dependencias npm:

```sh
npm test
npm run check
npm run build
npm run preview
```

Abrir `http://127.0.0.1:8877`. La vista local guarda las prioridades en ese navegador. El servidor de vista previa no emula las Functions de Cloudflare.

## Datos actuales y próxima extracción

Incluye los bloques originales de `data/shopify-export/`, generados el 15 de octubre de 2026 a las 03:40:02 UTC, con ventas completas hasta el 13 de octubre. No hace falta el JSON monolítico. El lector verifica tamaño, SHA-256 y conteo de cada bloque; si falta uno, falla el build en vez de presentar datos antiguos como nuevos.

Hay **cero recepciones confirmadas**, una reposición observada y 88 registros de devolución a stock. Los permisos registrados de Corro y Cavali denegaron `inventoryPurchaseOrders`. No se pueden validar Units In, Date Received, COGS de recepción ni rotación histórica de compras con este archivo. Las ventas de todos los stocks se muestran en un bloque contextual separado.

La extracción se hace una sola vez en **ginrov/inventory-by-month-dashboard**, con el archivo `EXTRAER-SHOPIFY-BLOQUES.yml` entregado junto al proyecto. Después:

1. Descargar el artifact `inventory-data-para-cloudflare`.
2. Copiar **solo la carpeta completa `data/shopify-export/`** al repositorio de Purchase, manteniendo esa ruta.
3. Conservar el `scripts/build.mjs` de Purchase. Los otros scripts del artifact son para Inventory y no deben reemplazar el build de este proyecto.
4. Cloudflare ejecuta `npm run build`, salida `dist`.

Para Inventory, aplicar también sus scripts/módulos incluidos en el artifact, además de la carpeta de datos. Los dos proyectos leen la misma extracción; no requieren dos consultas independientes a Shopify.

La nueva versión del extractor solicita `cost_of_goods_sold`, `net_sales`, `gross_sales` y `discounts`. Si un campo opcional no está soportado, conserva ventas ordenadas/netas y registra que ese campo falta. Fallos de autenticación o paginación no se convierten en ceros. **Esas métricas financieras todavía no están en el archivo incluido**: requieren otra ejecución real. Brand se lee del metafield de texto `custom.brand`; si falta, muestra Unspecified, sin inferirlo desde Vendor o Store.

## Publicar como proyecto separado

Repositorio existente: **Equestrian-Labs-Dashboard/Purchase-Executive-Dashboard**. NO crear otro repositorio ni cambiar Inventory.

Subir el contenido de este proyecto a la raíz del repositorio, de modo que `package.json`, `index.html`, `assets/`, `scripts/`, `functions/`, `migrations/` y `data/` estén directamente allí. No subir el ZIP como un solo archivo.

En Cloudflare Pages, conectar ese nuevo repositorio. Configuración: framework None, comando `npm run build`, directorio de salida `dist`, Node 24. El despliegue por Git de Cloudflare no depende de ejecutar Actions en el repositorio oficial.

`site-config.json` mantiene el enlace a Inventory y los umbrales visuales (25% / 50%, orientativos). `showDiscounts` habilita la tarjeta de descuentos, PERO solo muestra valores si Shopify proporcionó gross sales y discounts con cobertura validada; con fuente incompleta dice Source required. Los descuentos ya están contemplados en net sales; no se descuentan otra vez de Gross Profit 1.

## Acceso y prioridades compartidas

Se reutiliza el mecanismo de Google/registro de usuarios del proyecto original. Para activar el acceso protegido en el nuevo sitio, configurar `AUTH_REQUIRED=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_CREDENTIALS`, `USER_REGISTRY_SHEET_ID`, `USER_REGISTRY_TAB` cuando corresponda y `SESSION_SECRET` en Cloudflare. No están incluidos los valores privados. Autorizar el origen del nuevo sitio en el cliente de Google y agregar `purchase_executive` / `Purchase Executive Dashboard` a los permisos del registro. `ALL REPORTS` sigue siendo reconocido. Inventory mantiene su permiso original.

Para que Ceci y su equipo compartan las prioridades:

1. Crear una base Cloudflare D1 para este proyecto.
2. Ejecutar el SQL de `migrations/0001_priorities.sql` en esa base.
3. En el proyecto Pages, agregar la vinculación D1 con nombre exacto **PURCHASE_DB** y seleccionar la base.
4. Configurar el acceso protegido descrito arriba y volver a desplegar.
5. Al abrir el tablero autenticado, debe decir **Shared workspace**. Guardar una prioridad y comprobarla desde otro navegador autorizado.

Sin D1, dice **Local browser plan**. Esa modalidad funciona, pero no comparte cambios automáticamente entre personas. Backup e Import trasladan un plan mensual. Las revisiones manuales de proveedores también son locales y se pueden exportar.

El backend exige autorización aun si `AUTH_REQUIRED` está desactivado en la vista; limita el tamaño del cuerpo y rechaza solicitudes de otro origen. Cada guardado compara la versión: si alguien ya guardó ese mes, devuelve conflicto, conserva el borrador local y pide combinar los cambios. No sobrescribe la versión del compañero.

Las cinco prioridades incluyen Markup, Sell-Through Rate, Units Goal, Success Measure, What Success Looks Like?, Status, Next Step y Results, sin Owner. Carry unfinished copia las actividades no terminadas al mes siguiente, conserva el mes de origen, evita duplicados y no pisa una planificación llena.

## Cálculos y limitaciones de fuente

- Units In: cantidades recibidas de documentos de proveedor con SKU y fecha. Stock observado y devoluciones no son compras.
- COGS Value: unidades recibidas × costo documentado. No sustituir por costo actual del catálogo.
- Markup: `(retail actual / costo de recepción - 1) × 100`, ponderado por cantidades. Es recargo al precio actual, no margen bruto realizado.
- COGS sold: costo reportado por Shopify para las ventas del período. Gross Profit 1 = net sales − COGS; no incluye gastos operativos.
- Ventanas: fecha recibida incluida; fin inclusivo = fecha + 29/59/89 días. Valores acumulados, nunca sumarlos.
- FIFO parte del stock inicial Shopify, consume ese stock antes de las recepciones, incluye devoluciones al stock y no asigna dos veces una venta. Aun con entradas verificadas, la atribución física al lote es una estimación FIFO.
- Si no hay stock inicial o faltan días de ventas en el historial utilizado por FIFO, no se presenta un porcentaje. Períodos abiertos muestran In Progress y ventas so far.
- La última columna es **Current Stock**, la suma del stock más reciente de los SKU de esa recepción en el archivo importado. Incluye stock antiguo y posterior; no representa unidades no vendidas de un lote concreto ni stock en tiempo real.
- YTD requiere enero–fecha para un total completo. El historial disponible empieza en junio; la aplicación lo señala y no presenta esos meses como un YTD completo.
- La vista Purchase contiene únicamente Corro; el ZIP de datos compartido puede contener ambas tiendas porque Inventory necesita Corro y Cavali. Los valores monetarios requieren una moneda común y conocida.

La tabla Double-check muestrea cinco proveedores con actividad en el período y permite registrar cifras de Shopify, referencia y diferencias. `audits/VERIFICACION-CINCO-PROVEEDORES.txt` documenta el contraste local; no afirma una revisión directa de Shopify ni inventa diferencias cero cuando la fuente falta.

## Origen compartido

`scripts/inventory-source.mjs`, `normalize-receipt-data.mjs`, `shopify-native-receipts.mjs`, `cohort-allocation.mjs` y `assets/js/rotationCore.mjs` son los mismos módulos del proyecto Inventory entregado. El nuevo build publica archivos pequeños con los campos que necesita Purchase; no duplica la tabla mensual operativa.

## Referencias

- [Shopify: permisos de purchase orders](https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryPurchaseOrders)
- [Shopify: métricas de ventas](https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sales_revenue/sales)
- [Cloudflare: despliegue HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)
- [Cloudflare: D1 en Pages](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases)
Deployment verification — October 17, 2026


## Versión 17 de octubre de 2026 — Alcance de Ceci

- Purchase filtra Corro en el build y en la pantalla; ningún KPI ni tabla debe mezclar Cavali.
- Main KPIs: Markup promedio de recepciones, Sell-Through 30 días, descuento promedio (solo si acreditado), Gross Margin 1 y Gross Profit 1 (solo con costo de ventas y ventas netas acreditados).
- Secondary KPIs: Inventory COGS Value a costo de catálogo (etiquetado como tal), Retail Value, Units on hand, Monthly Rotation y COGS Sold. Fuentes faltantes muestran `Source required`.
- Tabla de recepción: 30, 60 y 90 días, con unidades y porcentajes, semáforos suaves; Current Stock del último snapshot importado de sus SKU. No se presume que sea remanente de una recepción.
- Prioridades: como máximo cinco, sin Owner y con metas/resultados. La base D1 y autenticación Cloudflare no se han cambiado.
- Este export no contiene recepciones verificadas de Corro: no debe presentarse el mockup como datos reales.
- No habilitar `npm run build:sync` en Cloudflare Purchase. Comando `npm run build`, salida `dist` y raíz de repositorio.
- Las exclusiones definitivas de Sponsorship, Marketing, Team Rider y Upsell gratis, y la inclusión de ventas pagadas con Gift Card, aún precisan contraste por pedido pagado con Shopify; no considerar completada la validación hasta resolverlo.
