# Pendientes fuera de nuestras manos

Solo lo que depende de alguien fuera del equipo de agentes (el CTO, Meta, AWS Partner Central). Todo lo demás está en `docs/build-plan.md`. Cada entrada se cierra con fecha y quién la cerró, escrito en la columna "Estado" como `Cerrado el AAAA-MM-DD por <quién>`: `npm run channels:check-modes` lee esa columna y no deja pasar `whatsapp: "live"` mientras P-01 no diga "Cerrado".

| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Conectar WhatsApp: cuenta de WhatsApp Business, número y plantillas aprobadas | CTO (Meta); `devops` ejecuta los scripts; `qa` prueba en vivo | Abierto | §1 |
| P-02 | Oportunidad ACE de la submission | CTO | Abierto | §2 |
| P-03 | Video de 3 minutos | CTO | Abierto | §3 |
| P-04 | Decisión de marca pública | CTO | Abierto | §4 |
| P-05 | Credenciales de jurado en las instrucciones privadas de Devpost | CTO con el operador | Abierto | §5 |

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

## 5. Credenciales de jurado (P-05)

1. Esperar `SC-24` y `SC-25` en verde y WP-41 cerrado (`docs/build-plan.md`).
2. Contar los jurados de la lista pública de la página de la hackathon en Devpost (NN; 15 si todavía no se publicó, nunca menos de 10).
3. El operador crea `judge-01` a `judge-NN` con `npm run console:invite -- --stage poc --judge <nn>` (contraseña permanente generada, sin MFA; `docs/architecture.md` §10) y las pasa al CTO por un canal privado, nunca por el chat ni el repo. Si la lista crece después, se crean las cuentas que falten.
4. El CTO las carga en el campo privado de instrucciones de prueba de la submission en Devpost, junto con el link `https://legajo.demo.craftech.io/login` y la **regla de asignación**, en inglés: "Find your name in the Judges list on the hackathon page. Use account judge-NN, where NN is your position in that list sorted alphabetically by last name (01, 02, …). If your position is greater than the number of accounts, use NN = ((position − 1) mod number of accounts) + 1. If the console warns that another session used your world, switch to another judge account instead of resetting." El README solo dice que las credenciales y la regla están en las instrucciones de prueba (`docs/design-brief.md` §7.1).
5. Después de la evaluación, el operador deshabilita las cuentas (`cognito-idp admin-disable-user`).

Dueño: CTO. Verificación: `aws --profile craftech-demos cognito-idp list-users-in-group --user-pool-id <id> --group-name JUDGE` (NN cuentas habilitadas durante la evaluación).
