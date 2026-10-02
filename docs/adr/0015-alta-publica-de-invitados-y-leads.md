---
status: accepted
---

# Alta pública de invitados con email verificado, captación de leads y límites anti abuso

Decisión del CTO del 2026-09-26: cualquiera puede probar la demo **solo**, sin pedir credenciales, y cada alta es también un **lead** para Craftech. La cuenta de AWS es compartida y cada turno del agente cuesta: el alta tiene que resistir bots y no puede convertirse en una forma de mandar códigos de verificación a terceros (reputación de SES compartida por todas las demos de la cuenta). Decidimos: el navegador **nunca** llama a `SignUp` de Cognito; lo hace una Lambda propia (`SignupDispatch`) con un **ticket de alta** firmado que el trigger `PreSignUp` exige, **fuera del camino de respuesta** del BFF para que ninguna rama se distinga por tiempo; los emails de cuenta pasan por un trigger `CustomMessage` que aplica cuotas por destinatario, el estado de rebote y un disyuntor de reputación; cada invitado público recibe un **mundo de invitado** arrendado de un cupo fijo (un arrendamiento por cuenta), con TTL y cuotas de uso por mundo en reloj real; los leads viven en una tabla propia; las Function URL del BFF y de la página pública solo aceptan pedidos firmados por CloudFront (OAC); la protección contra bots es AWS WAF en CloudFront con un desafío silencioso sin SDK, más honeypot y tiempo mínimo. El alta tiene un solo flujo: los deploys de `poc` siguen siendo por ola, pero la URL no se comparte hasta que todo el producto (olas 3 a 6) está desplegado y probado; un lead se escribe solo con el email verificado, y si el cupo de mundos está lleno el invitado entra igual y ve el estado `CAPACITY` (§1.4). El estándar de producto es la skill `poc-landing` del workspace (sección "Captación de leads"); el rol y el guard de textos, ADR-0014.

## 1. Flujo de alta (todo lo que llama a Cognito para crear o confirmar pasa por el BFF)


1. `/signup` se abre siempre con una **navegación completa** (los CTA son enlaces `<a href>` que el router del SPA no intercepta, §3.3). WAF desafía ese `GET` y el navegador queda con la cookie `aws-waf-token`. La vista pide `signup.form` (devuelve `formToken`, con `formShownAt` firmado) y, al enviar, llama a `signup.start` con el formulario.
2. `signup.start` pasa por WAF (desafío y rate limit), OAC y el encabezado de origen verificado (§3.1), exige una ruta sin lote (§3.1), revisa honeypot, tiempo, rate limits por IP, cupo global y disyuntor (§3.2), guarda `Leads/SIGNUP#<signupId>` e invoca **asíncrona** a `SignupDispatch {kind: "START", signupId}`. Responde **siempre** igual: `{signupId, status: "CODE_SENT", resendAfterSec: 60}`, sin haber llamado a Cognito.
3. `SignupDispatch` (§1.1) valida el dominio, consulta las cuotas por email y el estado de rebote, clasifica el email (§1.2) y hace **una** de estas cosas: email nuevo → `SignUp(username, email, password, locale, ValidationData {ticket, signupId, exp})` (`AuthPreSignUp` verifica el ticket y `AuthCustomMessage` arma el email del código); cuenta pública elegible → `ForgotPassword(email, ClientMetadata {intent: "signup-existing", lang})`; `UNCONFIRMED` sin grupos → `AdminDeleteUser` + `SignUp`; cualquier otro caso → nada. Anota la rama en `SIGNUP#.branch`.
4. `signup.confirm {signupId, code, password}` lee la rama: `NEW` → `ConfirmSignUp`; `EXISTING_GUEST` → `ConfirmForgotPassword` con la contraseña del formulario; `SUPPRESSED`, `INELIGIBLE` o rama todavía sin anotar → `CODE_INVALID` sin llamar a Cognito. **Inmediatamente después** de un `ConfirmSignUp` o `ConfirmForgotPassword` exitoso escribe `SIGNUP#.verifiedAt` (hora real), la única prueba de que el dueño del buzón usó el código. Después, `finalizeSignup` (lead, grupo `GUEST`, aviso asíncrono) y `{status: "CONFIRMED"}`; la web lleva a `/login` con el email precargado. Toda respuesta que no es `CONFIRMED` sale a los **1.500 ms** del inicio del pedido (plazo fijo, §1.1).

- **Ticket de alta**: `HMAC-SHA256(K_signup-ticket, "<username>|<emailHash>|<signupId>|<exp>")` con la subclave `signup-ticket` derivada de `SessionTokenKey` (HKDF, `lib/crypto.ts`), vigencia **120 s** desde que `SignupDispatch` lo arma, en `ValidationData.ticket` junto con `signupId` y `exp`. `AuthPreSignUp` recalcula el HMAC con comparación de tiempo constante y rechaza (`PreSignUp_SignUp` sin ticket válido o vencido) antes de que exista el usuario y antes de cualquier email; acepta `PreSignUp_AdminCreateUser` sin ticket (solo el operador tiene credenciales de administrador) y rechaza `PreSignUp_ExternalProvider`. No lee tablas: es HMAC puro y responde en milisegundos. Así un `SignUp` directo contra el cliente público de Cognito (que la API permite desde cualquier lado) no crea usuarios ni manda códigos.
- **Nombre de usuario**: `usr-<ulid en minúsculas>`, generado por el BFF en `signup.start` y guardado en `SIGNUP#.username` (el email es alias y Cognito no acepta un username con forma de email). El invitado ingresa siempre con su **email**.
- **La contraseña pasa por el BFF** en `signup.start` y `signup.confirm` (TLS, zod, nunca logueada: `log.ts` redacta toda clave `password`; test que lo afirma). `signup.start` la valida con la política del pool (`PASSWORD_POLICY` de `packages/shared`, fuente única que usan también `infra/auth.ts` y el formulario) y la pasa a `SignupDispatch` **cifrada** dentro de `SIGNUP#.passwordSealed` (AES-256-GCM con la subclave `signup-seal` de `SessionTokenKey`, `lib/crypto.ts`); `SignupDispatch` la descifra, llama a Cognito y **borra el atributo** en el mismo paso (`REMOVE passwordSealed`), también en toda rama que no la usa. Nunca vive más que el TTL del `SIGNUP#` (24 h) y nunca en claro fuera de la memoria de las dos Lambdas. Es el costo de sacar al navegador de `SignUp`, de no revelar si un email tiene cuenta y de no responder según el tiempo de Cognito.
- **`finalizeSignup(signupId)`** (idempotente, en `signup.confirm` y en `GUEST_SWEEP`): **exige** la prueba de verificación de §1.3; escribe el lead desde `SIGNUP#` (condicional; es el único lugar donde nace un lead, §1.4), agrega el usuario al grupo `GUEST` solo si hoy no tiene **ningún** grupo (§1.2), invoca asíncrono `LeadNotice` y borra `SIGNUP#`.
- **Login, recuperación y logout**: SRP desde el navegador con el email (lo que ya existe); "Olvidé mi contraseña" con `ForgotPassword` / `ConfirmForgotPassword` desde el navegador (`preventUserExistenceErrors` activo), bajo las cuotas del `CustomMessage`; logout con `RevokeToken`. El access token de todo `GUEST` (público o reservado) pierde el scope `aws.cognito.signin.user.admin` (ADR-0014): un invitado cambia la contraseña solo por recuperación. Sin MFA para `GUEST`.
- **Roles internos** (`BROKER`, `ANALYST`): siguen siendo solo por invitación del operador.

### 1.1 Ninguna rama se distingue por tiempo ni por respuesta

- `signup.start` y `signup.resend` hacen el **mismo trabajo** en toda rama: validación, contadores por IP y globales, lectura del disyuntor, una escritura de `SIGNUP#` (o su actualización) y una invocación asíncrona (`InvocationType: Event`) de `SignupDispatch`. Nunca consultan a Cognito ni el estado del email: eso pasa en `SignupDispatch`, después de responder. Los rechazos por honeypot, tiempo, dominio, cuota por email o estado de rebote se deciden en `SignupDispatch` (rama `SUPPRESSED`), así que tampoco cambian la respuesta ni su duración.
- `SignupDispatch` es idempotente por `SIGNUP#.dispatchSeq` (cada `START` o `RESEND` lo incrementa y el evento lleva el valor esperado; un evento repetido o viejo pierde la condición y no hace nada) y corre sin reintentos asíncronos de Lambda (`MaximumRetryAttempts 0`): un fallo deja `SIGNUP#.branch = FAILED`, suma `SignupDispatchFailed` y el visitante puede pedir "Reenviar".
- `signup.resend {signupId}` actualiza `SIGNUP#` (60 s entre reenvíos, 3 por alta) e invoca `SignupDispatch {kind: "RESEND"}`, que según la rama llama a `ResendConfirmationCode`, a `ForgotPassword` o a nada.
- `signup.confirm` responde `CODE_INVALID`, `EXPIRED` o `RATE_LIMITED` a los **1.500 ms** del inicio del pedido en toda rama (con o sin llamada a Cognito); solo `CONFIRMED` sale antes. El tope de 5 intentos por alta y 30 por hora por IP acota el costo de esa espera.
- Test `U` (`routers/signup-timing.test.ts`, con dobles de Cognito que tardan distinto por rama): la duración de `signup.start` y `signup.resend` no depende de la rama (p50 y p95 de 200 pedidos por rama dentro de ± 15 ms entre las cuatro: `NEW`, `EXISTING_GUEST`, `INELIGIBLE`, `SUPPRESSED`), y ninguna de las dos llama a Cognito.

### 1.2 Qué cuenta existente puede seguir el camino de "ya tenés una cuenta"

`SignupDispatch` busca el email en el pool (`ListUsers` con filtro `email = "<normalizado>"`), y para el usuario encontrado lee estado y grupos (`AdminGetUser`, `AdminListGroupsForUser`):

| Usuario encontrado | Rama | Qué hace `SignupDispatch` |
|---|---|---|
| Ninguno | `NEW` | `SignUp` con el ticket |
| `UNCONFIRMED`, **sin grupos** | `NEW` | `AdminDeleteUser` (cercado en código: solo `UNCONFIRMED` sin grupos) + `SignUp` con la contraseña nueva |
| `CONFIRMED`, grupos exactamente `["GUEST"]` y sin atributo `custom:firmId` (invitado **público**) | `EXISTING_GUEST` | `ForgotPassword` con `intent: "signup-existing"`; `CustomMessage` manda "Ya tenés una cuenta en Legajo listo; si fuiste vos, usá este código para entrar con la contraseña que acabás de elegir" |
| Cualquier otro: personal interno (`BROKER`, `ANALYST`), invitados reservados y `guest-test` (tienen `custom:firmId`), usuarios con más de un grupo, `FORCE_CHANGE_PASSWORD`, `RESET_REQUIRED`, deshabilitados | `INELIGIBLE` | **Nada**: ninguna llamada a Cognito, ningún email, ningún grupo, ningún lead. Métrica `SignupRejected {reason: INELIGIBLE}` |

La pantalla del código dice siempre "Si ya tenés una cuenta, ingresá" con el link a `/login`, así que quien cae en `INELIGIBLE` sabe qué hacer sin que la respuesta lo delate. **Cerco de grupos** (código y test): `AdminAddUserToGroup` solo con el grupo literal `GUEST` y solo sobre un usuario que en ese momento **no tiene ningún grupo** (`AdminListGroupsForUser` justo antes); un usuario `EXISTING_GUEST` ya lo tiene y no se toca. Tests en `signup/dispatch.test.ts` y `signup/finalize.test.ts`: un email de `BROKER`, uno de `ANALYST`, uno reservado y uno en `FORCE_CHANGE_PASSWORD` terminan en `INELIGIBLE`, sin llamadas a Cognito más allá de las lecturas, sin cambio de grupos y sin lead.

### 1.3 Prueba de verificación antes de finalizar

`finalizeSignup` corre solo si se cumple **una** de estas condiciones, y ninguna otra:

1. `SIGNUP#.verifiedAt` existe (lo escribió `signup.confirm` tras un `ConfirmSignUp` o `ConfirmForgotPassword` exitoso), o
2. `branch = NEW` y el usuario **del propio** `SIGNUP#.username` (`usr-<ulid>`) está `CONFIRMED` y su `UserCreateDate` es posterior a `SIGNUP#.startedAt` (el alta la confirmó alguien con el código de ese buzón, por ejemplo con un reintento o llamando a Cognito directo).

Un `SIGNUP#` con `branch = EXISTING_GUEST` sin `verifiedAt` **nunca** se finaliza: que la cuenta exista y esté `CONFIRMED` no prueba nada sobre quien llenó el formulario. Si la escritura de `verifiedAt` falla después de un `ConfirmForgotPassword` exitoso, la cuenta queda como estaba (ya era `GUEST`, con la contraseña nueva) y ese formulario no actualiza el lead: se declara. Tests en `signup/finalize.test.ts` y `janitor/guest-sweep.test.ts`: un `SIGNUP#` `EXISTING_GUEST` sin código deja el lead, sus consentimientos y los grupos sin cambios y no manda aviso.

### 1.4 Un solo flujo de alta, lead verificado y demo completa en el primer ingreso

**Sin lista de espera.** El alta tiene un único comportamiento, el de §1: no hay un valor de configuración que lo cambie, ni una respuesta de "pedido de acceso", ni un CTA alternativo, ni una landing que cambie su `robots` según el estado del alta. Los deploys de `poc` siguen siendo por ola (regla de aceptación del plan), pero la URL no se comparte ni se anuncia hasta que todo el producto (olas 3 a 6) está desplegado y probado; si alguien entra antes, la alta verificada crea la cuenta y el lead y el primer ingreso muestra el estado honesto (`CAPACITY` o mundo no disponible). Una lista de espera sin verificar guardaría el consentimiento de contacto de direcciones que nadie probó que son de quien llenó el formulario (un consentimiento que no vale bajo la Ley 25.326) y cambiaría el CTA que eligió el CTO.

**El lead nace verificado.** Un lead lo escribe **solo** `finalizeSignup` (§1), y solo con la prueba de verificación de §1.3; ni `signup.start` ni `SignupDispatch` escriben un item `LEAD`. Todo lead es de un email verificado con una cuenta `GUEST`, así que el lead no tiene campo de estado ni `emailVerified`.

**Demo completa.** `signup.start` sigue respondiendo `RATE_LIMITED` (topes por IP) y `CAPACITY` (cupo global de altas nuevas o disyuntor abierto, §3.2), respuestas que no dicen nada de un email. El cupo de mundos públicos (§4) no frena el alta ni el lead: con los 60 cupos arrendados, la cuenta y el lead verificado existen igual (y el aviso a Craftech sale al confirmar), y en el primer ingreso `account.ensureWorld` y `account.world` responden `{state: "CAPACITY"}` sin crear mundo ni arrendar cupo (`GUESTWORLD#<sub>` queda en `FAILED {reason: CAPACITY}`). `/welcome` dice "La demo está completa en este momento; probá de nuevo más tarde" con "Probar de nuevo" y "Hablemos" (`CRAFTECH_CONTACT_URL`, ADR-0016 §1). El ingreso siguiente (o "Probar de nuevo") vuelve a llamar a `ensureWorld` y crea el mundo si hay un cupo libre (FL-132).

Tests: `signup/finalize.test.ts` (el lead se escribe solo con la prueba de §1.3), `signup/dispatch.test.ts` (ninguna rama escribe `LEAD`), `routers/guest-world.test.ts` (con los 60 cupos arrendados, `ensureWorld` responde `CAPACITY` sin arrendar cupo ni invocar `WorldJanitor`, y el llamado siguiente con un cupo libre crea el mundo).

## 2. Dónde vive cada dato entre el alta y la confirmación

| Dato | Dónde | Vida |
|---|---|---|
| Email, nombre, empresa y cargo opcionales (≤ 80 caracteres cada uno, texto plano), consentimientos con fecha y versión, idioma, UTM, referrer, `username`, `emailHash`, `startedAt`, `branch`, `verifiedAt`, contadores de reenvío y de intentos | `Leads/SIGNUP#<signupId>` (`signupId` = 26 caracteres aleatorios) | TTL de DynamoDB **24 h** |
| Contraseña | Cifrada en `SIGNUP#.passwordSealed` desde `signup.start` hasta que `SignupDispatch` la usa (segundos); nunca en claro | Se borra en el primer paso de `SignupDispatch` |
| Idioma de los emails de cuenta | Atributo estándar `locale` del usuario de Cognito (`es` \| `en`) y `ClientMetadata.lang` | Lo que dure la cuenta |
| Estado de rebote o queja de un destinatario | `Runtime/MAILSTATUS#<emailHash>` (§3.2), exista o no un lead | 24 meses desde el último evento |
| Lead (siempre de un email verificado, §1.4) | `Leads/EMAIL#<emailHash>` + `LEAD`, escrito por `finalizeSignup` | §6 |

- **Consentimientos**: dos casillas separadas, **sin tildar**: `terms` ("Acepto los términos y la política de privacidad", obligatoria para crear la cuenta) y `contact` ("Acepto que Craftech me contacte por esta solución", opcional). Se guarda `{accepted, at (hora real ISO), version, lang}` de cada uno; `version` sale de `packages/shared/src/legal-versions.ts` (`{terms, privacy, contact}`, formato `AAAA-MM-DD`), y el texto exacto de cada versión vive en `copy/` de la web. Cambiar un texto obliga a subir su versión (test).
- **UTM y referrer**: la landing lee `utm_source|medium|campaign|term|content` de su URL (cada uno ≤ 100 caracteres de `[A-Za-z0-9._~ -]`, el resto se descarta) y el `document.referrer` reducido a esquema + host (≤ 200; se descarta si es nuestro propio origen), los guarda en `sessionStorage` y el formulario los manda en `signup.start`. Nada de cookies ni scripts de analítica de terceros (la cookie `aws-waf-token` es técnica, de WAF, y la política la declara).

## 3. Protección del alta

### 3.1 Capas

| Capa | Qué frena | Costo |
|---|---|---|
| **AWS WAF** en la distribución de CloudFront (web ACL `aws-cds-hackathon-poc-legajo-poc-edge`, scope `CLOUDFRONT`) | Volumen por IP y bots sin navegador | Ver §3.3 |
| **OAC para Lambda** (`Router` con `protection: "oac"`): las Function URL de `Bff` y `PublicWeb` pasan a `AWS_IAM` y solo CloudFront las invoca, firmando cada pedido | Llamar directo a las Function URL salteando WAF, la IP real y la concurrencia reservada: un pedido sin firma lo rechaza Lambda **antes** de invocar la función | $0 |
| **Origen verificado** (`X-Origin-Verify`, secreto `OriginVerifyKey`, en `/api/*` y `/u/*`): el handler de `Bff` y el de `PublicWeb` lo comparan en tiempo constante como **primer paso de toda ruta**, antes de verificar el JWT o de rutear; sin el encabezado correcto, 403 | Defensa en profundidad si OAC se desactivara por error; hace confiable `CloudFront-Viewer-Address` | $0 |
| **Sin lotes en `signup.*`**: el handler de `Bff` rechaza con 400, antes de rutear, todo pedido cuya ruta nombre más de un procedimiento o lleve el parámetro `batch` y en el que alguno empiece con `signup.`; `signupProcedure` exige además que la ruta sea exactamente `/api/signup.<nombre>` sin `batch` | Esconder un `signup.*` detrás de otro procedimiento en un lote para esquivar las reglas de WAF | $0 |
| **Ticket de alta** + `PreSignUp` (§1) | `SignUp` directo contra Cognito | $0 |
| **Honeypot y tiempo**: campo oculto `website` vacío y entre 3 s y 2 h desde que se mostró el formulario (`formShownAt` firmado por el BFF en `signup.form`) | Bots simples | $0 |
| **Validación del dominio** (§3.2) | Códigos a buzones que no pueden existir | $0 |
| **Rate limits y cupos** en DynamoDB (§3.2) | Abuso distribuido, bombardeo de terceros | Centavos |
| **Cuotas de emails de cuenta, estado de rebote y disyuntor** en `CustomMessage` (§3.2) | `ResendConfirmationCode` y `ForgotPassword` llamados directo a Cognito; daño a la reputación de SES de la cuenta | $0 |

**Por qué OAC y además `X-Origin-Verify`**: OAC es la barrera (Lambda rechaza el pedido sin firma antes de ejecutar nada, así que una inundación directa no consume la concurrencia reservada de `Bff`); el encabezado queda como segundo control barato que no depende de la configuración de la distribución. Consecuencias de OAC que el diseño asume: (a) CloudFront firma con SigV4 y **reemplaza** el encabezado `Authorization` del visitante, así que la consola manda el id token en `X-Legajo-Auth: Bearer <idToken>` y el BFF lo lee de ahí; (b) todo `POST` del navegador a `/api/*` y `/u/*` lleva `x-amz-content-sha256` con el SHA-256 hexadecimal del cuerpo (Lambda no acepta cuerpo sin firmar): lo calcula el `fetch` del cliente tRPC y el script de la página de carga con `crypto.subtle.digest`; (c) `devops` verifica en el `.d.ts` de SST pinneado que la política de pedido al origen reenvía `x-amz-content-sha256`, `X-Legajo-Auth` y `CloudFront-Viewer-Address`. El `QaDriver` ejecuta el `appRouter` en proceso y no pasa por la Function URL.

**Cliente web**: `signup.*` va por un `httpLink` sin lotes (`splitLink` por prefijo de ruta) con `fetch` común; el resto de la consola sigue con `httpBatchLink`. Una respuesta `202` con `x-amzn-waf-action: challenge` (legible: mismo origen) significa token de WAF vencido: la vista guarda en `sessionStorage` los campos no secretos, navega de nuevo (navegación completa) a `/signup?retry=1`, WAF vuelve a desafiar y la vista restaura los campos y pide solo la contraseña.

Un rechazo por honeypot, tiempo, dominio, cuota por email o estado de rebote devuelve la misma respuesta `CODE_SENT` sin enviar nada ni escribir un lead (el bot no aprende); los rechazos por IP o cupo global devuelven `RATE_LIMITED {retryAfterSec}` o `CAPACITY`, que no dicen nada de un email. Métrica `LegajoAgent/SignupRejected` por motivo.

### 3.2 Números

Contadores `Runtime/RL#<alcance>#<hash>#<ventana>` (`UpdateItem ADD` con condición de tope, `expiresAt` = fin de la ventana + 1 h); IP y dominio se hashean con la subclave `rate` (nunca la IP en claro).

**IP del visitante** (regla normativa, `lib/viewer-ip.ts` con test `U` propio): se toma de `CloudFront-Viewer-Address`, solo después de validar `X-Origin-Verify`. El valor es `ip:puerto`: IPv4 `198.51.100.10:46532`; IPv6 `2001:db8::1:46532` o `[2001:db8::1]:46532`. Se separa el host del puerto por el **último** `:` (o por los corchetes si los hay), se valida el host con `net.isIP` y un encabezado ausente, vacío o inválido rechaza el pedido (`signup.*` → 400 `INVALID`, métrica `SignupRejected {reason: NO_VIEWER_IP}`). La clave se agrega **antes** de hashear: IPv4 por `/32`; IPv4 mapeada en IPv6 (`::ffff:a.b.c.d`) como IPv4; IPv6 por su **`/64`** (los primeros 64 bits del valor expandido). La clave es `HMAC(K_rate, "v4|<a.b.c.d>")` o `HMAC(K_rate, "v6|<prefijo /64>")`. Casos del test: los dos formatos de IPv6, puerto distinto con la misma IP → misma clave, dos direcciones del mismo `/64` → misma clave, `/64` distintos → claves distintas, encabezado ausente o basura → rechazo. Las reglas de rate de WAF agregan por **dirección individual** (también en IPv6): la agregación por `/64` del BFF es la que manda.

**Dominio del email** (lo valida `SignupDispatch`, sin cambiar la respuesta): se suprime (rama `SUPPRESSED`) todo email con TLD o dominio reservado (`isReservedDomain` de `@legajo/shared`: RFC 2606/6761 y los de uso especial `local`, `onion`, `home.arpa`, `internal`), con un dominio propio (`legajo.demo.craftech.io` y sus subdominios, `simulator.amazonses.com`), salvo el buzón cercado `qa-signup-<runId>-<key>@sim.legajo.demo.craftech.io` del `QaDriver`, o con un dominio **sin MX o con MX nulo** (RFC 7505, `.` como destino). La consulta es `dns.promises.resolveMx` con 1,5 s de tiempo máximo; `ENOTFOUND` y `ENODATA` suprimen; solo un error del resolver (`ETIMEOUT`, `ESERVFAIL`, `ECONNREFUSED`) deja pasar (falla abierta, métrica `SignupMxUnknown`).

**Estado de rebote por destinatario**: `Runtime/MAILSTATUS#<emailHash>` = `{status: BOUNCED | COMPLAINED, at, count}` (`emailHash` con la subclave `lead-email`, la misma clave que `Leads/EMAIL#`), exista o no un lead. Lo escribe `ChannelEvents` con cada rebote permanente o queja del configuration set `…-email-poc` (los emails de cuenta y el aviso de lead salen por él); lo leen `SignupDispatch` (suprime) y `AuthCustomMessage` (corta). Así el rebote de un alta que nunca se confirmó también queda registrado.

**Disyuntor de reputación**: `ChannelEvents` suma cada rebote permanente o queja a `Runtime/RL#MAILBAD#<hora>`; `AuthCustomMessage` suma cada email de cuenta enviado a `RL#MAIL#TOTAL#<día>`. Cuando en las últimas 24 h (24 ventanas horarias) los rebotes más las quejas llegan a **10**, o superan el **3 %** con al menos 100 emails enviados, `ChannelEvents` escribe `Runtime/MAILBREAKER` = `{state: OPEN, openedAt, reason}` y emite `AccountMailBreakerOpen` (alarma). Con el disyuntor abierto, `signup.start` y `signup.resend` responden `CAPACITY` y `AuthCustomMessage` corta todo tipo de email salvo `CustomMessage_AdminCreateUser` (invitaciones del operador). Lo cierra solo el operador: `npm run signup:breaker -- --close` (después de revisar la causa; imprime solo el estado). Números en `packages/shared/src/guest-limits.ts`.

| Alcance | Tope | Al superarlo |
|---|---|---|
| WAF, URI que contiene `signup.` (decodificada y en minúsculas) por IP | 20 pedidos por 5 min | 403 de WAF |
| WAF, `/api/*` por IP | 1.500 pedidos por 5 min | 403 de WAF |
| `signup.start` por IP (`/32` o `/64`) | 5 por hora y 20 por día | `RATE_LIMITED` |
| `signup.start` por email | 3 por 24 h | `CODE_SENT` sin enviar (lo decide `SignupDispatch`) |
| Altas por dominio de email | 30 por hora | Ídem |
| Altas nuevas en total | 100 por hora y 300 por día | `CAPACITY` |
| `signup.resend` | 60 s entre reenvíos y 3 por `signupId` | `RATE_LIMITED` |
| `signup.confirm` | 5 códigos errados por `signupId` (después hay que empezar de nuevo) y 30 por hora por IP | `CODE_INVALID` / `RATE_LIMITED` |
| Emails de cuenta por destinatario (todos los tipos, en `CustomMessage`) | 5 por 24 h | El trigger falla y Cognito no envía |
| Emails de cuenta por dominio | 60 por hora | Ídem |
| Emails de cuenta en total | 400 por día | Ídem |
| Destinatario con `MAILSTATUS` `BOUNCED` o `COMPLAINED` | 0 | Ídem |
| Disyuntor abierto | 0 (salvo invitaciones del operador) | Ídem; `signup.*` responde `CAPACITY` |

`SignupDispatch` consulta las mismas cuotas antes de llamar a `SignUp`, así que `CustomMessage` solo tiene que cortar en `CustomMessage_ResendCode`, `_ForgotPassword`, `_UpdateUserAttribute` y `_VerifyUserAttribute` (en `_SignUp` cuenta, y corta solo por `MAILSTATUS` o disyuntor). **Supuesto a verificar en el primer deploy** (paso de escenario de la ola): un error del trigger `CustomMessage` hace fallar la llamada con `UserLambdaValidationException` y Cognito no envía el email. Si no se cumpliera, el plan B es el trigger `CustomEmailSender` con una clave KMS propia (US$ 1 por mes, más `kms:*` cercado por tag en el rol de CI y la dependencia `@aws-crypto/client-node`).

Riesgo residual declarado: con la cuota por destinatario agotada, `ForgotPassword` llamado directo a Cognito devuelve un error distinto del de un email sin cuenta (Cognito ya tiene la misma fuga con su propio límite de intentos).

### 3.3 Protección contra bots: opciones con precio (us-east-1, 2026-09-26)

| Opción | Precio | Qué cubre | Veredicto |
|---|---|---|---|
| **WAF en CloudFront**: web ACL + 4 reglas (lista de reputación de IP administrada por AWS, rate de `signup.`, rate de `/api/*`, **Challenge** silencioso en el documento `/signup` y en los `signup.*`) | US$ 5/mes la web ACL + US$ 1/mes por regla + US$ 0,60 por millón de pedidos + el precio por cada 1.000 respuestas de desafío. Ese último precio **no quedó confirmado** en la página pública de precios (fuentes secundarias dan de US$ 0,15 a US$ 1 cada 1.000): se presupuesta al tope, US$ 1, y P-07.1 lo confirma. Al volumen esperado (< 100.000 pedidos y < 2.000 desafíos por mes): **US$ 9,4 a 11/mes** (≈ US$ 0,31 a 0,37/día) | Bots sin navegador real, volumen por IP, IPs conocidas por abuso, antes de que el pedido llegue a la Lambda | **Elegida** |
| Cognito threat protection | Exige el plan Plus: US$ 0,02 por MAU sin capa gratuita (hoy Essentials: US$ 0,015 por MAU con 10.000 MAU gratis) | Riesgo de login y credenciales comprometidas; no protege el BFF ni resuelve el bombardeo de códigos | Rechazada: más costo por usuario, menos control |
| WAF sobre el user pool de Cognito | Otra web ACL: ≈ US$ 7–9/mes | `SignUp` directo | Rechazada: el ticket ya lo deja sin efecto, gratis |
| WAF Bot Control (nivel común o dirigido) o Account Creation Fraud Prevention (ACFP) | Bot Control: US$ 10/mes por web ACL + US$ 1 por millón (común) o US$ 10 por millón (dirigido); ACFP: US$ 10/mes + desde US$ 1.000 por millón | Clasificación de bots; son los únicos que habilitan la URL de integración del SDK de WAF | Rechazada: desproporcionado para el tráfico de una demo; el desafío sin SDK alcanza |
| CAPTCHA interactivo | US$ 0,40 cada 1.000 intentos | — | Prohibido por el estándar (sin rompecabezas) |
| Honeypot + tiempo mínimo | US$ 0 | Bots simples | Se suma a WAF |

**Challenge silencioso sin SDK**: la URL de integración del SDK de JavaScript de WAF (`challenge.js`, `AwsWafIntegration.fetch`) solo existe en web ACL que usan ATP, ACFP o Bot Control dirigido, y ninguno entra en el presupuesto. El mecanismo elegido usa solo la acción Challenge: una **única regla** (prioridad después de la reputación de IP y de los rate) con acción Challenge y enunciado `OR` de (a) `GET` cuya ruta es exactamente `/signup` y (b) ruta que **contiene** `signup.` con las transformaciones `URL_DECODE` y `LOWERCASE`. El `GET` del documento (el navegador pide `text/html`) recibe el intersticial de WAF, que resuelve el desafío sin intervención, deja la cookie `aws-waf-token` del dominio y recarga la página; los `POST` de `signup.*` desde esa página llevan la cookie (mismo origen) y la regla los deja pasar. Un `POST` sin token válido recibe `202` con `x-amzn-waf-action: challenge` y sin intersticial (no pide HTML): el cliente lo maneja como dice §3.1. Por eso **todo enlace a `/signup` es una navegación completa** (`<a href>` sin intercepción del router, también desde `/login` y desde el recorrido), y `/signup` abierto directo también funciona. **Inmunidad del token**: 3.600 s en la regla (el formulario admite hasta 2 h; una expiración se recupera con la recarga de §3.1). No hay SDK, así que la CSP **no** suma dominios de WAF y no existe `VITE_WAF_INTEGRATION_URL`. **Supuesto a verificar en el primer deploy** (paso de `SC-26`): el intersticial de WAF carga y resuelve en `/signup` bajo la response headers policy de la consola; si la CSP lo bloqueara, `/signup` recibe un comportamiento de caché propio con una policy que admite lo que el intersticial necesita (se registra en `docs/architecture.md` §10 y en P-07).

## 4. Mundo de invitado

| Regla | Valor |
|---|---|
| Cupos (`nn` de dos dígitos: también el bloque de teléfonos ficticios `+54 9 11 5551 <nn>xx`, el prefijo `g<nn>-` de los buzones simulados y el estudio `firm-guest-<nn>`) | `01–30` reservados para `guest-01..NN` (NN por defecto 15); `31–90` públicos: **60 mundos públicos activos como máximo**; `91–99` sin uso |
| Arrendamiento por cuenta | Antes de tocar un cupo, `account.ensureWorld` escribe `Runtime/GUESTWORLD#<sub>` = `{nn?, firmId?, leaseId, state: CREATING, since}` con `PutItem` condicional: el item no existe, o su `state` es `DESTROYED` o `FAILED`, o es `CREATING` con `since` de hace más de **5 min** (creación caída). Un segundo llamado concurrente pierde la condición y recibe el estado actual (`CREATING` o `READY`) sin arrendar nada. `leaseId` es un ULID nuevo por arrendamiento |
| Arrendamiento del cupo | `Runtime/SLOT#GUEST#<nn>` = `{sub, firmId, clockId, leaseId, leasedAtReal, hardExpiresAtReal}`, `PutItem` condicional: libre, o liberado hace **al menos 20 min** (`releasedAtReal`, vida del id token + tolerancia); se prueba desde un `nn` al azar hasta recorrer los 60. Una cuenta reservada usa su cupo fijo (`custom:firmId`, leído con `AdminGetUser`) |
| Creación | En el **primer ingreso** (y en cada ingreso posterior sin mundo vivo): `account.ensureWorld` toma los dos arrendamientos, invoca asíncrona a `WorldJanitor {kind: "GUEST_CREATE", sub, nn, leaseId}` y responde `{state: "CREATING"}` en milisegundos. `WorldJanitor` crea el mundo con `createWorld('guest', firmId)` desde `Seed/worlds/guest.json` (~10 s), escribe `Firms/BROKER#brk-guest-<nn>` ligada al `sub` con `leaseId`, y pasa `GUESTWORLD#<sub>` a `READY` (o a `FAILED` con el motivo, liberando el cupo). La consola consulta `account.world` (solo lectura) cada 2 s mientras dure `CREATING`; con `READY` refresca los tokens (el pre-token lee la fila y estampa `firmId` y `worldLease`) y abre `/app/operations` con el recorrido guiado |
| Estados de `account.world` | `NONE` (sin arrendamiento) · `CREATING` · `READY` · `EXPIRED` (el mundo anterior se destruyó por TTL; el próximo `ensureWorld` crea otro) · `CAPACITY` · `FAILED` (el próximo `ensureWorld` reintenta). Las cuotas no son un estado del mundo: son `QUOTA_EXCEEDED` en cada procedimiento |
| Sin cupo | `CAPACITY` (§1.4): "La demo está completa en este momento; probá de nuevo más tarde", con "Probar de nuevo" y "Hablemos". Ningún mundo creado ni cupo arrendado; `GUESTWORLD#<sub>` pasa a `FAILED {reason: CAPACITY}`; la cuenta y el lead quedan; el ingreso siguiente vuelve a intentar |
| Principal de un `GUEST` (falla cerrado) | En todo procedimiento con estudio, la fila `BROKER#` encontrada por `SUB#<sub>` **tiene que existir**, estar activa, tener `firmId` igual al del token y `leaseId` igual al claim `worldLease`; si no, 403 `GUEST_WORLD_GONE` (la consola lleva a `/welcome`, que vuelve a llamar a `ensureWorld`). Vale para públicos y reservados. Test `auth/guest-principal.test.ts`: token viejo, mundo destruido y el mismo cupo arrendado de nuevo por otra cuenta → 403 |
| TTL público | Se destruye a las **24 h reales sin actividad** (`lastActiveAtReal` de la sesión, ADR-0007 y `docs/architecture.md` §10) o a las **72 h reales de creado**, lo que llegue primero; `GUEST_SWEEP` corre **cada hora** |
| Destrucción | `destroyWorld`, en este orden: la fila `BROKER#` (desde ese momento todo token del dueño anterior recibe 403), schedules `tm-g-*` y `TIMER#` del reloj, items del `clockId` en todas las tablas, filas `POP#firm-guest-<nn>#*`, **objetos de S3 del mundo** (abajo), purga de Memory en dos pasadas (§9.3), `TOMB#` de la época, `GUESTWORLD#<sub>` a `DESTROYED`, y **al final** libera el cupo escribiendo `releasedAtReal`. El contador `COUNTER#EPOCH#GUEST#firm-guest-<nn>` **no** se borra: el invitado siguiente en ese cupo arranca con una época mayor y ni la memoria ni los hilos de email del anterior lo alcanzan |
| Objetos de S3 de un mundo de invitado | Toda clave que produce un mundo `GUEST#*` lleva el prefijo `guest/<pub\|res>/<firmId>/e<época>/` delante de la clave normal: en `Documents` (`ops/`, `quarantine/`, `unrecognized/`) y en `Media` (`sim/`). `destroyWorld` (y el reinicio de un mundo reservado, para la época anterior) borra ese prefijo en los dos buckets, los objetos de `Uploads` de los links del mundo (`uploads/<token>/`) y los MIME crudos del bucket de correo (`poc/ops/…`, `poc/sim/…`) que citan las filas `Message` del mundo, **antes** de borrar esas filas. Respaldo: regla de lifecycle de **4 días** sobre `guest/pub/` en `Documents` y `Media` (TTL máximo de 72 h + margen). Test `worlds/guest-worlds.test.ts`: después de `destroyWorld` no queda ningún objeto del mundo en ningún bucket |
| Cuenta y lead | Sobreviven al TTL; al volver a entrar se crea un mundo nuevo (otro cupo posible) |
| Reservados | Sin TTL de destrucción; reinicio nocturno (`IDLE_GUEST_RESET`, 04:00 ART) si no hubo actividad en 24 h; exentos de los topes del alta y del cupo público, **no** de las cuotas por mundo |

**Cuotas por mundo** (reloj real, mundos `GUEST#*` reservados y públicos; contadores `Runtime/QUOTA#<clockId>#<tipo>#<ventana>`; al superarlas el BFF devuelve `QUOTA_EXCEEDED {kind, resetsAtReal}` y la consola muestra "Llegaste al límite de esta demo por hoy; se renueva a las HH:MM"; `account.usage` alimenta un indicador discreto):

| Tipo | Tope |
|---|---|
| Turnos del agente (`Firms/SETTINGS.turnCaps` de los estudios `GUEST`, lo aplica el worker) | 30 por hora, 120 por día |
| Emails salientes del mundo (SES, solo a buzones simulados; regla `CP-WORLD-QUOTA` del pipeline, DENY auditado) | 60 por hora, 200 por día |
| Mensajes del simulador de teléfono | 30 por hora, 150 por día |
| Movimientos del reloj (`advance*`, `fireMilestone`, `moveEta`, `emitDispatchStatus`) | 300 por día |
| Cargas de PDF (simulador y links del mundo; ≤ 10 MB cada una) | 40 por día |
| Operaciones nuevas (`operations.create`) | 10 por día |
| Reinicios del mundo | 1 cada 10 min, 12 por día |
| "Reloj en vivo" (30 min cada uno) | 6 por día |
| Llamados a `account.ensureWorld` por cuenta | 10 por hora (la creación ya es una sola por el arrendamiento por cuenta; esto acota el ruido) |
| **Presupuesto global de mundos públicos** | 1.500 turnos y 1.500 emails salientes por día entre todos; al agotarse, `QUOTA_EXCEEDED {kind: "GLOBAL"}` hasta las 00:00 UTC y alarma `GuestBudgetHits` |

Peor caso de costo por día = 1.500 turnos públicos + 120 × NN reservados, valuados con la tarifa verificada de `Reference/RATECARD` (WP-41); el presupuesto mensual de §12 sigue avisando al 50, 80 y 100 %.

**Solo datos sintéticos**: en un mundo `GUEST#*` WhatsApp es siempre el transporte simulado (aunque `ChannelModes.whatsapp` sea `live`), el perfil `SYSTEM` del cliente de SES solo escribe a `*@sim.legajo.demo.craftech.io` y `*@simulator.amazonses.com` (nunca a `SeedOverrides.demoRecipients`), y el registro del mundo solo acepta contactos de proveedor en `*@sim.legajo.demo.craftech.io` y teléfonos del bloque del cupo. Los emails de producto (escalamientos, avisos al estudio) llegan al **buzón de demo** de la consola, nunca a una persona real.

## 5. Tareas programadas (`WorldJanitor`)

| Evento | Cuándo | Qué hace |
|---|---|---|
| `GUEST_CREATE {sub, nn, leaseId}` | Asíncrono desde `account.ensureWorld` | Crea el mundo, escribe la fila `BROKER#` con `leaseId` y deja `GUESTWORLD#<sub>` en `READY` o `FAILED` (§4). Ignora el evento si `GUESTWORLD#<sub>.leaseId` ya no es el suyo |
| `GUEST_SWEEP` | Cada hora | Destruye los mundos públicos vencidos (§4); pasa a `FAILED` los `GUESTWORLD#` en `CREATING` de más de 5 min y libera su cupo; borra usuarios de Cognito `UNCONFIRMED` **sin grupos** de más de 24 h (`ListUsers` con filtro de estado + `AdminListGroupsForUser` + `AdminDeleteUser`); finaliza **solo** los `SIGNUP#` que cumplen §1.3 (nunca un `EXISTING_GUEST` sin `verifiedAt`); reintenta avisos de lead `PENDING` (hasta 5 intentos); una vez por día, borra leads sin ingreso en **24 meses** (§6) |
| `IDLE_GUEST_RESET` | 04:00 ART | Reinicia los mundos reservados sin actividad en 24 h |
| `GUEST_DESTROY {firmId, reason}` | A pedido (`leads:delete`, operador) | Destruye el mundo de una cuenta |
| `MEMORY_PURGE` | Como hoy | Sin cambios |

## 6. Leads

Tabla **`Leads`** (DynamoDB, propia, separada de los datos de la demo). **Quién la toca, lista cerrada** (la misma en `docs/architecture.md` §3 y §14, en `iam-leads.test.ts` y en los agentes `devops` y `security`): `Bff` (`signup.*`, `account.session`), `SignupDispatch` (solo `SIGNUP#`: nunca escribe un lead, §1.4), `WorldJanitor` (barrido y borrado), `LeadNotice` (lee el lead y escribe `noticeStatus`), el `QaDriver` con cerco (solo lee y borra, con `lead.inspect` y `lead.purge`, los leads de sus propios buzones `qa-signup-<runId>-*` de `SC-26`: `docs/test-plan.md` §4.1, `docs/pending.md` P-07) y los scripts del operador. **Nunca** el worker, las tools, `PolicyAudit`, `ChannelEvents` ni los triggers de Cognito (el estado de rebote vive en `Runtime/MAILSTATUS#`, §3.2).

| Item | Clave (`pk` / `sk`) | Atributos |
|---|---|---|
| Lead | `EMAIL#<emailHash>` / `LEAD` | `leadId` (ULID), `email` (normalizado en minúsculas), `name?`, `company?`, `jobTitle?`, `consents.terms {accepted, at, version, privacyVersion, lang}`, `consents.contact {accepted, at, version, lang}`, `consentHistory[]` (cambios posteriores: baja de contacto), `sourcePoc: "legajo-listo"`, `language`, `utm {source, medium, campaign, term, content}`, `referrer`, `signupAt`, `confirmedAt`, `lastLoginAt?`, `cognitoUsername`, `noticeStatus` (`SENT` \| `PENDING` \| `FAILED` \| `DISABLED`) |
| Alta pendiente | `SIGNUP#<signupId>` / `PENDING` | §2; `expiresAt` 24 h |
| Tumba de borrado | `DELETED#<leadId>` / `TOMB` | `deletedAt`, `reason` (`REQUEST` \| `RETENTION`); sin email ni ningún otro dato personal |

- `emailHash` = HMAC con la subclave `lead-email` (distinta de `email-hash` de las partes del seed); la misma clave indexa `Runtime/MAILSTATUS#`.
- `lastLoginAt`: lo escribe `account.session` con el `auth_time` del token cuando es mayor (el BFF calcula la clave con el claim `email` del id token).
- **Aviso a Craftech**: Lambda `LeadNotice` (invocación asíncrona desde `finalizeSignup` y desde `GUEST_SWEEP`), perfil de remitente **`LEAD_NOTICE`** del cliente único de SES: `From` `avisos@legajo.demo.craftech.io`, destinatarios del secreto **`LeadNoticeTo`** (hasta 3, separados por coma; con 4 o más, o con una entrada vacía, el secreto entero se trata como fuera del cerco: `RECIPIENT_NOT_ALLOWED`, sin envío a nadie; el operador lo carga con `janu@craftech.io`; valor inicial `disabled`), y **cerco: cada destinatario tiene que ser `<local>@craftech.io` exacto** (parser de §13, dominio igual a `craftech.io`, sin subdominios); si no, `RECIPIENT_NOT_ALLOWED`, `noticeStatus DISABLED` y métrica `LeadNoticeFailed`. IAM: `ses:Recipients` `*@craftech.io`. Asunto `[Legajo listo] Nuevo registro en la demo`. Contenido (texto plano, es): email, nombre, empresa y cargo si los dio, idioma, si aceptó contacto, UTM y host del referrer, hora del alta en ART. Nada más. Un aviso por alta confirmada.
- **El aviso no es correo de un mundo**: `LEAD_NOTICE` es un perfil **sin reloj**. El cliente de SES, para ese perfil, **no** escribe `Runtime/PENDING#<clockId>` ni `MAIL#<mailId>`, **no** agrega `X-Legajo-Mail-Id` y no espera que el que llama registre un `Message` en `Conversations`; el estado del envío es solo `LEAD.noticeStatus` (`SENT` al aceptar SES, `PENDING` si falla, `FAILED` a los 5 intentos). El rol de `LeadNotice` no tiene `Runtime` ni `Conversations`. Test en `channels/email/lead-notice-send.test.ts`: un envío `LEAD_NOTICE` no toca `Runtime` ni `Conversations` y cualquier otro perfil sin `clockId` se rechaza.
- **Exportación**: `npm run leads:export -- --out <archivo.csv> [--contactable] [--since AAAA-MM-DD]` (`scripts/leads/export.ts`, operador con el profile de la cuenta, mismo mecanismo de descubrimiento del stage que `console:invite`). Columnas: `email, name, company, jobTitle, language, sourcePoc, contactConsent, contactConsentAt, contactConsentVersion, termsVersion, termsAcceptedAt, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, referrer, signupAt, lastLoginAt, emailStatus` (`emailStatus` sale de `Runtime/MAILSTATUS#<emailHash>`: `OK` si no existe). `--contactable` = contacto aceptado y `emailStatus OK`; `--since` filtra por `signupAt`. Rechaza una ruta dentro del repo, escribe con modo `0600`, neutraliza celdas que empiezan con `= + - @` y solo imprime la cantidad de filas.
- **Baja y borrado**: `npm run leads:optout -- --email <dirección>` (contacto → `false` con fecha en `consentHistory`); `npm run leads:delete -- --email <dirección> [--yes]`: invoca `WorldJanitor` con `GUEST_DESTROY` (incluye los objetos de S3 del mundo, §4), `AdminDeleteUser`, borra `LEAD`, `SIGNUP#`, `GUESTWORLD#<sub>`, `MAILSTATUS#` y los contadores de ese hash, escribe `DELETED#<leadId>` e imprime solo el `leadId`.
- **Retención**: lead hasta 24 meses desde el último ingreso (o desde el alta si nunca ingresó) o hasta que pida el borrado; alta pendiente 24 h; contadores de rate limit hasta 48 h; estado de rebote 24 meses desde el último evento; mundo de invitado y todo lo que se cargó en él (incluidos PDFs) hasta su TTL o el borrado, con un respaldo técnico que desaparece a más tardar 4 días después; logs 30 días sin PII.
- **PII**: los emails de leads nunca van a logs (`log.ts` ya enmascara emails; se suma la redacción de las claves `email`, `password`, `passwordSealed`, `name`, `company`, `jobTitle` en los handlers de `signup.*`, `SignupDispatch` y `LeadNotice`), ni a `AuditLog`, ni a métricas, ni a los exports de la demo (`metrics.export`, bitácora), ni al mundo del invitado (su fila `BROKER#` dice "Invitado", sin email).

## 7. Emails de cuenta (neutrales, es/en)

`AuthCustomMessage` arma asunto y cuerpo en el idioma de `locale` (o `ClientMetadata.lang`) con las plantillas de `packages/bff/src/auth-triggers/messages/` (HTML en línea con tablas y texto alternativo, como las actuales de `infra/auth-email.ts`, que se mudan ahí); todas incluyen `{####}`, "Si no lo pediste, ignorá este mensaje" y el pie "Legajo listo · Powered by Craftech · datos 100 % sintéticos" con el link a la política de privacidad. Ninguna palabra de ADR-0014. Tipos: código de alta (vence en 24 h), reenvío, recuperación de contraseña (1 h), "ya tenés una cuenta" (`intent signup-existing`) e invitación del personal interno (`AdminCreateUser`). Remitente `Legajo listo <no-reply@legajo.demo.craftech.io>` por la identidad SES del app (configuración `DEVELOPER`, ya existente) con el configuration set `…-email-poc`.

## 8. Política de privacidad (`/legal/privacy.html`, es/en)

Contenido obligatorio (Ley 25.326 de Protección de Datos Personales de Argentina; la misma lógica para visitantes de otros países):

1. **Responsable**: Craftech (razón social, domicilio y email de contacto para privacidad: pendiente del CTO, `docs/pending.md`), que decide los fines del tratamiento.
2. **Qué datos**: email y contraseña (la guarda Amazon Cognito con hash; Craftech no la ve ni la almacena), nombre, empresa y cargo si los da, consentimientos con fecha y versión, idioma, UTM y sitio de origen, fechas de alta y último ingreso (el registro comercial se guarda solo después de verificar el email con el código, §1.4); si un email de la cuenta rebota o se marca como no deseado, ese estado; datos técnicos para prevenir abuso (IP convertida en un hash no reversible, 48 h; cookie técnica del filtro de bots, sin seguimiento). Todo lo que se escribe o se sube dentro de la demo tiene que ser sintético; igual se borra con el mundo (al vencer o al pedir la baja) y el respaldo técnico desaparece a más tardar 4 días después.
3. **Para qué**: dar acceso a la demo; con el consentimiento de contacto, que Craftech se comunique por esta solución. Nunca se venden ni se ceden los datos.
4. **Dónde**: AWS (región us-east-1, Estados Unidos) como encargado del tratamiento; transferencia internacional declarada.
5. **Cuánto tiempo**: §6 "Retención".
6. **Derechos**: acceso, rectificación, actualización y supresión (arts. 14 a 16 de la Ley 25.326), gratuitos; respuesta en los plazos de la ley (10 días corridos para acceso, 5 días hábiles para rectificación o supresión); retiro del consentimiento de contacto en cualquier momento sin perder la cuenta; cómo pedirlo (email de privacidad). Se incluye la leyenda de la AAIP como órgano de control de la ley (acceso gratuito cada seis meses salvo interés legítimo, facultad de atender denuncias).
7. **Versión y fecha** (`LEGAL_VERSIONS.privacy`), visibles arriba.

Los términos (`/legal/terms.html`) dicen: demo gratuita con datos sintéticos, sin garantía, uso aceptable (no cargar datos personales reales ni de terceros), límites de uso y TTL del mundo, y que Craftech puede cerrar cuentas abusivas.

## 9. Superficie nueva (resumen para `docs/architecture.md` y `docs/tool-catalog.md`)

| Pieza | Nombre |
|---|---|
| Procedimientos tRPC públicos (`signupProcedure`: ruta exacta sin lote, rate limits del alta, sin JWT; el origen verificado lo exige el handler para toda ruta) | `signup.form`, `signup.start`, `signup.resend`, `signup.confirm` |
| Procedimientos de invitado sin estudio todavía (`guestBootstrapProcedure`: JWT válido, rol `GUEST`, `firmId` opcional) | `account.session` (ampliado), `account.ensureWorld`, `account.world`, `account.usage` |
| Triggers de Cognito | `AuthPreSignUp` (nuevo), `AuthCustomMessage` (nuevo), `AuthPreToken` (claims renombrados; `firmId` y `worldLease` de un `GUEST` salen solo de su fila `BROKER#`) |
| Lambdas nuevas | `SignupDispatch` (invocación asíncrona solo desde `Bff`, eventos `START` y `RESEND`; concurrencia reservada 2; nunca escribe un lead), `LeadNotice` |
| Tabla nueva | `Leads` |
| Items nuevos de `Runtime` | `GUESTWORLD#<sub>`, `MAILSTATUS#<emailHash>`, `MAILBREAKER`, `RL#MAILBAD#<hora>` |
| Secretos nuevos | `OriginVerifyKey` (32 bytes aleatorios), `LeadNoticeTo` (`disabled` hasta que el operador lo cargue) |
| Subclaves nuevas de `SessionTokenKey` | `signup-ticket`, `signup-seal` (cifrado de la contraseña en tránsito a `SignupDispatch`), `lead-email`, `rate`, `form` (firma de `formShownAt`) |
| Grupo de Cognito | `GUEST` (reemplaza al anterior, ADR-0014) |
| Recursos de borde | Web ACL `aws-cds-hackathon-poc-legajo-poc-edge` asociada a la distribución del Router; `Router` con `protection: "oac"` (Function URL de `Bff` y `PublicWeb` en `AWS_IAM`); encabezado de origen `X-Origin-Verify` en `/api/*` y `/u/*` |
| Scripts del operador | `leads:export`, `leads:optout`, `leads:delete`, `signup:breaker`; `console:invite -- --guest <n>` y `--guest-test` |
| Métricas | `SignupStarted`, `SignupConfirmed`, `SignupRejected` (por motivo), `SignupMxUnknown`, `SignupDispatchFailed`, `AccountMailBlocked`, `AccountMailBreakerOpen`, `GuestWorldCapacity`, `GuestWorldFailed`, `QuotaHits` (por tipo), `GuestBudgetHits`, `LeadNoticeFailed` |
| Alarmas | `AccountMailBlocked` > 50 en 1 h; `AccountMailBreakerOpen` > 0; `SignupDispatchFailed` > 5 en 1 h; `GuestBudgetHits` > 0; `LeadNoticeFailed` > 0 |

**Rol de CI (bootstrap, ADR-0009)**: `wafv2:{CreateWebACL, UpdateWebACL, DeleteWebACL, GetWebACL, ListTagsForResource, TagResource, UntagResource}` sobre `arn:aws:wafv2:us-east-1:776805327629:global/webacl/aws-cds-hackathon-poc-legajo-poc-*/*` (dentro de la cerca de nombre del app); la lectura de grupos de reglas administrados que pida el provider (`wafv2:{DescribeManagedRuleGroup, ListAvailableManagedRuleGroups}`, que no admiten recurso propio) va a `WILDCARD_SIDS` con su justificación; la asociación a la distribución usa `cloudfront:UpdateDistribution` ya cercado; OAC suma `cloudfront:{CreateOriginAccessControl, GetOriginAccessControl, UpdateOriginAccessControl, DeleteOriginAccessControl}` (sin cerca por recurso: `WILDCARD_SIDS` con su justificación) y `lambda:AddPermission`/`RemovePermission` para el principal `cloudfront.amazonaws.com` sobre las funciones del app (ya cercadas por nombre). Triggers, tabla, secretos y Lambdas nuevos entran en las cercas existentes (`cognito-idp` del pool del app, `dynamodb` por prefijo, `lambda` por nombre, `ssm` de secretos). El operador vuelve a aplicar el bootstrap antes del primer deploy de esta ola. La CSP no cambia (sin SDK de WAF). Sin KMS salvo el plan B de §3.2.

## Considered options

- **`SignUp` desde el navegador**: la forma habitual, pero deja el alta abierta a cualquier script contra el cliente público de Cognito y revela qué emails tienen cuenta.
- **`SignUp` desde el BFF dentro del pedido, con un retardo mínimo uniforme**: más simple, pero las ramas hacen trabajo distinto (triggers en frío, `ForgotPassword`, borrado y alta) y sus latencias superan cualquier piso razonable, así que el tiempo delata qué emails tienen cuenta. Rellenar todas las ramas hasta un plazo fijo por encima del p99 de la más lenta (≈ 2,5 s) funciona, pero ocupa la concurrencia reservada del BFF durante todo el plazo en cada alta. Elegimos sacar la llamada a Cognito del camino de respuesta.
- **Solo el encabezado `X-Origin-Verify`**: gratis y sin cambios en el cliente, pero una inundación directa a la Function URL igual invoca la Lambda y agota su concurrencia reservada antes del chequeo. OAC corta antes de invocar.
- **SDK de integración de WAF**: exige Bot Control dirigido o ACFP para tener URL de integración (§3.3); el desafío en el documento `/signup` da el mismo token sin ese costo.
- **Pool solo de administrador y verificación propia por SES**: control total, pero el código ya no es de Cognito (el CTO lo pidió de Cognito) y el BFF tendría que enviar emails a cualquier dirección.
- **Modo lista de espera (`waitlist` → `open`) mientras la demo no se pueda crear de punta a punta**: captaba leads desde un deploy temprano, pero guardaba el consentimiento de contacto de direcciones sin verificar (sin valor bajo la Ley 25.326), cambiaba el CTA que eligió el CTO y sumaba un switch por stage, una excepción cercada para probar y un `robots` por modo. Sobra porque la URL no se comparte hasta que el producto entero está desplegado y probado (§1.4).
- **Lista de espera con verificación del email**: exigiría mandar un código a cualquier dirección antes de que la demo exista (el mismo riesgo de reputación que el alta, sin su beneficio).
- **Rechazar el alta cuando el cupo de mundos está lleno**: evitaría la pantalla `CAPACITY` del primer ingreso, pero perdería el lead verificado y haría que `signup.start` delate la ocupación; la cuenta queda y el ingreso siguiente reintenta (§1.4).
- **Un mundo por alta sin cupo**: sencillo, pero sin tope de recursos, sin bloque de teléfonos ni de buzones acotado y con costo abierto.
- **Leads en `Firms` o en `AuditLog`**: mezcla PII con datos de la demo y con exports que ven los invitados.
- **Estado de rebote dentro del lead**: no cubre los rebotes de altas que nunca se confirmaron (la mayoría) y obliga a dar `Leads` a `ChannelEvents` y a los triggers.

## Consequences

- El BFF gana acceso a `Leads`, a `AdminGetUser`, `AdminListGroupsForUser` y `AdminAddUserToGroup` del pool (cercado en código al grupo `GUEST` y a usuarios sin grupos) y a invocar `SignupDispatch`; sigue sin SES. `SignupDispatch` concentra `ListUsers`, `AdminGetUser`, `AdminListGroupsForUser` y `AdminDeleteUser` (cercado a `UNCONFIRMED` sin grupos).
- La consola manda el id token en `X-Legajo-Auth` y firma el cuerpo de cada `POST` con `x-amz-content-sha256` (OAC); la página de carga, igual.
- El mundo de un invitado público es efímero: el recorrido guiado se completa en minutos, y después de 24 h sin uso vuelve a empezar desde el día 0.
- Craftech queda como responsable de una base de datos personales: inscripción en el registro de la AAIP y casilla de privacidad a cargo del CTO (`docs/pending.md`).
- Con el cupo de mundos lleno, un invitado recién confirmado ve `CAPACITY` en su primer ingreso (§1.4): la cuenta y el lead existen, Craftech ya recibió el aviso y el ingreso siguiente reintenta.
- Si WAF o las cuotas resultan chicos, se cambian números en `packages/shared/src/guest-limits.ts` (fuente única de §3.2 y §4) sin tocar el diseño.
