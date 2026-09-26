---
status: accepted
---

# Modos de canal: email en vivo, WhatsApp simulado hasta que exista la WABA

El importador vive en WhatsApp y el proveedor en el email. Email por Amazon SES se puede operar de punta a punta hoy: la cuenta está en producción, los proveedores simulados son buzones nuestros que SES recibe de verdad y los rebotes se producen con el simulador de buzones de SES. WhatsApp por AWS End User Messaging Social necesita una WhatsApp Business Account conectada con Meta, un número y plantillas aprobadas: eso depende del CTO y de Meta, fuera de nuestras manos. Decidimos que cada canal tenga un **modo** (`live` o `simulated`) en `sst.Linkable("ChannelModes")`: email corre `live`; WhatsApp corre `simulated` con un transporte que persiste exactamente el cuerpo que se mandaría a `SendWhatsAppMessage` y un **simulador de teléfono** en la consola que entra por el mismo sobre SNS y el mismo normalizador que un evento real. Pasar WhatsApp a `live` es cambiar el modo y cargar `WabaId` y `WhatsAppPhoneNumberId`; ningún flujo, tool, política ni texto cambia.

## Considered options

- **Esperar la WABA para construir WhatsApp**: bloquea el flujo central del producto en algo que no controlamos.
- **Feature flag que apaga WhatsApp**: deja al importador sin canal en la demo y obliga a flujos alternativos que no son el producto.
- **Un chat web propio en lugar de WhatsApp**: probaría otra cosa; el valor es que el importador no instala nada.
- **Modo simulado con el mismo contrato** (elegida): la demo muestra el producto real y el adaptador vivo queda probado con fixtures de la forma real.

## Consequences

- `channels/whatsapp/` tiene dos transportes detrás de una interfaz; el registro instancia uno según el modo.
- El topic `aws-cds-hackathon-poc-legajo-wa-inbound` y la suscripción existen siempre; solo el destino de eventos de la WABA espera a P-01.
- Un check de CI impide `whatsapp: "live"` mientras P-01 esté abierto; `InboundWhatsApp` rechaza sobres simulados en modo vivo.
- La ventana de 24 h se mide con el reloj de la operación en modo simulado y con el reloj real en vivo, porque Meta mide tiempo real.
- Los costos de WhatsApp de la demo se valorizan como si fueran vivos y se rotulan.
