# Entrega revisada — Corro (julio a octubre) + consultas Cavali

Fecha: 19 de octubre de 2026.

## Qué ZIP usar

- `Inventory-SUBIR-ESTOS-ARCHIVOS-CORRO.zip`: contiene solamente archivos nuevos/modificados con la estructura de carpetas exacta del repositorio Inventory. Es el recomendado si ya subiste los proyectos anteriores.
- `Purchase-SUBIR-ESTOS-ARCHIVOS-CORRO.zip`: actualización del repositorio Purchase. Incluye código, datos comprimidos y el workflow semanal.
- `Inventory-PROYECTO-COMPLETO-ACTUALIZADO.zip`: proyecto Inventory íntegro para recuperar todos los archivos de código y datos publicables (excluye build temporal `dist/` y el antiguo JSON monolítico de 68 MB porque el archivo comprimido `data/shopify-export/` ya tiene la nueva fuente).
- `Purchase-PROYECTO-COMPLETO-ACTUALIZADO.zip`: proyecto Purchase íntegro.
- `CAVALI-CONSULTAS-JULIO-OCTUBRE-2026.zip`: 12 sentencias ShopifyQL individuales y un documento con los 12 bloques listos para copiar/pegar.

## Dónde subo exactamente cada carpeta del parche

**Inventory** (GitHub repo de Inventory, desde la raíz):

- `.github/workflows/sync-inventory.yml` — programado **domingos, desde 1 noviembre 2026**, no ejecutar manual en octubre
- `scripts/import-manual-shopify-history.mjs`
- `scripts/export-portable-inventory.mjs`
- `scripts/generate-extractor-workflow.mjs`
- `EXTRAER-SHOPIFY-BLOQUES.yml` y `EXTRAER-SHOPIFY-BLOQUES-CORREGIDO.yml` (extractor auxiliar, manual y bloqueado hasta noviembre)
- `IMPORTAR-HISTORICO-SIN-ACTIONS.ps1`
- `GUIA-CARGA-MANUAL-CORRO-CAVALI.md`
- `tests/manual-csv-history.test.mjs`
- `data/shopifyql-import/corro/2026-07.json`, `/2026-08.json`, `/2026-09.json`, `/2026-10.json`, `/CSV-IMPORT-AUDIT.json`
- `data/shopify-export/`: **todas** las partes comprimidas `*.json.gz` y al final `manifest.json`

**Purchase** (GitHub repo Purchase, desde la raíz):

- `.github/workflows/sync-purchase.yml` — programado domingos desde 1 noviembre
- `scripts/import-manual-shopify-history.mjs`
- `scripts/export-portable-inventory.mjs`
- `IMPORTAR-HISTORICO-SIN-ACTIONS.ps1`
- `GUIA-CARGA-MANUAL-PURCHASE-CORRO.md`
- `tests/manual-csv-history.test.mjs`
- `data/shopifyql-import/corro/2026-07.json`, `/2026-08.json`, `/2026-09.json`, `/2026-10.json`, `/CSV-IMPORT-AUDIT.json`
- `data/shopify-export/`: todas las partes comprimidas `*.json.gz` y al final `manifest.json`

**Si subes desde la web de GitHub:** descomprime el ZIP primero. Navega a cada carpeta de destino, elige `Add file > Upload files` y arrastra los archivos de ESA carpeta (no una carpeta con un nivel de directorio extra). Si actualizas contenido comprimido, sube los `.json.gz` primero y `manifest.json` en un commit final: de otro modo el sitio podría intentar cargar un manifiesto que apunta a archivos aún no subidos. No borres bloques antiguos antes de publicar el nuevo manifiesto.

**Si usas Git o GitHub Desktop:** mezcla las carpetas del parche directamente con las carpetas raíz de la copia local del repositorio; valida la ruta `.github/...` y usa Commit + Push. No subas el `.zip` como único archivo de GitHub.

## Confirmación de datos Corro

| Mes | Ventas pedidas (`quantity_ordered`) | Ventas netas (`net_items_sold`) | Compras identificadas por PO |
|---|---:|---:|---:|
| Julio | 1373 | 1310 | 0 |
| Agosto | 672 | 639 | 0 |
| Septiembre | 902 | 870 | 0 |
| Octubre parcial | 227 | 218 | 0 |

**ATENCIÓN:** 0 aquí significa *cero recepciones documentadas como purchase_order_received en los CSV*, no que realmente nunca llegaran nuevos productos. Los informes contienen ajustes `manual_adjustment`, `correction` y `initial_adjustment`; ninguna de estas categorías acredita por sí sola una compra al proveedor. Las correcciones masivas quedan fuera de `Stock +` a efectos de nuevas entradas, aunque se preservan para auditoría. Esto evita porcentajes de 30/60/90 falsos y stock “recibido” inexistente.

Los CSV no son evidencia de proveedor efectivo ni costo unitario histórico de orden de compra. Para completar el panel de Purchase por proveedor hay que conseguir reporte de recepciones/órdenes de compra con SKU, cantidad, proveedor y fecha, o identificar qué ajustes manuales equivalen a mercadería efectivamente recibida, con evidencia. Las ventas del SKU y el inventario general sí están cargados.

## Cómo refrescar datos después de Cavali

Envíame los **12 CSV de Cavali** (nombrados CAVALI_2026-07_ADJUSTMENTS.csv, etc.), y opcionalmente `CAVALI_PRODUCTS.csv`. Prepararé un nuevo paquete **Inventory únicamente** que conserve Corro actualizado, valide Cavali y reconstruya sus datos comprimidos. Purchase continuará solo con Corro. También puedes usar `IMPORTAR-HISTORICO-SIN-ACTIONS.ps1` del proyecto Inventory localmente si tienes Node 24 instalado.

## GitHub Actions sin gastar minutos de octubre

No ejecutes ninguno de los workflows manuales hasta noviembre. Los workflows incluidos están programados **una vez por semana, domingo**, con primera ejecución prevista el 1 de noviembre de 2026. Inventory usa cuatro secretos que ya existen (dos de Corro y dos de Cavali). Purchase usa los dos de Corro existentes. Los workflows automatizados dependen de permisos/API reales de Shopify, que no han podido validarse en esta sesión.

GitHub Actions y Cloudflare Pages son servicios distintos: subir datos a GitHub no actualiza por sí solo la página si no existe una compilación/despliegue al recibir un commit. Si Cloudflare Pages está conectado a GitHub con despliegues automáticos, puede construir en cada push sin consumir GitHub Actions; si no, habrá que publicar manualmente desde Cloudflare o esperar la siguiente ejecución disponible.
