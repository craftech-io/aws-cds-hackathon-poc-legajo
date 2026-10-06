---
status: accepted
---

# Superficies neutrales: la POC es un producto, el rol de prueba se llama `GUEST` y un guard lo verifica en CI

Decisión del CTO del 2026-09-26. La POC publicada es un **producto para un cliente futuro**: ninguna superficie visible nombra el concurso para el que se presenta. Las reglas oficiales y la FAQ del concurso (verificadas el 2026-09-26) no exigen mencionarlo en el proyecto publicado; sí exigen acceso libre para probarlo y, si hay login, credenciales en las **instrucciones de prueba privadas** del formulario. Decidimos: (1) una lista cerrada de palabras que ninguna superficie visible puede contener; (2) que el rol pensado para quien prueba la demo sin ser del estudio se llame **invitado** (`GUEST`, cuentas `guest-NN`), con el mismo comportamiento que tenía el rol anterior; (3) un guard nuevo, `npm run lint:neutral-surfaces`, sobre las fuentes visibles y sobre el build de la web, que corre en CI y en el deploy junto al de términos prohibidos. El estándar completo de superficies públicas es la skill del workspace `poc-landing` (`../.claude/skills/poc-landing/SKILL.md`, fuera de este repo; no se copia porque nombra otro producto).

Este ADR es el **único documento del repo** que conserva los nombres viejos, como mapa de renombrado. El contexto del concurso vive solo en los documentos internos (`docs/`, `CLAUDE.md`, `.claude/`), en el formulario y el video de la submission, y en la sección **"Submission notes"** al final de `README.md`, que empieza como README de producto.

## 1. Qué es una superficie visible

Todo lo que puede leer una persona que usa el producto: landing, signup y login, consola, páginas legales, simulador de teléfono, buzón de demo, link de carga (`/u/<token>`), emails (de producto, de cuenta y el aviso interno de lead), PDFs, plantillas de WhatsApp, textos del seed que se muestran, textos alternativos de imágenes y capturas.

No son superficie visible: identificadores internos que solo aparecen en tráfico de red o en la cuenta de AWS (nombre de la app SST `aws-cds-hackathon-poc-legajo`, nombres de buckets en la CSP y en URLs prefirmadas, nombres de roles, tablas y configuration sets, nombre del repo). Renombrarlos recrearía todos los recursos y las cercas del rol de CI (ADR-0009); se aceptan como límite declarado y **nunca** se usan en un texto visible. `devops` verifica una vez que un email entregado (MIME crudo en el bucket de correo entrante) no lleva el nombre de la app en sus encabezados.

## 2. Palabras prohibidas

Fuente única: `scripts/lint/neutral-words.ts` (el guard y sus tests la importan; ningún otro archivo la repite). Cada grupo se identifica por su **número** (columna `#`): es lo que recibe `--group` en la línea de comandos, así el argumento nunca es él mismo una palabra de la lista.

| # | Grupo | Palabras (se comparan ya normalizadas, ver §3) |
|---|---|---|
| 1 | Concurso | `hackathon`, `hackathons`, `hackaton`, `hackatones` (cubre "hackatón"), `devpost`, `concurso`, `concursos`, `contest`, `contests` |
| 2 | Premios | `premio`, `premios`, `prize`, `prizes` |
| 3 | Jurado | `jurado`, `jurados`, `jurada`, `juradas`, `juez`, `jueces`, `jury`, `juries`, `judge`, `judges`, `judged`, `judging` |
| 4 | Evaluación | `evaluacion`, `evaluaciones` (cubre "evaluación"), `evaluation`, `evaluations`, `evaluador`, `evaluadores`, `evaluadora`, `evaluadoras`, `evaluator`, `evaluators` |
| 5 | Frase | `aws cds` (dos tokens consecutivos: cubre "AWS CDS", "aws-cds", "AwsCds") |

Las formas en inglés y las de "evaluación" amplían la lista del CTO por simetría: la consola es bilingüe y la política de contacto habla de "chequeos" y "decisiones", nunca de "evaluación". Un texto legítimo que choque (p. ej. "traductor público jurado" en un seed) se reescribe; **el guard no tiene lista de excepciones**.

## 3. Reglas de coincidencia

1. Normalización: NFKD y se quitan las marcas diacríticas (`\p{M}`), así "Evaluación" = "evaluacion" y "Hackatón" = "hackaton".
2. Se separan los límites camelCase y de dígitos (`isJudge` → `is Judge`, `JUDGE_TEST` → `JUDGE TEST`) y después se pasa a minúsculas.
3. Se parte en tokens por `[^a-z0-9]+` (guiones, guiones bajos, puntos, barras y espacios separan).
4. Palabra completa = token igual a una palabra de la lista; frase = tokens consecutivos iguales a los de la frase.
5. Así `judge-01`, `IDLE_JUDGE_RESET`, `JudgesButton` y "Jurado:" coinciden; "judgement", "prejudged", "premium", "concursal", "evaluar" y "jurisdicción" no.

Salida: `ruta:línea: palabra` por hallazgo (las palabras no son secretas, a diferencia de `FORBIDDEN_TERMS`) y código de salida 1. Sin hallazgos, una línea con la cantidad de archivos revisados y salida 0.

## 4. Qué escanea

Modo fuentes (`npm run lint:neutral-surfaces`), archivos de texto (`.ts`, `.tsx`, `.js`, `.mjs`, `.css`, `.html`, `.json`, `.svg`, `.txt`, `.xml`, `.webmanifest`) de:

| Glob | Por qué |
|---|---|
| `packages/web/src/**` | Landing, signup, login, consola, simulador, buzón, recorrido guiado, textos alternativos |
| `packages/web/index.html`, `packages/web/public/**` | Metadatos, páginas legales, manifiesto de la landing, SVG de marca |
| `packages/bff/src/copy/**` | Todo texto a importadores, proveedores y estudio (emails, WhatsApp, respuestas fijas) |
| `packages/bff/src/public-web/**` | Página del link de carga |
| `packages/bff/src/auth-triggers/messages/**` | Emails de cuenta de Cognito, es/en (ADR-0015) |
| `packages/bff/src/leads/notice/**` | Aviso interno de lead (también es un email) |
| `packages/reader-mock/src/**`, `packages/platform-mock/src/**` | Observaciones del lector y estados de la plataforma que la consola muestra |
| `packages/shared/src/consent-texts.ts` | Textos de las dos casillas de consentimiento del alta, es/en (ADR-0015 §8) |
| `infra/auth-email.ts` | Descripciones de grupos de Cognito y nombre visible del remitente de los emails de cuenta (las plantillas se mudaron a `packages/bff/src/auth-triggers/messages/`) |
| `scripts/channels/whatsapp-templates.ts` | Cuerpos que se envían a Meta |
| `scripts/seed/data/**` | Textos del seed (el manifiesto del seed deja de llevar el nombre de la app: pasa a `"product": "legajo-listo"`) |
| PDFs generados por el seed | Texto y metadatos, con la misma extracción que usa `lint:forbidden` |

Excluidos siempre: `**/*.test.*`, `**/__snapshots__/**`, `**/testing/**`, `packages/web/e2e/**`, `README.md`, `docs/**`, `.claude/**`, `CLAUDE.md`, `CONTEXT.md`, `.github/**` y el propio `scripts/lint/**`. Un archivo nuevo con texto visible fuera de estos globs obliga a ampliar la tabla (y `neutral-surfaces.test.ts`) en el mismo PR.

Modo dist (`npm run lint:neutral-surfaces -- --dist`): todo archivo de texto de `packages/web/dist/**` (HTML, JS, CSS, JSON, SVG). Sin `dist` o vacío → **falla cerrado** (código 2). El bundle incluye las dependencias: si una librería trajera una palabra de la lista, se cambia la librería o se aísla el chunk, nunca se agrega una excepción.

Modo árbol completo (`npm run lint:neutral-surfaces -- --all-tree [--group <n>]`): de una sola vez, no corre en CI. Pasa `findNeutralHits` sobre **todo** archivo de texto versionado (`git ls-files`), sin los globs ni las exclusiones de arriba salvo `docs/adr/0014-*` y `scripts/lint/neutral-*`, opcionalmente limitado a un grupo de la tabla de §2 por su número (`--group 3`; un número fuera de 1 a 5 → código 2). Lo usa el criterio de terminado del renombre (§8) para encontrar restos dentro de identificadores (`isJudgeClaim`, `JUDGE_TEST_CLOCK_ID`) en código, infra, scripts y casos, que el modo fuentes no mira porque no son visibles. Mismo formato de salida y códigos que el modo fuentes.

Las capturas y renders de la landing no se pueden escanear como texto: `scripts/landing/frame-check.ts` aplica las mismas palabras (y `FORBIDDEN_TERMS`) sobre el `innerText` de cada frame antes de escribirlo (ADR-0016).

## 5. Tests

`scripts/lint/neutral-surfaces.test.ts` (vitest, dentro de `npm test`):

- `it.each(NEUTRAL_WORDS)`: por cada palabra, cuatro variantes positivas (minúsculas; MAYÚSCULAS; con acento o capitalizada; dentro de un identificador kebab, snake y camel) → exactamente un hallazgo con la línea correcta. Si alguien borra una palabra de la lista, su caso falla.
- La frase `aws cds` en sus formas con espacio, guion y camel.
- Negativos fijos: "judgement", "prejudged", "premium", "concursal", "evaluar", "jurisdicción", "cdsx aws".
- Globs: un árbol temporal con un archivo por fila de §4 y uno por exclusión; se afirma cuáles se escanean.
- `--dist` sin carpeta → código 2; con un JS minificado que contiene `"JUDGE"` → código 1.
- `--all-tree --group <n>`: con `3`, un árbol temporal con un identificador camel del rol anterior da un hallazgo y una palabra del grupo 1 no; `--group 0`, `--group 6` o un nombre en lugar del número → código 2.

## 6. CI

- `ci.yml`: paso `npm run lint:neutral-surfaces` inmediatamente después de `lint:forbidden`; paso `npm run lint:neutral-surfaces -- --dist` inmediatamente después del build de la web (junto a `lint:forbidden -- --dist`).
- `deploy.yml`: los mismos dos pasos, antes de `sst deploy`.
- No necesita secretos: corre igual en forks y en local.

## 7. Rol invitado (`GUEST`)

El comportamiento no cambia: un invitado tiene los permisos de `BROKER` **solo dentro de su propio estudio de invitado**, con su mundo aislado y sembrado, reloj en pausa y recorrido guiado. Hay dos clases (detalle en ADR-0015):

| Clase | Cuentas | Alta | Mundo |
|---|---|---|---|
| Reservada | `guest-01..NN` (NN por defecto 15, máximo 30) y la sintética `guest-test` | El operador, con `console:invite --guest` (sin email, contraseña permanente); credenciales solo en las instrucciones privadas de la submission y en el secreto `GUEST_TEST_PASSWORD` | Estudio fijo `firm-guest-<nn>`; reinicio nocturno si no hubo actividad en 24 h |
| Pública | Cualquiera que se registra en `/signup` | Signup propio con email verificado (ADR-0015) | Estudio `firm-guest-<nn>` del rango público, arrendado al entrar y destruido por TTL |

## 8. Mapa de renombrado (una sola pasada, sin alias)

Criterio de terminado: `git grep -n -i -E "judg|jurad|juez|jueces|jury|juries" -- . ':!docs/adr/0014-*' ':!scripts/lint/neutral-*'` (búsqueda por **subcadena**, sin `-w`: con `-w` el guion bajo y las letras cuentan como parte de la palabra y nunca aparecerían `JUDGE_TEST_PASSWORD`, `JUDGE_TEST_CLOCK_ID`, `isJudge`, `isJudgeClaim`, `judgeClockId`, `JudgesButton` ni `IDLE_JUDGE_RESET`) devuelve solo estas tres excepciones: la cita textual de las instrucciones privadas del formulario en `docs/pending.md` §5, la sección "Submission notes" de `README.md` y este ADR; `scripts/lint/neutral-words.ts` (la lista) y `scripts/lint/neutral-surfaces.test.ts` (sus variantes) quedan fuera por la ruta. Todo otro test que necesite una de esas palabras la importa de `neutral-words.ts`, nunca la escribe literal. Como segunda pasada, `npm run lint:neutral-surfaces -- --all-tree --group 3` (modo de una sola vez de WP-47: corre `findNeutralHits` sobre **todo** el árbol versionado, no solo sobre los globs visibles, limitado al grupo 3 de la tabla de §2, con el corte camelCase y de dígitos de §3) devuelve las mismas tres excepciones. **Este ADR es el único lugar que escribe los dos comandos, los identificadores viejos y las palabras del grupo 3**: la aceptación de WP-46 (`docs/build-plan.md`), los casos de QA y los agentes citan "los dos comandos de ADR-0014 §8" sin copiarlos, porque cualquier copia fuera de las tres excepciones es ella misma un hallazgo de los dos comandos. Por la misma razón, ningún documento nuevo nombra un resto concreto: dice "identificadores del rol anterior". Los documentos internos que necesitan nombrar a las personas del concurso dicen "evaluadores del concurso".

| Categoría | Antes | Después |
|---|---|---|
| Rol (`ConsoleRole`, `APPROVER_ROLES`) | `JUDGE` | `GUEST` |
| Grupo de Cognito | `JUDGE`, descripción que nombraba el concurso | `GUEST`, "Guest: broker permissions inside its own demo firm, no TOTP" (precedencia 20) |
| Claim del token | `custom:isJudge` | `custom:isGuest` |
| Principal y helpers | `isJudge`, `isJudgeClaim`, `isJudgeFirm`, `withBrokerRow` sin el flag | `isGuest`, `isGuestClaim`, `isGuestFirm`; `withBrokerRow` recibe `isGuestClaim` (cierra el hallazgo abierto de la ola 2) |
| Denegaciones (`auth/denials.ts`) | `JUDGE_OUTSIDE_JUDGE_FIRM` y demás `JUDGE_*` | `GUEST_OUTSIDE_GUEST_FIRM`, `GUEST_*` |
| `Firm.kind` | `JUDGE` | `GUEST` (con `guestKind` `RESERVED` \| `PUBLIC`) |
| Atributo `world` de los items | `judge` | `guest` |
| Alcance y id de reloj | `JUDGE`, `JUDGE#<firmId>`, `judgeClockId()` | `GUEST`, `GUEST#<firmId>`, `guestClockId()` |
| Constantes compartidas | `JUDGE_TEST_CLOCK_ID`, `JUDGE_FIRM(S)`, `JUDGE_CLOCK`, `JUDGE_TEMPLATE_{FIRM,TAG,CLOCK}`, `JUDGE_START`, `JUDGE_OPERATIONS`, `JUDGE_MODELS`, `JUDGE_TEST_USER`, `JUDGE_TEST_ACTIONS`, `JUDGE_ACTIVITY_REFRESH_MS` | Mismo nombre con `GUEST` |
| Estudios | `firm-judge-<nn>`, `firm-judge-test` | `firm-guest-<nn>`, `firm-guest-test` |
| Despachantes | `brk-judge-<nn>`, `brk-judge-test` | `brk-guest-<nn>`, `brk-guest-test` |
| Usuarios | `judge-01..NN`, `judge-test` | `guest-01..NN`, `guest-test` |
| Secreto de GitHub y variable | `JUDGE_TEST_PASSWORD`, `JUDGE_TEST_PASSWORD_ENV`, `judgeTestPassword`, `judgePassword` | `GUEST_TEST_PASSWORD`, `GUEST_TEST_PASSWORD_ENV`, `guestTestPassword`, `guestPassword` (el operador crea el secreto nuevo y borra el viejo) |
| CLI de alta | `console:invite -- --judge <n>`, `--judge-test` | `--guest <n>`, `--guest-test` |
| Eventos de `WorldJanitor` | `IDLE_JUDGE_RESET` | `IDLE_GUEST_RESET` (reservados, nocturno) + `GUEST_SWEEP` y `GUEST_DESTROY` (ADR-0015) |
| Schedules | `tm-j-*` | `tm-g-*` |
| Buzones simulados | `j<nn>-<código>@sim.legajo.demo.craftech.io` | `g<nn>-<código>@sim.legajo.demo.craftech.io` |
| Filas de `Platform` e IAM | `POP#firm-judge-*`, `POP#firm-judge-test#*` | `POP#firm-guest-*`, `POP#firm-guest-test#*` |
| Plantilla de mundo | `worlds/judge.json` | `worlds/guest.json` |
| Router y actividad | `routers/judge-activity.ts`, `markJudgeActivity`, `refreshJudgeActivity`, `touchJudgeSession`, `judge_activity` | `routers/guest-activity.ts`, `markGuestActivity`, `refreshGuestActivity`, `touchGuestSession`, `guest_activity` |
| Escenarios | `sc-24-judge.ts`, `sc-25-judge-sessions.ts` | `sc-24-guest.ts`, `sc-25-guest-sessions.ts` |
| Web | `JudgesButton`, `JudgesSection`, `JUDGES_SIGN_IN`, `judgeWorld`, `judgeMailbox`, `judgeHistory`, `judgeHours`, `judgeWorldViews` | Desaparecen con la landing nueva (ADR-0016) o pasan a `guest*` |
| Textos | "Jurado: ingresar", "Judges: sign in", "otra cuenta de jurado", "please use another judge account" | "Ingresar" / "Sign in"; "Otra sesión usó este mundo hace X min: si compartís la cuenta, usá otra cuenta de invitado" / "…please use another guest account" |
| Política de contacto (sentido "sin veredicto") | `judged`, `unjudged` | `decided`, `undecided` |
| Casos y pruebas | `tests/cases/FL-*.md`, `e2e/*.spec.ts`, fixtures, snapshots | Mismo renombrado; los snapshots se regeneran |
| Documentos | "jurado" como rol del producto | "invitado"; "evaluadores del concurso" donde el documento interno habla del concurso |

El trabajo de renombrado va antes que cualquier otra línea de la ola de superficies públicas: el guard no puede pasar sin él.

## Considered options

- **Mantener `JUDGE` en el código y traducir solo los textos**: el bundle y las cuentas (`judge-01`) filtrarían la palabra a la consola y al build; el guard necesitaría excepciones.
- **Una lista de palabras dentro de `FORBIDDEN_TERMS`**: esa lista es secreta, vive fuera del repo y no imprime el término; esta es pública, se prueba palabra por palabra y tiene que correr sin secretos.
- **Renombrar también la app SST y el repo**: recrea todos los recursos, las cercas de IAM y el bootstrap a semanas del cierre, para identificadores que ninguna persona usuaria lee.

## Consequences

- Toda PR que agregue texto visible corre el guard localmente; una palabra de la lista en un texto legítimo se reescribe.
- Las credenciales de las cuentas reservadas siguen yendo solo a las instrucciones privadas del formulario; el README de producto dice cómo registrarse.
- Si la POC se reutiliza en otro contexto comercial, el guard queda y la lista puede crecer sin tocar el código que la usa.

## Adenda 2026-10-06: aviso de "otra sesión" retirado

El CTO decidió retirar el aviso de "otra sesión" de la consola del invitado (la fila "Textos" de la tabla de §8 lo nombra): cada ingreso nuevo de la misma persona cuenta como otra sesión, así que el aviso salía sin que nadie compartiera la cuenta (lo recibió el propio CTO) y no es un requisito del concurso. `account.session` ya no devuelve `otherSession` y la consola no muestra nada. Se conserva `lastSession` del mundo (`originJti`, `authTime`, `lastActiveAtReal`) porque el `WorldJanitor` lo usa para el reinicio por inactividad y el vencimiento de los mundos públicos; el subcampo `previous` se eliminó con el aviso.
