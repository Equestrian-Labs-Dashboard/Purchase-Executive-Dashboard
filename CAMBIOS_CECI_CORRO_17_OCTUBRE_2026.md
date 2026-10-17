# Purchase Executive Dashboard — implementación Corro / diseño de Ceci

## Aspecto y alcance

- Diseño moderno de Equestrian Labs inspirado en el boceto de Ceci: crema/blanco, verde forestal profundo, tipografía con serif en el encabezado, tarjetas de KPI limpias, encabezados verdes y señales de 30/60/90 en verde, azul y dorado pastel; los umbrales de rendimiento usan verde/ámbar/coral suave.
- Datos SOLO Corro, desde `scripts/build.mjs`. Inventory y el extractor auxiliar todavía contienen Corro y Cavali y NO deben modificarse para eliminar Cavali.
- Filtros Category, Vendor, Brand, Month, Quarter, YTD. Store se muestra Corro fijo.
- Cinco Main KPI y cinco Secondary KPI como la referencia. Ausencia de fuentes de costo/venta o recibos verificados = `Source required`, sin cifras del mockup.
- Tabla Vendor, Units In, COGS Value, Markup, Date Received, unidades y porcentaje a 30/60/90 días y última columna **Current Stock** del último snapshot importado de los SKU de esa recepción, NO remanente del lote.
- Cinco prioridades y plan de acciones; SIN Owner. Se conservó Cloudflare D1/Google y la auditoría de cinco proveedores.

## Pendientes comprobables

- Shopify no proporcionó recepciones de proveedor verificadas: se requieren `read_inventory_purchase_orders`, permiso de usuario y nueva extracción. El reporte no debería mostrar datos inventados donde la fuente falta.
- Los costos vendidos, ventas netas y descuentos son **pendientes** donde el export no los incluya. Nunca confundir precio de catálogo con COGS de compras ni con COGS vendido.
- Revisar excepciones por pedido pagado (regalos/upsell/Gift Cards), mercancía legacy y cinco proveedores contra Shopify antes del cierre final de indicadores.

## Publicación independiente

1. Subir los CONTENIDOS extraídos de este ZIP a la raíz de `Equestrian-Labs-Dashboard/Purchase-Executive-Dashboard`, rama `main`. `package.json` debe estar en la raíz, no dentro de una segunda carpeta.
2. Cloudflare Pages → build `npm run build`, output `dist`, root vacío y Node 24. **No** usar GitHub Pages/Jekyll: no tiene nada que ver con el build de Cloudflare.
3. Actualizar únicamente `data/shopify-export/` de la misma extracción utilizada por Inventory. NO reemplazar `scripts/build.mjs` de Purchase con el de Inventory.
4. Mantener el acceso configurado: las variables y binding D1 `PURCHASE_DB` siguen siendo requeridos donde se hayan habilitado. No hay secretos en el ZIP.
5. Inspeccionar el nuevo Deployment de Cloudflare y que use el commit nuevo de `main`. Reintentar el primer commit sin `package.json` fallará como antes.
