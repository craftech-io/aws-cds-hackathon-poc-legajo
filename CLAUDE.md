# CLAUDE.md — aws-cds-hackathon-poc-legajo

Instrucciones estrictas para Claude Code en este repositorio. No es documentación para humanos.

Este repositorio es la submission de Craftech a la **AWS CDS Agentic AI Partner Hackathon** (cierre 2026-10-28 13:00 PT), pero **la POC publicada es un producto para un cliente futuro**: ninguna superficie visible nombra el concurso (ver SUPERFICIES PÚBLICAS). El repo lo leen personas que no estuvieron en ninguna conversación (prospectos, partners, evaluadores del concurso): escribí para ellas.

## Qué es

**Legajo listo**: agente de coordinación para estudios de despachantes de aduana en Latinoamérica. Persigue la factura comercial, el packing list y el certificado de origen de cada importación: al importador por **WhatsApp** (AWS End User Messaging Social; modo `simulated` con simulador de teléfono hasta que el CTO conecte la WABA) y al proveedor extranjero por **email** (Amazon SES, en vivo de punta a punta, proveedores simulados en buzones propios). Cada PDF pasa por un **lector documental externo** (mock nuestro detrás de un contrato OpenAPI); el agente decide quién corrige cada observación, recalcula plazos cuando se mueve la ETA y deja el legajo listo para que el despachante lo **apruebe (siempre humano)**.

Vocabulario en `CONTEXT.md`; diseño en `docs/design-brief.md`; topología en `docs/architecture.md` y `docs/architecture-integrations.md`; decisiones en `docs/adr/`; flujos en `docs/flows-catalog.md`; tools en `docs/tool-catalog.md`; seed en `docs/seed-spec.md`; pruebas en `docs/test-plan.md`; plan por paquetes en `docs/build-plan.md`; reuso en `docs/reuse-map.md`; pendientes externos en `docs/pending.md`.

---

## REGLAS NO NEGOCIABLES

### Del stack

- **Serverless only.** Nada con servidores administrados.
- **SST v4 para toda la infra** (`sst.aws.*`, `$app`, `$dev`); **nunca `new pulumi.xxx`**. `aws.*` / `awsnative.*` solo donde no hay componente SST (AgentCore, Guardrails, SES receipt rules, Scheduler); si hay que linkearlos, `sst.Linkable`.
- **Todo por IaC.** Ningún recurso AWS a mano. Lecturas (`describe-*`, `list-*`, `get-*`) sí. Lo que ningún provider modela va a "configuración manual declarada" en `docs/architecture.md` §17 con su comando de verificación.
- **Un solo stage, `poc`, y `sst deploy` solo desde CI** (push a `main`). **Nunca `sst dev`** (crea recursos reales y tocaría el Ingress compartido): el desarrollo se prueba con `U`, `LF` y `UI` locales y en `poc` por CI. **Nunca `sst remove`** sin confirmación explícita del operador en el momento.
- **Providers pinneados**: `aws` 7.32.0, `aws-native` 1.74.1. Se cambian solo con ADR.
- **`Resource` de SST, nunca `process.env`** en Lambdas (salvo `STAGE` y `NODE_ENV`); `/// <reference path=".../sst-env.d.ts" />` en cada archivo que use `Resource`; recursos leídos con `readLinked(nombre, zod)` y secretos con `secretValue(nombre)`.
- **Secretos con `sst.Secret`**, declarados una sola vez en `infra/secrets.ts`. Nada en el repo, en `.env`, en `environment` ni en el chat.
- **Removal `remove`** en todos los stages.
- **Máximo 400 líneas** por archivo TS/TSX. **Feature-based**. **Sin librerías de estado** (Context + useState). **Tailwind v4** con `@theme`, sin hex en JSX.
- **zod en todos los bordes** (tools, eventos SNS/SES/EventBridge, lector, plataforma, tRPC, conector).
- **Toda llamada externa con timeout y reintento con backoff.** Logs JSON con correlation id, **sin PII** (`packages/bff/src/lib/log.ts`).
- **Reloj inyectado**: ninguna lógica de negocio llama `Date.now()`; usa el reloj del mundo de la operación (ADR-0007). Todo lo que pasa en una hora simulada es un `TIMER#` que el reloj sabe avanzar.
- **Sin dependencias a ciegas**: versión estable, mantenida, compatible con Node 22 y ESM, y declarada en la ola 0 (`docs/build-plan.md` §1 nota 5).
- **Documentación solo en los lugares definidos**: `architect` escribe `CLAUDE.md`, `CONTEXT.md`, `README.md` y `docs/`; `qa` escribe `tests/cases/`. Nadie más crea README ni notas sueltas. No se documenta lo que hizo Claude.

### Del producto

- **La lectura de documentos no es nuestra.** Nunca OCR, clasificación ni extracción propia: todo PDF va al lector por su contrato; lo desconocido va al despachante (ADR-0003).
- **La aprobación es siempre humana.** No existe una tool que apruebe; aprobar es de la consola, rol `BROKER` (o `GUEST` en su propio estudio de invitado), login ≤ 15 min (ADR-0010).
- **El agente habla solo por `send_whatsapp` y `send_email`**; el texto final del turno es una nota interna (ADR-0011). Todo envío pasa por el pipeline de `packages/bff/src/outbound/`.
- **Política de contacto en código** (`packages/bff/src/policy/`, reglas `CP-*`), nunca en el prompt (ADR-0012).
- **Identidad fuera del modelo**: importador por teléfono registrado (único por `ADDR#`); proveedor por dirección de la operación (con etiqueta) + contacto `ACTIVE` del proveedor de esa operación + `dmarcVerdict PASS` (nunca una rama por DKIM ni un `d=` leído de encabezados). `SimMail` solo actúa sobre correo nuestro verificado por `Message-ID`. Ninguna tool confía en un id que escriba el modelo: todo sale del `sessionToken`; zod `.strict()` en cada tool.
- **Todo contenido entrante es hostil**: se enmascara (CUIT, DNI, CBU, tarjetas, IBAN) antes de persistirlo, va al Harness escapado dentro de un delimitador aleatorio por turno y pasa por el pre-filtro determinista de G1; asunto, nombre de archivo y metadatos del PDF nunca llegan al modelo; ningún saliente lleva enlaces ni contactos ajenos (`CP-NO-FOREIGN-LINKS`).
- **Cerco de destinatarios**: dentro del cliente único de SES (y por IAM con `ses:FromAddress`/`ses:Recipients`), **por perfil de remitente** declarado por el que llama y verificado contra el `From`: `SYSTEM` solo a buzones de `sim.legajo.demo.craftech.io`, `simulator.amazonses.com` y destinatarios de demo registrados en `SeedOverrides`; `SIMULATOR` (`SimMail`) solo a la dirección de operación verificada por HMAC del correo que contesta y solo con `From` = contacto `ACTIVE` registrado del proveedor de esa operación (regla de datos, sin prefijos); `QA` solo desde `qainject-*@sim…` (inyector, nunca una parte) o desde una parte de un mundo `qa-*` que no es contacto `ACTIVE` de la operación destinataria, y solo a `qa-*@sim…` y a direcciones de operación de relojes `qa-*` (`docs/architecture-integrations.md` §1). Nunca dominios reservados; rebotes solo por el simulador de SES; ninguna excepción fuera de esa tabla.
- **Supuestos rotulados**: días libres en puerto, costo de demora y base manual son "supuesto" en todo texto y vista.
- **WhatsApp `live` solo con P-01 cerrado** (`npm run channels:check-modes` lo impide).

### Del concurso y de la marca

- **Marca pública**: "Legajo listo · Powered by Craftech". **Ningún archivo, commit, texto, dato ni PDF nombra a un cliente de Craftech ni a una empresa real del mercado.** Todo nombre del seed es inventado, verificado con búsqueda registrada y rotulado "ficticio". `npm run lint:forbidden` corre la lista externa (`FORBIDDEN_TERMS`) sobre árbol, commits, PDFs, seed y build de la web, y **en CI falla cerrado** (sin la lista, el job falla). Nunca imprime el término encontrado.
- **Scaffolding declarado**: lo copiado del scaffolding interno de Craftech (SST, CI y AgentCore, anterior al período del concurso) se declara en la sección "Submission notes" del README; nunca se nombra el producto del que salió (`docs/reuse-map.md`).
- **Qué es real y qué es simulado** se dice en la landing, el README y el video; WhatsApp se presenta como adaptador implementado en modo simulado hasta P-01, nunca como canal vivo.
- **Credenciales de las cuentas reservadas `guest-NN`** solo en las instrucciones de prueba privadas del formulario de la submission (P-05); nunca en el repo, el README ni un chat. Además, cualquiera puede darse de alta en `/signup`.
- **Materiales de submission en inglés.** La propiedad intelectual es de Craftech. Sin créditos de AWS mencionados.

---

## SUPERFICIES PÚBLICAS (POC de demo)

Estándar de Craftech: skill `poc-landing` del workspace (`../.claude/skills/poc-landing/SKILL.md`, fuera de este repo; **no se copia** porque nombra otro producto) y la regla "POCs de demo" del `CLAUDE.md` del workspace. Decisiones del repo: ADR-0014 (textos neutrales, rol `GUEST`, guard), ADR-0015 (alta pública, leads, anti abuso), ADR-0016 (landing y capturas reales); diseño en `docs/landing-spec.md`; paquetes en `docs/build-plan.md` (ola 3, etapas A1 y A2).

- **Agnóstica al concurso.** Ninguna superficie visible (landing, alta e ingreso, consola, legales, simulador, buzón, página de carga, emails de producto, de cuenta y de lead, PDFs, plantillas de WhatsApp, textos del seed, `alt` de imágenes) contiene las palabras de `scripts/lint/neutral-words.ts` (las del concurso, sus premios, quienes lo juzgan y la evaluación, en es y en, más "AWS CDS"). El concurso se nombra solo en `docs/`, `.claude/`, este archivo, el formulario y el video de la submission, y la sección "Submission notes" al final de `README.md`. `npm run lint:neutral-surfaces` (fuentes y `-- --dist`) corre en `ci.yml` y `deploy.yml` junto a `lint:forbidden`; una colisión se reescribe, nunca se exceptúa.
- **Rol `GUEST`** ("Invitado"/"Guest"; cuentas `guest-NN`, `guest-test`; estudios `firm-guest-<nn>`): permisos de `BROKER` solo en su propio estudio, sin MFA ni cambio de contraseña salvo por recuperación. Los identificadores internos que llevan el nombre del app (app SST, buckets, roles, repo) no se renombran y nunca aparecen en un texto visible.
- **Landing comercial**: problema, recorrido del producto, qué hace por actor, garantías en código, impacto **solo como metas rotuladas**, integración, qué es simulado; CTAs "Probar la demo" (`/signup`), "Ingresar" (`/login`) y "Hablemos" (contacto de Craftech); de 360 a 1440+ px, `prefers-reduced-motion`, WCAG 2.2 AA, presupuesto de performance; sin librería de animación.
- **Imágenes del producto real**: capturas de la consola con `scripts/landing/` o renders con componentes y textos reales, listados en el manifiesto con la captura que los reemplaza y su política (`swap`: sale cuando la captura es de `poc`; `zoom`: queda por diseño); nunca un mockup de una función que no existe.
- **Alta propia**: el navegador nunca llama a `SignUp` (ticket firmado + `PreSignUp`, llamadas a Cognito en `SignupDispatch`, fuera del camino de respuesta); email verificado por código; una cuenta por email sin revelar cuáles existen, ni por respuesta ni por tiempo; solo una cuenta pública `GUEST` existente sigue el camino de "ya tenés una cuenta" y nada se finaliza sin `verifiedAt`; WAF con desafío silencioso sin SDK (documento `/signup` y `signup.*`), OAC en las Function URL y `X-Origin-Verify` en toda ruta, honeypot, rate limits por IP agregada (`/32`, `/64`), cuotas de emails de cuenta, estado de rebote y disyuntor de reputación; mundo de invitado aislado, una creación por cuenta, con cupo, TTL y cuotas por mundo en reloj real, que al destruirse se lleva sus objetos de S3 y los tokens de su dueño; solo datos sintéticos. Los roles internos siguen siendo por invitación.
- **Un solo flujo de alta** (ADR-0015 §1.4): sin lista de espera ni modos; el stage se despliega por primera vez recién con las olas 3 a 6 construidas y en verde, así que "Probar la demo" funciona desde el primer deploy. Un lead nace solo en `finalizeSignup`, con el email verificado. Con el cupo de mundos lleno, la cuenta y el lead existen igual y `account.ensureWorld`/`account.world` responden `CAPACITY` ("la demo está completa", "Probar de nuevo" y "Hablemos") sin crear mundo; el ingreso siguiente reintenta. `signup.start` conserva `RATE_LIMITED` y `CAPACITY` (cupo global de altas o disyuntor).
- **Leads**: tabla `Leads` separada de la demo, con lista cerrada de quién la toca (`Bff`, `SignupDispatch`, `WorldJanitor`, `LeadNotice`, `QaDriver` cercado, scripts del operador); dos consentimientos sin tildar y versionados (términos y privacidad, obligatorio; contacto de Craftech, opcional); aviso por SES solo a casillas `@craftech.io` del secreto `LeadNoticeTo` (nunca una dirección en el código); `leads:export`, `leads:optout`, `leads:delete`; todo lead es de un email verificado; los emails nunca van a logs, auditoría, métricas ni exports de la demo; Craftech es responsable (Ley 25.326).

## IDIOMAS

| Qué | Idioma |
|---|---|
| Código, identificadores, comentarios, commits, README, materiales de la submission | Inglés |
| `CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs, `tests/cases/`, agentes de `.claude/`, conversación con el operador | Español (Argentina) |
| Consola, textos y plantillas al importador | Español rioplatense, en `packages/bff/src/copy/es-AR.ts` |
| Emails al proveedor | Inglés, en `packages/bff/src/copy/en.ts` |

---

## STACK

| Capa | Elección |
|---|---|
| Monorepo | npm workspaces: `packages/{shared,bff,web,reader-contract,reader-mock,platform-mock}`, `infra/`, `scripts/`, `tests/` |
| Agente | Bedrock AgentCore Harness (`global.anthropic.claude-opus-5`, endpoint `live`), Gateway MCP `AWS_IAM` con 5 targets Lambda, Memory, Policy Cedar, Guardrails G1/G2 |
| Orquestación | SQS FIFO `OperationEvents.fifo` por operación; temporizadores `TIMER#` con EventBridge Scheduler; relojes de mundo en pausa por defecto; bus `Feeds` |
| Canales | SES v2 + receipt rules (`aws-cds-hackathon-poc-legajo-inbound`, DMARC `p=reject`); End User Messaging Social con modo `ChannelModes.whatsapp` |
| Datos | DynamoDB (una tabla por agregado), S3 |
| Consola | React 19 + Vite + Tailwind v4, tRPC v11, Cognito con login propio (SRP, tokens de 15 min) |
| Cuenta | `craftech-demos` 776805327629, `us-east-1`; profile `craftech-demos` en local; OIDC en CI |
| Stages | Solo `poc` (CI). Dominio `legajo.demo.craftech.io` (zona `Z043097217S4W7QWXU5O0`) |
| Tests | vitest (`U`, `LF`), Playwright (`UI`), ejecutor de escenarios en `poc` (`SR`) |

## CONVENCIONES

- Nombres lógicos SST en PascalCase e inglés; tags `Project=aws-cds-hackathon-poc-legajo`, `Stage`, `ManagedBy=sst`, `Owner=craftech`.
- Ramas cortas contra `main`; `main` deploya `poc`. Commits en inglés, imperativo.
- `GatewayTarget` en cadena de `dependsOn` con `ignoreChanges`; políticas Cedar: permits antes que forbids.
- CLI con el profile primero: `aws --profile craftech-demos <servicio> describe-...`.
- Un flujo nuevo o cambiado actualiza `docs/flows-catalog.md` y la matriz de `docs/test-plan.md` en el mismo PR (`npm run flows:check`).

## REUTILIZACIÓN

- Antes de escribir UI se revisa `packages/web/src/components/` (`Table`, `DataTable`, `SelectField`, `FilterPills`, `Drawer`, `Button`, `EmptyState`, `ApiErrorNotice`, `RemoteBlock`, `PageHeader`, `Section`, `StatTile`, `Badge`, `Callout`; `ScopeBar`, `ClockBanner` y `RuleChip(s)` llegan con WP-12, `docs/reuse-map.md`). Segunda aparición de un patrón = extracción a `components/`.
- Un cliente por servicio externo (Harness, SES, EUM Social, lector, plataforma, Scheduler) con timeouts, reintentos y mapeo de errores en un solo módulo.
- Toda tool pasa por `createToolHandler`; todo procedimiento tRPC por `firmProcedure` (y `brokerProcedure` / `recentLoginProcedure` donde corresponde).
- Un texto tiene una sola fuente en `copy/`; el seed y los tests importan de ahí.
- Sin código muerto. Antes del PR: `npm run lint` y `npm run lint:duplicates`.

## PRIORIDADES DE CALIDAD

1. Un prospecto entiende el producto con la landing y lo prueba solo; cualquiera lo levanta con el README, sin nosotros
2. Ninguna parte recibe un dato ajeno ni un mensaje fuera de política
3. Todo flujo probado según `docs/test-plan.md`
4. Consistencia antes que novedad; reusar antes que crear
5. Archivos chicos, una responsabilidad
6. Todo cambio de infra reproducible desde cero

---

## AGENTES

| Agente | Responsabilidad |
|---|---|
| `pm` | Planifica, delega por WP y reporta estado |
| `architect` | Documentación: `CONTEXT.md`, ADRs, arquitectura, catálogos, seed-spec, plan, pendientes, README |
| `devops` | SST, bootstrap, CI/OIDC, IAM, AgentCore y canales como recursos, secretos, costo |
| `typescript-dev` | Tools, turnos, canales, pipeline, política, mocks, BFF, consola, loader |
| `seed-generator` | Seed sintético, PDFs y verdad de base |
| `qa` | Casos, `QaDriver`, ejecutor de escenarios, flujos locales, verificación "100 % probada" |
| `security` | IAM, secretos, PII (incluidos los leads), identidad, contenido hostil, cerco, superficies públicas, reglas del concurso y marca |

**Regla de flujo.** `architect` documenta antes de implementar; `security` revisa la rama antes de mergear lo que toque IAM, secretos, canales, datos o superficies públicas; `qa` verifica antes de dar algo por hecho. Se revisa la rama, no el PR. La sesión del operador orquesta: no implementa, no opera, no deploya.

## FORMATO DE SALIDA

Directo, resultado primero, tablas antes que párrafos, sin repetir el pedido ni narrar el proceso. Diagramas ASCII en el chat; Mermaid solo en `docs/`.

## CÓMO LEER LOS DOCS

`python3 -m http.server 8099 --bind 127.0.0.1` y `http://localhost:8099/docs/viewer.html` (o la configuración `docs` de `.claude/launch.json`). El `--bind` importa: sin él la carpeta queda visible en la red local.
