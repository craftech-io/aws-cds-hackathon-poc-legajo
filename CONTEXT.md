# Legajo listo (aws-cds-hackathon-poc-legajo)

Agente de coordinación para estudios de despachantes de aduana en Latinoamérica: persigue los documentos de cada importación (factura comercial, packing list, certificado de origen) con el importador por WhatsApp y con el proveedor extranjero por email, manda cada documento a un lector documental externo, decide quién tiene que corregir cada observación, recalcula los plazos cuando se mueve el arribo y le deja al despachante un legajo listo para aprobar. Este glosario fija la palabra que se usa en documentos y textos públicos (español) y el identificador que se usa en código (inglés, entre backticks). Todo dato es sintético; ningún nombre corresponde a una empresa real.

## Language

### Organización y personas

**Estudio** (`Firm`):
Estudio de despachantes de aduana que usa la consola; es el tenant. Todo dato (importadores, proveedores, operaciones, bitácora) pertenece a un estudio y ningún usuario ve otro.
_Avoid_: agencia, empresa, organización, cliente (el cliente del estudio es el importador)

**Despachante** (`Broker`, rol `BROKER`):
Profesional del estudio que firma y aprueba el legajo. Único rol que aprueba o reabre.
_Avoid_: agente (es el software), gestor, aduanero

**Analista** (`Broker`, rol `ANALYST`):
Persona del estudio que sigue operaciones, toma conversaciones y escribe al importador; no aprueba.
_Avoid_: operador, asistente

**Invitado** (`GUEST`, rol `GUEST`):
Persona que prueba la demo sin ser de un estudio: tiene los permisos de un despachante **solo dentro de su propio estudio de invitado** y de su **mundo de invitado**. Hay dos clases: **reservado** (cuentas `guest-01..NN` y la sintética `guest-test`, creadas por el operador, sin email) y **público** (se registra solo en `/signup` con su email). Nunca ve datos reales ni escribe a personas reales (ADR-0014, ADR-0015).
_Avoid_: el nombre del rol anterior (ADR-0014 §8), evaluador, tester, usuario de prueba

**Operador** (`operator`):
Persona de Craftech que administra el stage: carga secretos, crea las cuentas internas y las reservadas, corre las capturas y los scripts de leads. No es un rol de la consola.
_Avoid_: admin, dueño

**Importador** (`Importer`):
Empresa argentina que importa y es cliente del estudio. Se comunica por WhatsApp a través de su **contacto** registrado (una persona con teléfono en formato E.164). Habla español rioplatense.
_Avoid_: cliente final, comprador (en UI), usuario

**Proveedor** (`Supplier`):
Exportador extranjero que emite la factura, el packing list y gestiona el certificado de origen. Se comunica por email en inglés, desde su zona horaria. Tiene uno o más **contactos de proveedor** (`SupplierContact`).
_Avoid_: vendedor, exportador (en código), shipper

**Contacto de proveedor** (`SupplierContact`):
Dirección de email registrada de un proveedor con estado `PENDING_CONFIRMATION`, `ACTIVE`, `BOUNCED` o `COMPLAINED`. El agente solo escribe a un contacto `ACTIVE`; nunca a una dirección que escribió el modelo ni a la de un `From` entrante.
_Avoid_: mail del proveedor (como dato suelto)

**Transportista** (`Carrier`):
Naviera que informa el arribo estimado del buque. En la POC es un feed simulado (`CarrierFeed`).
_Avoid_: naviera (en código), línea

### Operación y legajo

**Operación** (`Operation`):
Una importación concreta: número (`operationNumber`, 4 dígitos, p. ej. `4471`), importador, proveedor, buque, transportista, régimen, ETA, número de factura e incoterm. La crea el estudio desde la plataforma de gestión aduanera (simulada, `PlatformMock`).
_Avoid_: embarque, despacho (es otra cosa), expediente, carpeta

**Legajo** (`Dossier`):
Conjunto de los tres documentos de una operación con su estado, sus observaciones y su historia. Estados del legajo (`DossierStatus`): **abierto** (`OPEN`), **listo para revisión** (`READY_FOR_REVIEW`), **aprobado** (`APPROVED`), **reabierto** (`REOPENED`).
_Avoid_: file, carpeta, expediente, caso

**Documento** (`Document`, tipo `DocType`):
Uno de los tres documentos del legajo, y solo esos tres:
- **Factura comercial** (`COMMERCIAL_INVOICE`)
- **Packing list** (`PACKING_LIST`)
- **Certificado de origen** (`CERTIFICATE_OF_ORIGIN`)

Cada documento tiene versiones (`DocumentVersion`: archivo PDF, `sha256`, quién lo mandó, lectura).
_Avoid_: archivo, adjunto (es el transporte), papel, BL (no está en el alcance)

**Estado del documento** (`DocStatus`):
**faltante** (`MISSING`), **recibido** (`RECEIVED`, en lectura), **con observación** (`WITH_OBSERVATION`), **válido** (`VALID`). Solo el lector y el despachante mueven un documento a válido: el lector por una lectura sin observaciones bloqueantes, el despachante por dispensa.
_Avoid_: ok, aprobado (el que se aprueba es el legajo)

**Lector documental** (`DocumentReader`):
Producto externo (en la POC, un mock nuestro detrás de un contrato OpenAPI) que recibe un PDF y devuelve una **lectura** (`Reading`): tipo, campos, confianza y observaciones. Nosotros no leemos, no clasificamos ni extraemos nada de un PDF.
_Avoid_: OCR, parser, extractor, IA de documentos

**Lectura** (`Reading`):
Respuesta del lector para una versión de documento. `status`: `RECOGNIZED`, `UNRECOGNIZED` (documento que el lector no conoce: va al despachante) o `ERROR`.
_Avoid_: resultado del OCR, análisis

**Observación** (`Observation`):
Inconsistencia que devuelve el lector (código `ObservationCode`, p. ej. `GROSS_WEIGHT_MISMATCH`: peso bruto del packing list 12.480 kg contra 12.840 kg de la factura). Estados: `OPEN`, `CORRECTION_REQUESTED`, `RESOLVED`, `ESCALATED`, `WAIVED_BY_BROKER`. El agente no la reinterpreta: decide quién la corrige.
_Avoid_: error, rechazo, falla, discrepancia (en código)

**Responsable** (`responsibleParty`):
Parte que tiene que corregir una observación o mandar un documento faltante: `SUPPLIER`, `IMPORTER` o `BROKER`. La **matriz de responsabilidad** (`ResponsibilityMatrix`) del estudio da el valor por defecto por tipo de documento y código de observación; el agente lo asigna con `assign_responsible` y una asignación que no coincide con la matriz queda marcada para revisión.
_Avoid_: dueño, culpable, a cargo

**Intento** (`attempt`):
Cada pedido de corrección de una misma observación. Al segundo intento fallido (la versión corregida vuelve con la misma observación) la observación se escala.
_Avoid_: reintento (es técnico), vuelta

**Aprobación** (`Approval`):
Decisión humana del despachante que pasa el legajo a `APPROVED`. Siempre humana: no existe tool del agente que apruebe. Con el legajo aprobado el agente ya no pide nada a nadie: al importador solo le avisa la aprobación y el estado del despacho, le confirma una baja y le responde si escribe; al proveedor no le escribe (`CP-APPROVED-SCOPE`).
_Avoid_: validación, visto bueno, cierre

**Reapertura** (`Reopen`):
El despachante devuelve un legajo aprobado a `REOPENED` (p. ej. llegó una versión nueva). El agente retoma.
_Avoid_: rechazo

**Estado del despacho** (`DispatchStatus`):
Eventos de aduana simulados posteriores a la aprobación: **oficializado** (`OFICIALIZADO`), **canal asignado** (`CANAL_ASIGNADO`, con canal `VERDE`, `NARANJA` o `ROJO`), **liberado** (`LIBERADO`). Se informan al importador con una explicación genérica, sin asesoramiento.
_Avoid_: estado aduanero, semáforo

### Tiempo

**ETA** (`eta`):
Arribo estimado del buque, con zona horaria. Lo informa el transportista y puede moverse; todo plazo del legajo se calcula desde la ETA vigente.
_Avoid_: fecha de llegada, arribo (sin "estimado")

**Hito** (`Milestone`):
Momento del legajo relativo a la ETA; es un **temporizador** de tipo `MILESTONE`:
- `DOCS_REQUEST`: ETA − 7 días, 10:00 de Argentina (primer pedido)
- `FOLLOWUP`: ETA − 5 días, 10:00
- `FOLLOWUP_FINAL`: ETA − 3 días, 10:00
- `ESCALATION`: ETA − 48 h (escalamiento si faltan documentos)
- `ARRIVAL`: ETA (el legajo que no está completo queda en riesgo)

Cuando la ETA cambia, se **reprograman** todos los hitos pendientes; un hito que quedó en el pasado se dispara una sola vez.
_Avoid_: recordatorio (es un mensaje), alarma, deadline

**Plazo** (`deadline`):
Fecha límite que se le comunica a una parte para mandar o corregir un documento. Para el proveedor se expresa en su zona horaria.
_Avoid_: vencimiento

**Temporizador** (`Timer`, `TIMER#<kind>#<id>`):
Todo lo que tiene que pasar en una hora simulada: hito, envío diferido por horario, seguimiento que agendó el agente, respuesta demorada del simulador de proveedor, reintento del lector, control de contacto después de un rebote, reintento de un rebote transitorio. La consola lo muestra como **pendiente** con su motivo.
_Avoid_: job, cron, tarea programada

**Reloj de demo** (`DemoClock`, `clockId`):
Tiempo simulado de un mundo de datos. Por defecto está **en pausa** (`PAUSED`): la hora solo se mueve con los controles ("Avanzar al próximo evento", "+1 h", "+1 día"), que disparan en orden los temporizadores vencidos. **Reloj en vivo** (`RUNNING`) lo hace correr en tiempo real (`ahora simulado = ahora real + offset`) durante 30 minutos. Cada operación pertenece a un reloj (`GLOBAL` para la demo de un estudio, `GUEST` para el mundo de un invitado, `qa-<runId>-<escenario>` para el ejecutor de escenarios, `sim-<batchId>` para el lote de métricas). Toda regla de negocio lee el reloj de la operación, nunca `Date.now()`.
_Avoid_: tiempo falso, mock de fecha

**Mundo ocupado** (`WORLD_BUSY`):
Estado de un mundo mientras algo sigue en curso: un turno del agente, un evento en cola, un email en tránsito hasta que su destinatario simulado lo procesa o un PDF esperando el escaneo (**pendientes**). La consola no deja mover el reloj ni inyectar eventos hasta que el mundo está **quieto**; el ejecutor de escenarios lo espera con `op.settle`.
_Avoid_: bloqueado, lock

**Época** (`worldEpoch`):
Número del reloj que sube en cada "Reiniciar demo", en cada recarga del seed y en cada mundo nuevo, y que nunca vuelve atrás (sale de un contador que no se borra); separa la memoria del agente y las direcciones de email de un mundo de las del anterior.
_Avoid_: versión (es otra cosa), generación

**Supuesto** (`Assumption`):
Parámetro editable y rotulado que no es un hecho verificado: días libres en puerto (≈ 5), costo diario de demora de contenedor (≈ USD 160-180), minutos manuales de base por legajo. Todo número que depende de un supuesto se muestra con la etiqueta "supuesto".
_Avoid_: dato, tarifa, costo real

**Riesgo de demora** (`DelayRisk`):
Estimación de días en riesgo y costo potencial para un legajo incompleto, calculada en código a partir de supuestos rotulados. Nunca es una promesa ni un hecho.
_Avoid_: multa, penalidad, costo de demora (sin "estimado")

### Canales y contacto

**Canal** (`Channel`):
`WHATSAPP` (importador), `EMAIL` (proveedor y despachante) y la consola (`CONSOLE`, nunca como canal de envío). Sin SMS, RCS ni voz.
_Avoid_: medio, vía

**Modo de canal** (`ChannelMode`):
`live` o `simulated`, por canal, en `sst.Linkable("ChannelModes")`. Email corre `live` (SES real de punta a punta); WhatsApp corre `simulated` hasta que el CTO conecte la cuenta de WhatsApp Business. El modo cambia el transporte, nunca el flujo.
_Avoid_: feature flag (el canal nunca está apagado), modo prueba

**Opt-in** (`Consent` `WHATSAPP_OPT_IN`):
Consentimiento del contacto del importador para recibir WhatsApp del estudio, con fecha, medio y texto mostrado. Sin opt-in vigente no sale ningún WhatsApp. **Opt-out** (`revokedAt`): el importador pidió no recibir avisos.
_Avoid_: suscripción, alta

**Autorización de contacto con el proveedor** (`supplierContactAuthorization`):
Permiso del importador, registrado por el estudio, para que el agente escriba directamente a su proveedor. Sin ella el agente no manda email al proveedor.
_Avoid_: permiso (suelto), delegación

**Ventana de 24 h** (`serviceWindow`):
Período de 24 h desde el último mensaje del importador en el que WhatsApp admite texto libre. Fuera de la ventana solo salen **plantillas** aprobadas. La abre solo un mensaje del importador (texto, botón de respuesta o adjunto); abrir o usar el **link de carga** no la abre.
_Avoid_: sesión (es otra cosa), conversación abierta

**Plantilla** (`Template`):
Mensaje de WhatsApp preaprobado por Meta, categoría `UTILITY`, en `es_AR`, con parámetros y botones (p. ej. `legajo_docs_pendientes`). En modo `simulated` se renderizan igual que en `live`. El nombre del estudio va como parámetro con su nombre completo registrado ("te escribimos desde Estudio Delta"): ningún cuerpo le antepone "estudio".
_Avoid_: template (en UI), mensaje predefinido

**Dirección de la operación** (`threadAddress`):
Dirección de email única por operación y mundo, con una etiqueta que no se puede adivinar (`op-4471-k7p2q9@legajo.demo.craftech.io`, abreviada `op-4471@`), desde la que se escribe al proveedor y a la que responde. Correlaciona el hilo aunque se pierdan los encabezados.
_Avoid_: casilla, alias

**Política de contacto** (`ContactPolicy`):
Reglas en código (ids `CP-*`) que decide si un mensaje sale, cuándo y por dónde: opt-in, ventana de 24 h, horario de Argentina y del proveedor, un recordatorio por contacto por día, autorización de contacto con el proveedor, cerco de destinatarios. Nunca en el prompt.
_Avoid_: reglas del bot, configuración

**Cerco de destinatarios** (`RecipientFence`):
Regla del stage, dentro del único cliente de SES y reforzada por IAM, que depende del **perfil de remitente** que declara el que llama (y que el cliente verifica contra el `From`, nunca contra el destinatario): el sistema (`SYSTEM`) solo escribe a buzones de nuestro dominio de simulación, al simulador de buzones de SES y a destinatarios de demo registrados (nunca desde un mundo de invitado, que solo escribe a buzones simulados); el simulador de proveedor (`SIMULATOR`) solo responde a la dirección de la operación verificada del correo que contesta y solo desde un contacto `ACTIVE` registrado del proveedor de esa operación (una regla de datos, no de prefijo: vale igual en mundos de demo, de invitado y QA); el ejecutor de escenarios (`QA`) escribe desde su buzón inyector `qainject-…` (que nunca es una parte) o, para probar suplantaciones, desde una parte de un mundo `qa-*` que no es contacto `ACTIVE` de la operación destinataria, y solo a sus propios buzones y a direcciones de operación de sus mundos `qa-*` (o inexistentes, para probar descartes). El **aviso de lead** (`LEAD_NOTICE`) solo escribe a direcciones exactas de `craftech.io`. Los emails de cuenta (código de alta, recuperación) los manda Cognito a la dirección del propio usuario, con las cuotas del trigger `CustomMessage` (ADR-0015). Nunca a un dominio reservado (`.test`, `.example`, `.invalid`, `.localhost`, `example.com|net|org`).
_Avoid_: allowlist (suelta), whitelist

**Violación de política** (`PolicyViolation`):
Mensaje enviado sin una decisión `ALLOW` registrada, o que la política, reevaluada después con los datos de ese momento (reconstruidos de las historias con fecha), habría denegado. La meta es cero y la cuenta el trabajo `PolicyAudit`.
_Avoid_: error de envío, incidente

### Agente y traspaso

**Agente** (`Agent`):
El Harness de AgentCore que decide qué hacer ante cada evento de una operación, usando tools. Se comunica **solo** por las tools `send_whatsapp` y `send_email`; el texto final de su turno es una **nota del turno** (`turnNote`) que va a la bitácora y nunca se envía.
_Avoid_: bot, asistente virtual, IA

**Turno** (`Turn`):
Una invocación del Harness para una operación, disparada por un **evento** (`TurnTrigger`: `IMPORTER_MESSAGE`, `SUPPLIER_EMAIL`, `DOCUMENT_READ`, `MILESTONE`, `ETA_CHANGED`, `EMAIL_BOUNCED`, `CONTACT_CONFIRMED`, `UPLOAD_COMPLETED`, `BROKER_RELEASED`, `FOLLOWUP_DUE`). Los turnos de una operación corren de a uno, en orden. Cada evento lleva un `eventId` (`evt_…`) que sale de su origen (el `wamid`, el `Message-ID`, el temporizador) para que una reentrega se procese una sola vez.
_Avoid_: ejecución, request, conversación

**Checklist** (`Checklist`):
Requisitos que el estudio exige por tipo de documento, escritos por el estudio (sintéticos en la POC). Es la única fuente con la que el agente responde dudas del importador.
_Avoid_: normativa, reglamento, base de conocimiento

**Escalamiento** (`Escalation`):
Traspaso de una operación al despachante con motivo (`EscalationReason`): `MISSING_AT_ETA_48H`, `OBSERVATION_ATTEMPTS`, `OUT_OF_CHECKLIST`, `IMPORTER_ASKED`, `UNRECOGNIZED_DOCUMENT`, `NO_VALID_CONTACT`, `UNTRUSTED_SENDER`, `OPTED_OUT`, `READER_UNAVAILABLE`, `OTHER` (con resumen, p. ej. falta de opt-in o de autorización). Aparece en la consola y, si corresponde, en un email al buzón del estudio.
_Avoid_: alerta, ticket, derivación (en código)

**Tomar conversación** (`takeover`, `control = BROKER`):
Acción del despachante o analista que pausa al agente en una operación; desde ahí escribe él desde la consola en el mismo hilo de WhatsApp. **Devolver al agente** (`release`, `control = AGENT`) lo reanuda.
_Avoid_: intervenir, pausar el bot, handoff (en UI)

**Nota del turno** (`turnNote`):
Texto final del Harness en un turno: resumen interno para la bitácora y la consola. Nunca sale por un canal.
_Avoid_: respuesta del agente

### Superficies y mocks

**Consola** (`Console`):
Web del estudio detrás de login propio sobre Cognito: operaciones, detalle del legajo, registro, reloj de demo, simulador de teléfono, buzón de demo, métricas, bitácora.
_Avoid_: backoffice, panel, dashboard (es una vista)

**Link de carga** (`UploadLink`):
Link seguro de un solo destinatario y vencimiento corto que el importador recibe por WhatsApp para subir PDFs de una operación (`/u/<token>`). Cada archivo sube a S3 con una URL prefirmada de 5 minutos. La página misma confirma la recepción; el acuse por WhatsApp sale solo si la **ventana de 24 h** ya estaba abierta, y nunca como recordatorio.
_Avoid_: link de upload, formulario

**Simulador de teléfono** (`PhoneSimulator`):
Vista de la consola, rotulada "simulador", que hace de teléfono del importador cuando WhatsApp corre en modo `simulated`: entra por el mismo normalizador que el evento real de WhatsApp y muestra lo saliente como lo mostraría WhatsApp.
_Avoid_: chat de prueba, emulador

**Simulador de proveedor** (`SupplierSimulator`):
Lambda que recibe por SES los emails dirigidos a los buzones simulados de proveedores (`supplier-<código>@sim.legajo.demo.craftech.io`), solo actúa sobre correo que mandamos nosotros (verificado por DMARC, remitente y `Message-ID`) y responde en inglés con los PDFs sintéticos según el **comportamiento** configurado (`SupplierBehaviour`: `PROMPT`, `SEEDED_ERROR`, `SEEDED_ERROR_TWICE`, `LATE`, `NEVER`, `WRONG_DOC`, `UNKNOWN_DOC`, `PROMISE`, `AUTO_REPLY`, `INJECTION`, `BOUNCE`, `COMPLAINT`).
_Avoid_: bot del proveedor, fake supplier

**Buzón de demo** (`DemoMailbox`):
Buzones simulados del estudio (`estudio-<código>@sim.legajo.demo.craftech.io`) que reciben por SES los emails de escalamiento; la consola los muestra para que un invitado vea lo que recibió el despachante. Todo email de producto de un mundo de invitado termina acá, nunca en una casilla real.
_Avoid_: bandeja de prueba

**Plataforma de gestión aduanera** (`PlatformMock`):
Sistema externo simulado que tiene las operaciones (buque, régimen, ETA) y emite eventos del transportista (`CarrierEtaChanged`) y de aduana (`CustomsStatusChanged`) al bus `Feeds`.
_Avoid_: sistema del cliente, ERP

**Mundo** (`World`):
Conjunto de datos con su reloj: el mundo de demo de cada estudio (reloj `GLOBAL`), el **mundo de invitado** (uno por invitado, reloj `GUEST`), los mundos efímeros del ejecutor de escenarios (reloj `qa-*`, se borran al terminar) y los del lote de métricas. Reiniciar uno no toca a otro.
_Avoid_: sandbox, tenant

**Ejecutor de escenarios** (`ScenarioRunner`):
Script que recorre los flujos del catálogo contra el stage desplegado, con IAM y sin credenciales humanas, a través de la Lambda `QaDriver`, y asierta sobre estado persistido y bitácora.
_Avoid_: bot de pruebas, e2e (es otra cosa)

### Alta, invitados y leads

**Superficie visible**:
Todo lo que lee una persona que usa el producto: landing, alta, login, consola, páginas legales, simuladores, buzón de demo, link de carga, emails, PDFs, plantillas de WhatsApp y textos del seed que se muestran. Ninguna nombra el concurso ni a sus evaluadores; lo verifica `npm run lint:neutral-surfaces` (ADR-0014). Los identificadores internos (nombre de la app, buckets, roles) no son superficie visible, pero nunca se usan en un texto.
_Avoid_: front, pantallas (a secas)

**Landing** (`Landing`, `/`):
Página comercial del producto: problema, qué hace, para quién, recorrido animado con imágenes del producto real, cómo se integra, impacto como **metas** rotuladas y qué es simulado; CTAs "Probar la demo", "Ingresar" y "Hablemos" (ADR-0016).
_Avoid_: home, portada, sitio

**Captura** / **Render** (`capture` / `render`):
Imagen de la landing. Una **captura** sale del producto real (consola o página servida) por el pipeline de capturas, con origen `poc` o `local` (esta última rotulada "Entorno local, agente guionado"); un **render** es una animación hecha con componentes y textos reales del producto para una vista que todavía no existe o que queda por diseño, rotulada "Animación con los componentes y textos del producto", y declara qué captura lo reemplaza y con qué **política**: `swap` (sale cuando su captura es de `poc`) o `zoom` (queda y "Ampliar" abre la captura) (`scripts/landing/renders.json`, ADR-0016 §3). Nunca un mockup.
_Avoid_: mockup, maqueta, screenshot (en docs)

**Alta** (`signup`, `/signup`):
Registro de un invitado público: email y contraseña, nombre, empresa y cargo opcionales, dos **consentimientos** y un código que Cognito manda al email. El navegador nunca llama a Cognito para crear la cuenta: el BFF guarda el alta y responde siempre igual, y `SignupDispatch` hace después las llamadas que crean la cuenta o mandan el código; Cognito rechaza un alta sin **ticket de alta**. Solo una cuenta pública de invitado existente sigue el camino de "ya tenés una cuenta"; el lead se escribe recién con la **verificación** del código (ADR-0015). En **modo lista de espera** el mismo formulario es un **pedido de acceso**.
_Avoid_: registro (en código), sign-up (en UI en español), onboarding

**Ticket de alta** (`signup ticket`):
Firma HMAC de corta vida (120 s) que `SignupDispatch` agrega a su llamada a `SignUp` y que el trigger `PreSignUp` exige; sin ella no se crea ningún usuario ni sale ningún email.
_Avoid_: token (a secas), captcha

**Modo de alta pública** (`PublicSignupMode`: `open` \| `waitlist`):
Valor único del stage que decide qué hace el formulario de `/signup`. En `waitlist` (valor inicial, con el que se despliega la ola 3) el formulario es un **pedido de acceso**: guarda un lead en lista de espera y no crea cuenta, mundo ni manda nada al visitante, salvo la **excepción cercada** (buzones `qa-signup-*` del `QaDriver` y casillas `<local>@craftech.io`), que hace el alta completa; la landing dice "Pedir acceso" y no se indexa. En `open` el formulario es el alta. Lo cambia el operador por PR cuando se cumple el criterio de ADR-0015 §1.4; manda el valor del BFF.
_Avoid_: beta, preregistro, modo cerrado

**Pedido de acceso** (`WAITLISTED`, `/signup/waitlisted`):
Envío del formulario en modo lista de espera: deja un lead con `status WAITLIST` y el email **sin verificar**, y un aviso a Craftech. Cuando el alta abre, Craftech avisa una vez a esas personas y, si se dan de alta, su lead pasa a `ACTIVE`.
_Avoid_: reserva, inscripción, pre-registro

**Lead** (`Lead`, tabla `Leads`):
Registro comercial de una persona que confirmó su alta (`status ACTIVE`) o que pidió acceso en modo lista de espera (`status WAITLIST`, email sin verificar): email, datos opcionales, consentimientos, idioma, POC de origen, UTM y referrer, fecha de alta y último ingreso. Vive separado de los datos de la demo y sobrevive al TTL del mundo. La tabla la tocan solo el BFF (alta y último ingreso), `SignupDispatch` (altas pendientes y leads de la lista de espera), `WorldJanitor` (barrido y borrado), el aviso a Craftech, el `QaDriver` cercado a sus buzones de prueba y los scripts del operador (`leads:export`, `leads:optout`, `leads:delete`); nunca el agente, `ChannelEvents` ni los triggers de Cognito.
_Avoid_: cliente, prospecto (en código), contacto (es otra cosa)

**Consentimiento** (`consents.terms`, `consents.contact`):
Aceptación explícita, separada y sin tildar por defecto, guardada con fecha y **versión del texto**: términos y privacidad (obligatorio para la cuenta) y "Acepto que Craftech me contacte por esta solución" (opcional, revocable sin perder la cuenta).
_Avoid_: opt-in (es el de WhatsApp del importador), checkbox

**Aviso de lead** (`LeadNotice`):
Email interno por cada lead nuevo o pedido de acceso a la casilla `@craftech.io` que configura el operador (secreto `LeadNoticeTo`); el cerco solo deja salir a direcciones de `craftech.io`. No es correo de un mundo: no tiene reloj ni queda como pendiente de correo.
_Avoid_: notificación, alerta

**Mundo de invitado** (reloj `GUEST#firm-guest-<nn>`):
Mundo aislado y sembrado desde la plantilla curada `guest`, con reloj en pausa, que se crea en el primer ingreso del invitado (una sola creación por cuenta aunque lleguen muchos pedidos juntos: la cuenta toma primero su **arrendamiento**, `GUESTWORLD#<sub>`). El de un invitado público ocupa un **cupo** y tiene **TTL**; al vencer se destruye con todo lo que se cargó en él, incluidos los PDFs, y el siguiente ingreso crea otro; los tokens del dueño anterior dejan de servir en el acto. El de un invitado reservado no vence: se reinicia de noche si no se usó en 24 h.
_Avoid_: sandbox, mundo de prueba

**Cupo de invitado** (`SLOT#GUEST#<nn>`):
Lugar numerado (`nn` de dos dígitos) que ocupa un mundo de invitado: `01–30` reservados, `31–90` públicos (60 mundos públicos activos como máximo). El número fija el estudio `firm-guest-<nn>`, el bloque de teléfonos ficticios y el prefijo de los buzones simulados `g<nn>-`. Un cupo liberado no se vuelve a arrendar hasta 20 minutos después. Sin cupo libre, el invitado ve "La demo está completa en este momento".
_Avoid_: slot (en UI), lugar

**TTL del mundo**:
Vida de un mundo de invitado público: se destruye a las 24 h reales sin actividad o a las 72 h reales de creado, lo que llegue primero. La cuenta y el lead no vencen con él.
_Avoid_: expiración de la cuenta

**Estado de rebote** (`MAILSTATUS#<emailHash>`):
Marca por destinatario, exista o no un lead, de que un email de cuenta rebotó o fue marcado como no deseado; desde ahí ese destinatario no recibe más emails de cuenta. Si los rebotes y quejas de un día pasan el umbral, el **disyuntor de reputación** corta las altas y los emails de cuenta hasta que el operador lo cierre (ADR-0015 §3.2), para no dañar la reputación de SES que comparten todas las demos de la cuenta.
_Avoid_: bounce list, lista negra

**Cuota de uso** (`QUOTA#<clockId>#<tipo>`):
Tope por mundo de invitado en **reloj real** (turnos del agente, emails salientes, mensajes del simulador, movimientos del reloj, cargas, operaciones nuevas, reinicios), más un presupuesto diario global de los mundos públicos. Al superarla, la acción se rechaza con `QUOTA_EXCEEDED` y la hora en que se renueva.
_Avoid_: rate limit (es el del alta), límite de la cuenta

**Rate limit del alta** (`RL#…`):
Tope por IP, por email, por dominio y total sobre el alta, el reenvío del código y los emails de cuenta; su objetivo es que el alta no sirva para mandar códigos a terceros ni para agotar el cupo.
_Avoid_: cuota (es la del mundo)

### Métricas

**Minutos humanos por legajo** (`humanMinutes`):
Acciones humanas sobre una operación (tomar, enviar, dispensar, clasificar, aprobar, reabrir) por los minutos por acción que declara el estudio (**supuesto**), comparados con una **base manual declarada** como desglose (contactos por legajo × minutos por contacto + revisión). El tiempo de consola medido por latidos es una métrica secundaria aparte.
_Avoid_: horas ahorradas (como hecho)

**Rótulo de métrica**:
Todo número de la vista de métricas dice su N, el mundo del que sale y si es **medido** (agente real), **agente guionado** (pipeline real con el agente reemplazado por un plan fijo) o **supuesto**.
_Avoid_: simulación (a secas)

**Recorrido guiado** (`Tour`):
Pasos del invitado sobre la historia principal (operación 4471), con un botón por paso y glosa en inglés; la misma fuente genera las instrucciones del README y el escenario `SC-24`. Sigue la misma línea de tiempo que la historia y el video (pedido el 15/10 10:00); las horas que muestra salen del reloj del mundo, y la plantilla de invitado no tiene eventos de otras operaciones en la ventana del recorrido.
_Avoid_: tutorial, onboarding

**Intervenciones humanas** (`interventions`):
Acciones de personas sobre una operación: tomar conversación, escribir, dispensar una observación, editar un contacto, aprobar, reabrir.
_Avoid_: tickets, toques

**Costo por legajo** (`costPerDossier`):
Tokens de Bedrock de los turnos de la operación más mensajes enviados, por las tarifas de `RateCard` (con fuente y fecha). En modo `simulated`, los WhatsApp se valorizan como si fueran `live` y se rotulan.
_Avoid_: precio, facturación

## Relationships

- Un **Estudio** tiene **Despachantes** y **Analistas**, **Importadores**, **Proveedores** y **Operaciones**.
- Una **Operación** tiene exactamente un **Importador**, un **Proveedor**, un **Legajo**, una **Dirección de la operación**, un **Reloj** y cinco **Hitos**.
- Un **Legajo** tiene exactamente tres **Documentos**; cada **Documento** tiene cero o más **Versiones**, y cada versión una **Lectura**.
- Una **Lectura** tiene cero o más **Observaciones**; cada **Observación** tiene un **Responsable** y cuenta sus **Intentos**.
- Un **Importador** tiene un **Opt-in** (vigente o revocado) y, por proveedor, una **Autorización de contacto**.
- Un **Proveedor** tiene uno o más **Contactos de proveedor**, una zona horaria y un idioma.
- Un **Turno** pertenece a una **Operación** y lo dispara un evento; los turnos de una operación son secuenciales.
- Un **Escalamiento** pertenece a una **Operación**; **Tomar conversación** pone el control de la operación en el estudio.
- Un **Invitado** tiene a lo sumo un **Mundo de invitado** vivo, que ocupa un **Cupo**; un invitado público tiene exactamente un **Lead** (uno por email) con dos **Consentimientos**; un **Pedido de acceso** deja un lead sin cuenta, que pasa a ser el de la cuenta si esa persona se da de alta.
- Un **Lead** sobrevive al **TTL del mundo**; borrar un lead borra también su cuenta de Cognito y su mundo, si los tiene.

## Example dialogue

> **Despachante:** "¿El legajo de la 4471 ya está listo?"
> **Consola:** "No: la factura comercial es válida; el packing list está **con observación** (peso bruto 12.480 kg contra 12.840 kg de la factura), **responsable: proveedor**, primer **intento** pedido hoy 11:02 hora de Qingdao; el certificado de origen está **faltante**. Próximo **hito**: `FOLLOWUP` el 17/10 10:00."
> **Despachante:** "¿Y el importador sabe?"
> **Consola:** "Sí, recibió por WhatsApp 'no tenés que hacer nada, se lo pedimos al proveedor'. Está dentro de la **ventana de 24 h**."
> **Despachante:** "Si el proveedor manda otra vez mal el peso, ¿qué pasa?"
> **Consola:** "Es el segundo **intento** fallido: la observación se **escala** y te llega a la consola y al buzón del estudio. El agente no la dispensa; la **dispensa** es tuya."

## Flagged ambiguities

- "Despacho" se usó para la operación y para el trámite aduanero: se resolvió que **operación** es la importación y **estado del despacho** son los eventos de aduana posteriores a la aprobación.
- "Aprobar" se usó para documentos y para el legajo: se resolvió que el lector deja un documento **válido** y el despachante **aprueba** el legajo; un documento con observación se **dispensa**, no se aprueba.
- "Recordatorio" se usó para el hito y para el mensaje: el **hito** es el momento programado; el **recordatorio** es un mensaje de tipo `REMINDER` que un hito puede o no producir. Por WhatsApp solo lo produce un turno de hito o de seguimiento: no sirve de acuse ni de respuesta cuando la ventana está cerrada.
- "Cliente" puede ser el estudio (cliente de Craftech) o el importador (cliente del estudio): en documentos y UI se dice **estudio** e **importador**, nunca "cliente". Quien deja su email en el alta es un **lead** de Craftech, no un cliente.
- Quien prueba la demo se llamaba con el nombre del rol de los evaluadores del concurso: se resolvió **invitado** (`GUEST`) en código, datos, textos y documentos; los documentos internos que hablan del concurso dicen "evaluadores del concurso" (ADR-0014).
- "Opt-in" es el consentimiento de WhatsApp del importador dentro de la demo; el **consentimiento** del alta es el de la persona real que se registra. Nunca se mezclan.
- "Cuota" y "rate limit": la **cuota de uso** es del mundo (costo); el **rate limit del alta** es del registro (abuso y reputación de SES).
