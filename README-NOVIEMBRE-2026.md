# Equestrian Labs — Purchase Executive (CORRO only), actualización noviembre 2026

**La tienda Purchase es únicamente CORRO.** Esta versión se sincroniza directamente con los dos Shopify Secrets de CORRO que **ya existen también en Purchase**. No necesita ninguna variable `INVENTORY_SOURCE_REPO`, ningún `INVENTORY_SOURCE_TOKEN`, ni acceso al GitHub de Inventory. Los dos Shopify Secrets de Cavali pueden permanecer en este GitHub, pero el script Purchase no los solicita ni los consulta.

> Se probaron código, cálculos y build con datos locales; **no se ha probado el token real contra Shopify** y las tablas que parten del 15 de octubre no representan una sincronización nueva. Una venta no certifica qué lote físico se vendió: se expresa como asignación FIFO estimada cuando existe stock inicial comprobable y cobertura diaria suficiente.

## 1. Archivos a subir a GitHub

Subir **el contenido extraído**, respetando rutas, del ZIP `Purchase-ACTUALIZACION-FINAL-SOLO-CAMBIOS.zip` al GitHub **oficial Purchase**. No subir el propio ZIP. El backup `Purchase-FINAL-COMPLETO.zip` permite inspeccionar el proyecto entero. Mantener `.github/`, `assets/`, `scripts/`, `data/`, `tests/` y los archivos de la raíz. El ZIP de parche solo sustituye los archivos efectivamente cambiados.

Antes de hacer el commit, confirmar que existe `.github/workflows/sync-purchase.yml` y `scripts/sync-shopify-inventory.mjs` en Purchase. Los scripts de datos son independientes de Inventory. No editar ni subir credenciales al código.

## 2. Secrets existentes (Settings → Secrets and variables → Actions)

| Secret existente | Usado por Purchase |
|---|---|
| `CORRO_SHOPIFY_STORE` | Sí |
| `CORRO_SHOPIFY_TOKEN` | Sí |
| `CAVALI_SHOPIFY_STORE` | No |
| `CAVALI_SHOPIFY_TOKEN` | No |

**No necesitas crear ninguno.** El workflow valida los 2 de CORRO y ejecuta el extractor con `SHOPIFY_STORES: corro` y `INVENTORY_REQUIRED_STORES: corro`. Requiere que los permisos de la Shopify Admin API permitan acceder a productos, inventario, informes, pedidos antiguos y documentos de compra para obtener todas las métricas; algunas tiendas restringen las órdenes de compra. En esos casos, los datos no demostrables quedan `N/A`, nunca se simulan.

## 3. Primera ejecución: 1 de noviembre de 2026

Workflow: `.github/workflows/sync-purchase.yml`.

- Cron `17 16 * 1-9,11-12 *` = **12:17 Bolivia**, diariamente de noviembre a septiembre. **Sin ejecuciones programadas en octubre**; el chequeo de fecha impide iniciar Shopify antes del 1 de noviembre de 2026 incluso si se ejecuta manualmente.
- La primera ejecución reconstruye el historial Shopify desde `2026-01-01` hasta el día anterior en la zona horaria de la tienda.
- Valida pruebas y cobertura antes de publicar. Si falta histórico esencial, **falla con explicación y conserva el último export**.
- El cron excluye octubre también en años futuros: revisarlo antes de octubre de 2027 si quieres operar todo el año.
- Para publicar Cloudflare Pages: Build command `npm run build`, output `dist`, Node 24. No modifica la configuración ni el almacén D1 del Action Plan.

## 4. Importación manual de ShopifyQL (mismo Corro que Inventory)

**También necesitas importar los JSON de CORRO en Purchase.** Como ahora los repositorios consultan Shopify directamente, no existe un intercambio automático de archivos de un repositorio GitHub a otro. Para cada mes Corro:

1. En Inventory usa `IMPORTAR-CSV-SHOPIFY.ps1` con los dos CSV que exportaste de Corro.
2. Copia su salida `Inventory/data/shopifyql-import/corro/AAAA-MM.json` a la **misma ruta relativa** en Purchase: `Purchase/data/shopifyql-import/corro/AAAA-MM.json`.
3. En GitHub web, sube ese JSON al GitHub de Inventory **y** al de Purchase.
4. No copies los JSON de `cavali/` a Purchase; Purchase solo trabaja Corro.

Si tienes los proyectos descargados uno junto al otro, el proyecto Inventory incluye `COPIAR-CORRO-A-PURCHASE.ps1`, por ejemplo:

```powershell
.\COPIAR-CORRO-A-PURCHASE.ps1 -Month 2026-02 -PurchaseFolder "C:\Equestrian\Purchase-Executive-Dashboard-main"
```

**Enero Corro ya va incluido** en el ZIP de Purchase: `data/shopifyql-import/corro/2026-01.json`. Solo importa las 144 unidades con variante reconocible de 332 unidades documentadas; las restantes 188 no se adjudican artificialmente a otros productos.

Dos CSV **no bastan** para calcular por sí solos el FIFO: las recepciones por SKU y ventas netas son evidencia adicional. El extractor también necesita fecha real de compra, historial diario de pedidos y stock inicial en enero. Por eso el sistema muestra `N/A` o `Pending` si falta una base fiable.

## 5. Diseño de tabla en inglés

**Purchasing & Inventory Strategy Dashboard:** Vendor, Units In, COGS Value, Markup, Retail Value, Date Received, Sold in Receipt Month, Units Sold 30 days, % Sold 30 days, Units Sold 60 days, % Sold 60 days, Units Sold 90 days, % Sold 90 days, Remaining Units, Stock Value (COGS). En **Sold in Receipt Month** aparece abajo `Previous Stock: N units`.

- **Units In**: unidades recibidas de proveedor con vínculo documental; no pedidos sin recibir, devoluciones, traslados ni ajustes manuales.
- **Sold in Receipt Month**: únicamente ventas FIFO atribuibles a los recibos de ese SKU **durante su mes de entrada**, con tope en las unidades de ese mes.
- **Previous Stock**: ventas de stock inicial o recibos de meses anteriores asignadas por FIFO al mismo SKU/mes, separadas de la compra nueva. Ventas de devoluciones/ajustes desconocidos no se consideran compras.
- **30/60/90 días**: ventanas acumuladas **desde el día exacto de cada recepción**; no se suman entre sí.
- **Remaining Units y Stock Value (COGS)**: remanente de cada recepción después de 90 días; costos exclusivamente documentados, no costos actuales imputados.
- **Pending**: aún no venció el plazo, **N/A**: no existe stock inicial, documento verificable o cobertura completa.
- **All** en los filtros permite totales de categorías, marca y proveedor, siempre solo Corro.
- El **Top Priorities & Action Plan** conserva Target Date, Expected Result (KPI), Actual Result, Status, Next Step y Owner, sin borrar metas antiguas.

## 6. Comprobar código y despliegue

```bash
npm run check
npm test
npm run build
```

No ejecutar manualmente el workflow de GitHub durante octubre; GitHub Actions puede consumir minutos de control aunque el workflow bloquee consultar Shopify. El 1 de noviembre verifica en la pestaña **Actions → Purchase · Corro Shopify direct** y revisa logs; después confirma que la web pública se actualizó. No se puede garantizar a priori que Shopify devuelva informes históricos completos: los permisos y la retención varían por recurso.
