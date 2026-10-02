# Pendientes fuera de nuestras manos

Solo lo que depende de alguien fuera del equipo de agentes (el CTO, Meta, AWS Partner Central). Todo lo demás está en `docs/build-plan.md`. Cada entrada se cierra con fecha y quién la cerró, escrito en la columna "Estado" como `Cerrado el AAAA-MM-DD por <quién>`: `npm run channels:check-modes` lee esa columna y no deja pasar `whatsapp: "live"` mientras P-01 no diga "Cerrado".

| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Conectar WhatsApp: cuenta de WhatsApp Business, número y plantillas aprobadas | CTO (Meta); `devops` ejecuta los scripts; `qa` prueba en vivo | Abierto | §1 |
| P-02 | Oportunidad ACE de la submission | CTO | Abierto | §2 |
| P-03 | Video de 3 minutos | CTO | Abierto | §3 |
| P-04 | Decisión de marca pública | CTO | Abierto | §4 |
| P-05 | Credenciales de las cuentas reservadas `guest-NN` en las instrucciones privadas de prueba de la submission | CTO con el operador | Abierto | §5 |
| P-06 | Datos del responsable para la política de privacidad, casilla de privacidad, destinatario del aviso de lead e inscripción de la base en la AAIP | CTO | Abierto | §6 |
| P-07 | Ola de superficies públicas: costos y límites a aceptar, secretos y bootstrap, supuesto de `CustomMessage`, alta de aceptación A-01 registrada como lead | CTO; el operador ejecuta | Abierto | §7 |

## 1. Conectar WhatsApp (P-01)

Hasta que esto se cierre, WhatsApp corre en modo `simulated` y la demo usa el simulador de teléfono (ADR-0002). Orden:

1. **Decisión de marca** (P-04, punto 2): display name que va a ver el importador.
2. **Portfolio de Meta Business** de Craftech con verificación en dos pasos; quien haga el alta tiene que ser administrador. Dueño: CTO.
3. **Número de teléfono** que reciba el código por SMS o llamada y que no esté registrado en la app de WhatsApp ni en WhatsApp Business (si lo estuvo, borrar la cuenta desde la app y esperar). Dueño: CTO.
4. **Alta por registro embebido**: consola de AWS End User Messaging Social en `craftech-demos` (`us-east-1`) → agregar número de WhatsApp → portal de Facebook → vincular el portfolio, crear o elegir la WABA, registrar el número con el código, cargar el display name, aceptar los términos de Meta. Dueño: CTO con `devops` presente. Verificación: `aws --profile craftech-demos socialmessaging list-linked-whatsapp-business-accounts`.
5. **Secretos**: `npx sst secret set WabaId <id> --stage poc` y `npx sst secret set WhatsAppPhoneNumberId <id> --stage poc`, con el operador presente y sin pegar valores en ningún chat. Dueño: `devops`.
6. **Destino de eventos** de la WABA al topic `aws-cds-hackathon-poc-legajo-wa-inbound`: `npm run channels:waba-event-destination -- --stage poc --apply` (idempotente). Verificación: `aws --profile craftech-demos socialmessaging get-linked-whatsapp-business-account --id <WabaId>` (campo `eventDestinations`). Dueño: `devops`.
7. **Plantillas**: `npm run channels:whatsapp-templates -- --stage poc --apply` crea las 8 plantillas `UTILITY` `es_AR` de `docs/architecture-integrations.md` §4.3 y guarda id, estado y categoría. Meta las revisa (de minutos a 24 h). Verificación: `aws --profile craftech-demos socialmessaging list-whatsapp-message-templates --id <WabaId>` → todas `APPROVED` y `UTILITY`. Si Meta rechaza o recategoriza una, `architect` ajusta el texto en `packages/bff/src/copy/templates.ts` y se repite este paso. Dueños: `devops`; revisión de Meta.
8. **Teléfonos de demo**: el teléfono del CTO (y los de prueba del equipo) en `SeedOverrides` (`demoRecipients.phones` y `importerPhones`, por ejemplo `imp-norpampa` → teléfono del CTO) con `npx sst secret set SeedOverrides "$(cat scripts/seed/overrides.local.json)" --stage poc`, y `npm run seed:load -- --force --firm firm-delta`. Dueño: `devops`.
9. **Modo vivo**: PR que cambia `infra/channel-modes.ts` a `whatsapp: "live"` y marca P-01 como cerrado en esta tabla; CI verifica `channels:check-modes`; merge y deploy. Dueño: `devops` con aprobación del CTO.
10. **Prueba viva**: `qa` corre el escenario `SC-23` (plantilla al teléfono del CTO, botones, PDF por WhatsApp, estados) y repite los pasos vivos de FL-090 a FL-092; el CTO acepta los mensajes en su teléfono.

Riesgos que el CTO acepta: rechazo del display name (baja el límite o desconecta el número), recategorización de una plantilla a `MARKETING` (el adaptador lo detecta y la consola lo muestra), límite de conversaciones iniciadas por día sin verificación del negocio (alcanza para la demo), número deshabilitado sin aviso.

## 2. Oportunidad ACE (P-02)

1. En AWS Partner Central de Craftech, crear una oportunidad nueva para este proyecto con fecha de creación dentro del período de la hackathon y el código de campaña que indique el reglamento publicado en Devpost (confirmar ahí los requisitos vigentes antes de cargarla).
2. Tipo de proyecto: agente de coordinación para estudios de despachantes de aduana; servicios: Amazon Bedrock AgentCore, Amazon SES (el servicio CDS que se llama en runtime: `sesv2 SendEmail` y receipt rules), Amazon EventBridge, Amazon DynamoDB; AWS End User Messaging Social figura como "integrated, live pending WhatsApp Business Account" mientras P-01 siga abierto (nunca como servicio en uso).
3. Pasar el id de la oportunidad a `architect` para el README y el formulario de la submission.

Dueño: CTO. Verificación: id visible en Partner Central.

## 3. Video de 3 minutos (P-03)

1. Esperar el cierre de WP-42 ("100 % probada").
2. `devops` reinicia el mundo de demo de Estudio Delta ("Reiniciar demo": época nueva, memoria del agente vacía, reloj en pausa) justo antes de grabar.
3. Grabar en inglés con el guion de `docs/design-brief.md` §14 (consola, simulador de teléfono o teléfono real si P-01 está cerrado, buzón de demo, métricas, diagrama), incluido el segmento de 5 segundos "what is real / what is simulated"; el teléfono se muestra siempre con el rótulo "simulador" mientras P-01 siga abierto.
4. Publicar en YouTube o Vimeo como público o no listado y pasar el link a `architect` para el README y el formulario.

Dueño: CTO.

## 4. Marca pública (P-04)

Decisiones del CTO:

1. Confirmar el nombre **Legajo listo** para la submission (si cambia: subdominio, identidad SES y `copy/`; nada más lo nombra).
2. Display name de WhatsApp: "Craftech" (nombre legal, aprobación más simple) o "Legajo listo" (Meta exige una asociación pública entre la marca y la empresa, por ejemplo en el sitio de Craftech).
3. Confirmar el uso de "Powered by Craftech" en la landing, las plantillas y los emails.

Dueño: CTO. Bloquea el paso 1 de P-01.

## 5. Credenciales de las cuentas reservadas (P-05)

Las cuentas reservadas son del rol invitado (`GUEST`, ADR-0014); cualquiera puede además registrarse en `/signup`. Este es el único lugar del repo, junto con las notas de la submission del README, que cita el texto de las instrucciones del formulario, que sí nombra el concurso.

1. Esperar `SC-24`, `SC-25` y `SC-26` en verde, WP-41 cerrado y la aceptación A-01 hecha (`docs/test-plan.md` §5.1, P-07).
2. Contar las personas de la lista pública de evaluadores del concurso (NN; 15 si todavía no se publicó, nunca menos de 10, máximo 30 por los cupos reservados de ADR-0015 §4).
3. El operador crea `guest-01` a `guest-NN` con `npm run console:invite -- --stage poc --guest <nn>` (contraseña permanente generada, sin MFA; `docs/architecture.md` §10) y las pasa al CTO por un canal privado, nunca por el chat ni el repo. Si la lista crece después, se crean las cuentas que falten.
4. El CTO las carga en el campo privado de instrucciones de prueba del formulario, junto con `https://legajo.demo.craftech.io/login`, la opción de registrarse en `https://legajo.demo.craftech.io/signup` y la **regla de asignación**, en inglés: "Find your name in the Judges list on the hackathon page. Use account guest-NN, where NN is your position in that list sorted alphabetically by last name (01, 02, …). If your position is greater than the number of accounts, use NN = ((position − 1) mod number of accounts) + 1. You can also create your own account at /signup."
5. Después del período de evaluación, el operador deshabilita las cuentas reservadas (`cognito-idp admin-disable-user`); el alta pública sigue abierta.

Dueño: CTO. Verificación: `aws --profile craftech-demos cognito-idp list-users-in-group --user-pool-id <id> --group-name GUEST` (NN cuentas reservadas habilitadas).

## 6. Privacidad y leads (P-06)

El alta pública convierte a Craftech en responsable de una base de datos personales (ADR-0015 §6-§8). Decisiones y trámites del CTO:

1. Razón social, domicilio y CUIT de Craftech como responsable, para `/legal/privacy.html` (es/en).
2. Casilla `@craftech.io` para pedidos de acceso, rectificación, baja y borrado (aparece en la política de privacidad).
3. Casilla `@craftech.io` que recibe el aviso de cada lead: el operador la carga en el secreto `LeadNoticeTo` (hoy `janu@craftech.io`); nunca va al código.
4. Inscripción de la base de leads en el Registro Nacional de Bases de Datos de la AAIP (Ley 25.326), o confirmación de que la base de Craftech ya inscripta la cubre.
5. URL de contacto de "Hablemos" (`CRAFTECH_CONTACT_URL`, ADR-0016 §1): confirmar `https://craftech.io/contact/` (verificada el 2026-09-26, `docs/landing-spec.md` §9) o dar otra.
6. Contenido del aviso de lead cuando la persona **no** aceptó el contacto: ADR-0015 §6 incluye el email siempre; `docs/landing-spec.md` §8.10 propone mostrarlo solo si aceptó ("sin consentimiento de contacto: no contactar"). Recomendación: la segunda, porque el aviso llega a una casilla comercial y la finalidad declarada del contacto depende del consentimiento. Hasta que el CTO decida rige ADR-0015 §6; si elige la segunda, `architect` ajusta el ADR y el cambio es solo del cuerpo que arma `LeadNotice` (FL-115).

Dueño: CTO. Bloquea publicar el alta; no bloquea construirla. Verificación: la política publicada muestra los datos del punto 1 y 2, y un alta de prueba llega a la casilla del punto 3.

## 7. Ola de superficies públicas (P-07)

Lo que el CTO confirma o hace para desplegar el alta propia, la landing comercial y el rol invitado (ADR-0014 a ADR-0016). Nada de esto bloquea construir; los puntos 1 a 4 bloquean el primer deploy de la ola, los puntos 5 a 7 bloquean anunciar el alta o entregar credenciales. El alta pública no tiene lista de espera ni un paso de apertura (ADR-0015 §1.4): el stage se despliega por primera vez recién con las olas 3 a 6 construidas y en verde, y "Probar la demo" funciona desde ese deploy.

1. **Costo de la protección contra bots**: aceptar AWS WAF en CloudFront, de US$ 9,4 a 11 por mes al volumen esperado (web ACL, 4 reglas, pedidos y desafíos; ADR-0015 §3.3), con el desafío silencioso **sin SDK** (el SDK de integración exige Bot Control dirigido o ACFP, descartados por costo). **1.1** El precio por cada 1.000 respuestas de desafío no quedó confirmado en la página pública de precios (fuentes secundarias: de US$ 0,15 a US$ 1): se presupuesta al tope y el operador lo confirma con la calculadora de precios de AWS o `aws pricing get-products --service-code awswaf` antes del primer deploy, y lo anota acá con fecha. OAC para las Function URL no tiene costo. Alternativas descartadas con precio en el mismo ADR.
2. **Límites del alta y de los mundos**: aceptar o cambiar los números de ADR-0015 §3.2 y §4 (60 mundos públicos activos, TTL de 24 h sin actividad o 72 h de creado, cuotas por mundo, presupuesto global de 1.500 turnos y 1.500 emails por día entre todos los mundos públicos). El peor caso de costo diario sale de ese presupuesto y de la tarifa verificada de WP-41; el presupuesto mensual del proyecto sigue avisando al 50, 80 y 100 %. Un cambio de número es un cambio en `packages/shared/src/guest-limits.ts`, sin rediseño.
3. **Operador, antes del primer deploy de la ola** (`docs/architecture.md` §15 pasos 2 y 3): volver a aplicar el bootstrap (permisos de WAF y de OAC del rol de CI; la CSP no cambia); cargar los secretos `OriginVerifyKey` (aleatorio) y `LeadNoticeTo` (`janu@craftech.io` o la casilla que decida P-06 punto 3); crear el secreto de GitHub `GUEST_TEST_PASSWORD` y borrar el de la cuenta de prueba anterior (nombre en ADR-0014 §8); si en el pool de `poc` quedaron cuentas reservadas con el prefijo anterior, borrarlas (`cognito-idp admin-delete-user`) y crear `guest-test` con `console:invite -- --guest-test`. Nadie pega valores en un chat.
4. **Supuestos a verificar en el primer deploy**: (a) que un error del trigger `CustomMessage` hace que Cognito no envíe el email (ADR-0015 §3.2), lo verifica `SC-26/11`; (b) que el intersticial del desafío de WAF resuelve en `/signup` bajo la response headers policy de la consola (ADR-0015 §3.3), lo verifica `SC-26/1`: si no, `devops` agrega un comportamiento de caché para `/signup` con su propia policy y lo registra acá. Si (a) falla, el CTO aprueba el plan B: trigger `CustomEmailSender` con una clave KMS propia (≈ US$ 1 por mes), `kms:*` cercado por tag en el rol de CI y la dependencia `@aws-crypto/client-node`.
5. **Avisos de lead de las pruebas automáticas**: `SC-26` crea y borra una cuenta real por corrida completa, y su aviso de lead llega a `LeadNoticeTo` (≈ 3 avisos por entrega, con buzones `qa-signup-…@sim.legajo.demo.craftech.io`). Confirmar que se aceptan, o pedir que las altas `qa-signup-*` no avisen (entonces el camino del aviso en `poc` queda probado solo por A-01).
6. **Aceptación A-01** (`docs/test-plan.md` §5.1): el CTO se registra en `poc` desde el teléfono con su propia casilla `@craftech.io` y UTM `acceptance`, recibe el código y el aviso, entra a su mundo, y el operador le muestra que `leads:export` tiene esa fila. El lead queda como alta de referencia hasta que el CTO pida borrarlo.
7. **Excepción del `QaDriver` sobre `Leads`**: aprobar que el `QaDriver` lea, y borre al final, solo los leads y cuentas de sus propios buzones `qa-signup-<runId>-*` (cerco en código, con revisión de `security`; `docs/test-plan.md` §4.1). Sin esto, `SC-26` no puede afirmar el lead ni limpiar lo que crea, y el alta en `poc` queda probada solo por A-01.
8. **Disyuntor de reputación de SES** (ADR-0015 §3.2): aceptar el umbral (10 rebotes más quejas en 24 h, o más del 3 % con al menos 100 envíos) que corta las altas y los emails de cuenta de la demo hasta que el operador lo cierre con `npm run signup:breaker -- --close`. Protege la reputación de SES de toda la cuenta Demos, que comparten las otras demos.

Dueño: CTO; el operador ejecuta el punto 3 y acompaña el 6. Verificación: puntos 1 (con el precio de 1.1), 2, 5, 7 y 8 respondidos en este documento con fecha; `SC-26` en verde (puntos 3 y 4); evidencia de A-01 en el PR de la ola (punto 6).
