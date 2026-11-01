# Purchase — pruebas manuales de correo de alertas

La página `alerts-test.html` añade una sección separada para probar los cuatro formatos solicitados por Ceci:

1. Gross margin menor a 20% en productos vendidos durante la semana anterior.
2. Sell-through críticamente por debajo de los objetivos a 30, 60 o 90 días.
3. Stock en riesgo, comparado con la demanda estacional del período equivalente del año anterior. La base exacta (mes equivalente o promedio comparable de tres meses) queda pendiente de aprobación.
4. Descuento superior a 20% o más de un código de descuento en la misma orden.

Cada tarjeta tiene su propia lista de destinatarios y botón. Los mensajes están marcados como **TEST EMAIL — NOT A LIVE ALERT**. En esta fase no se calculan ni se inventan productos, órdenes o valores reales; se valida el formato y la entrega del correo. No hay envíos automáticos.

## Configuración necesaria en Cloudflare Pages

Configurar como secrets/environment variables de Functions:

- `RESEND_API_KEY`: clave API de Resend.
- `PURCHASE_ALERT_FROM`: remitente verificado en Resend, por ejemplo `Purchase Alerts <alerts@tu-dominio-verificado.com>` (usar el dominio real verificado de la organización).

La función `POST /api/alert-test` exige sesión autenticada y acceso al reporte `purchase_executive`, valida las direcciones y limita cada prueba a ocho destinatarios. No guardar claves API en GitHub ni en el navegador.

## Prueba

1. Desplegar el proyecto en Cloudflare Pages con las dos variables configuradas.
2. Ingresar al dashboard con una cuenta autorizada.
3. Abrir **Alert email tests** en la navegación.
4. Introducir uno o varios correos en la tarjeta correspondiente y pulsar **Send test email**.
5. Confirmar recepción y revisar spam/promociones si no aparece en la bandeja principal.

Una vez aprobados el contenido, destinatarios y reglas de cálculo, se podrá conectar cada categoría a una automatización independiente. La prueba manual no activa esa automatización.
