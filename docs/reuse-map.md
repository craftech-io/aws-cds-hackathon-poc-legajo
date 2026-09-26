# Mapa de reuso del scaffolding interno

Referencia: repositorio interno de Craftech creado durante el período de la hackathon, commit `82d20b2` (checkout local del operador, solo lectura; no se versiona ni se nombra en este repo). ADR-0001 explica por qué se reusa. Decisiones:

- **Copiar**: el archivo entra igual, salvo el scope de paquete (`@<anterior>/*` → `@legajo/*`), el nombre del app y los comentarios que nombren el producto anterior.
- **Adaptar**: entra con los cambios que dice la columna; el WP dueño en `docs/build-plan.md`.
- **Descartar**: no entra. Todo lo específico del producto anterior (dominio, textos, marca, datos, investigación, adaptadores de canal que este producto no usa y su UI, flujos, casos de QA) se descarta y ningún archivo nuevo lo nombra. Las filas de abajo describen lo descartado de forma genérica cuando el nombre del archivo delataría el producto anterior.

Regla de verificación: después de cada WP que copie o adapte, `npm run lint:forbidden` (lista externa del operador, que incluye el nombre del producto anterior, su dominio, su scope de paquete y su cliente) tiene que dar cero coincidencias en el árbol, en los mensajes de commit, en los PDF generados, en el seed y en el build de la web. En CI falla cerrado: sin `FORBIDDEN_TERMS` el job falla (`docs/architecture.md` §18). Las coincidencias son por palabra completa, con mayúsculas y acentos para los nombres de varias palabras, así que el español corriente de los documentos no dispara falsos positivos.

## Raíz y configuración

| Ruta en la referencia | Decisión | Qué cambia / destino | WP |
|---|---|---|---|
| `package.json` | Adaptar | `name` `aws-cds-hackathon-poc-legajo`, descripción, scripts (`seed:generate`, `seed:validate`, `seed:load`, `scenarios`, `flows:check`, `reader:contract`, `tools:build-schemas`, `channels:check-modes`, `channels:whatsapp-templates`, `channels:waba-event-destination`, `lint:forbidden`, `console:invite`, `test:ui`; sin scripts de canales descartados; suma `lint:wp-ownership`, `tour:check`, `smoke:interim`); dependencias de raíz sin clientes de canales descartados ni de Knowledge Base | WP-01 |
| `package-lock.json` | Descartar | Se regenera | WP-01 |
| `tsconfig.json`, `tsconfig.infra.json` | Copiar | Alias `@legajo/*`; `include` suma `tests/` | WP-01 |
| `vitest.config.ts` | Adaptar | Suma `tests/flows/**` y los paquetes nuevos | WP-01 |
| `.gitignore`, `.editorconfig`, `.nvmrc` | Copiar | — | WP-01 |
| `sst.config.ts` | Adaptar | `PROJECT`, lista de módulos de `infra/` de `docs/build-plan.md` §1 | WP-01 |
| `sst-env.d.ts` (×3) | Descartar | Se generan vacíos y se commitean | WP-01 |
| `README.md` | Descartar | Se escribe de cero en inglés (architect, ola 6) | — |
| `CLAUDE.md` | Adaptar | Escrito por architect para este repo | hecho |
| `CONTEXT.md` | Descartar | Nuevo | hecho |

## `.claude/` y visor de docs

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `.claude/agents/{architect,devops,pm,qa,security,seed-generator,typescript-dev}.md` | Adaptar | Nombre del app, dominio (legajos, canales email y WhatsApp simulado), rutas de `docs/`, reglas de reuso; `qa` suma el ejecutor de escenarios; `seed-generator` suma PDFs y verdad de base | WP-01 |
| `.claude/agents/market-researcher.md` | Descartar | Sin fase de investigación | — |
| `.claude/skills/{domain-modeling,grilling,grill-with-docs}/**`, `.claude/skills/README.md` | Copiar | Se declaran en el README con su origen | WP-01 |
| `.claude/commands/docs.md`, `.claude/launch.json` | Copiar | — | WP-01 |
| `.claude/settings.json` | Adaptar | Lecturas permitidas: se quitan las de canales descartados; se suman `scheduler`, `sqs`, `events`, `socialmessaging`, `ses describe-active-receipt-rule-set`, `sesv2 get-account`, `service-quotas`, `ce list-cost-allocation-tags` | WP-01 |
| `docs/viewer.html` | Adaptar | Lista de archivos de `docs/` de este repo | WP-01 |
| `docs/**` (resto: catálogos, brief, investigación, manual, ADRs) | Descartar | Documentación nueva en este repo | hecho |

## `infra/`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `tags.ts` | Adaptar | `Project` | WP-02 |
| `ci.ts`, `ci-spec.ts`, `ci-spec.test.ts` | Adaptar | `CI_REPO`; mismas cercas de CloudFront y CSP | WP-02 |
| `secrets.ts`, `secrets.test.ts` | Adaptar | `SessionTokenKey`, `WabaId`, `WhatsAppPhoneNumberId`, `SeedOverrides` | WP-02 |
| `channel-flags.ts` | Adaptar → `channel-modes.ts` | `{ email: "live", whatsapp: "simulated" }` | WP-02 |
| `late-links.ts` | Copiar | — | WP-02 |
| `seed.ts` | Descartar | `SeedOverrides` pasa a `secrets.ts` | — |
| `dns.ts` | Adaptar | Dominio `legajo` (certificado de la consola); los registros de email (MX, MAIL FROM, DMARC) van en `messaging-email.ts` | WP-04 |
| `web.ts`, `web-spec.ts`, `web-spec.test.ts` | Adaptar | Rutas `/api/*` y `/u/*`; misma response headers policy del bootstrap | WP-04 |
| `storage.ts`, `storage-tables.ts`, `storage-buckets.ts`, `storage-keys.ts` (+ test) | Adaptar | Tablas y buckets de `docs/architecture.md` §5-§6; mismos helpers de bucket (nombre ≤ 16, lifecycle, TLS) | WP-06 |
| `storage-kb.ts` | Descartar | Sin Knowledge Base (ADR-0013) | — |
| `guardrail.ts`, `guardrail-policies.ts` (+ test) | Adaptar | Temas denegados, PII y grounding de `docs/design-brief.md` §5.5 | WP-09 |
| `policy.ts` | Copiar | Mismo orden permits → forbids | WP-09 |
| `policy-rules.ts` (+ test) | Adaptar | Statements `CED-*` de este repo, 5 targets | WP-09 |
| `auth.ts`, `auth-email.ts` (+ test) | Adaptar | Grupos `BROKER`/`ANALYST`, `custom:firmId`, marca; tokens de 15 min se conservan | WP-11 |
| `messaging-email.ts`, `messaging-email-spec.ts` (+ test) | Adaptar | Rule set `aws-cds-hackathon-poc-legajo-inbound`, reglas `ops-poc`/`sim-poc`, configuration sets `aws-cds-hackathon-poc-legajo-email-poc`/`…-sim-poc`, MAIL FROM `bounce.`, DMARC `p=reject` en `_dmarc.legajo.…` y `_dmarc.sim.legajo.…`, sin contact list ni topics, `SimMail` | WP-18 |
| `messaging-whatsapp.ts` | Adaptar | Deja de estar comentado: topic `aws-cds-hackathon-poc-legajo-wa-inbound`, `InboundWhatsApp`, secretos; sin feature flag | WP-21 |
| Módulo de infra del canal descartado | Descartar | Este producto no tiene ese canal | — |
| `agent-tool-schemas.ts` | Copiar | — | WP-22 |
| `agent-tools.ts` | Adaptar | 5 targets | WP-23 |
| `agentcore.ts`, `agentcore-spec.ts` (+ test), `agentcore-iam.ts` | Adaptar | Nombres, límites, 3 estrategias de Memory, sin `inline_function`; mismo log group `live` antes del endpoint | WP-23 |
| `agent-prompts.ts` | Descartar | El prompt vive en `packages/bff/src/agent/system-prompt.ts` | — |
| `scheduler.ts` | Adaptar | Grupo `…-schedules`, destino `ScheduleDispatch` | WP-24 |
| `workflows.ts`, `workflows-spec.ts` (+ test) | Descartar | Sin Step Functions (ADR-0004); la lección del `Timeout` queda en `docs/architecture.md` §16 | — |
| `bff.ts` | Adaptar | Sin proxy del Harness; suma `PublicWeb`, `QaDriver`, `PolicyAudit` | WP-32 |
| `observability.ts`, `observability-spec.ts` (+ test) | Adaptar | Métricas `LegajoAgent/*` y alarmas de `docs/architecture.md` §12; se conservan filtros sobre `fn.nodes.logGroup` y la alarma de rebote de SES | WP-32 |
| `bootstrap/ci-role.yaml`, `ci-role.test.ts`, `README.md` | Adaptar | Defaults: `AppName`, `BucketPrefix` (`aws-cds-hackathon-poc-leg`, recalculado por el test), `AppDomain` `legajo.demo.craftech.io`, `AgentNamePrefix`, `GitHubRepo`. Además de los defaults, el template tiene **literales** del producto anterior que se reemplazan uno por uno: la tabla de enrutamiento de entrada (se elimina: no hay stage `local`), el bucket de correo entrante (→ `aws-cds-hackathon-poc-leg-inbound-mail-776805327629` y `/*`), los configuration sets de email y de simulador (→ `aws-cds-hackathon-poc-legajo-email-*` y `…-sim-*`), el topic de WhatsApp (→ `aws-cds-hackathon-poc-legajo-wa-inbound`), el rule set (→ `aws-cds-hackathon-poc-legajo-inbound`); se eliminan el contact list y los topics y statements de canales descartados, de SMS/voz y de S3 Vectors/Knowledge Base. Se suman: el rol `qa-runner`; `job_workflow_ref` en los dos trusts; SQS FIFO; `events:CreateEventBus/DeleteEventBus/TagResource` sobre `event-bus/aws-cds-hackathon-poc-legajo-*`; `lambda:CreateFunctionUrlConfig`/`AddPermission` con `lambda:FunctionUrlAuthType`; `social-messaging` cercado; el presupuesto del proyecto y el plan de GuardDuty Malware Protection cercados. Misma response headers policy y KVS. Presupuesto de tamaño: el template de referencia ocupa 50.747 de los 51.200 bytes; los comentarios pasan a `README.md`, que también declara los riesgos residuales (receipt rules sin cerca por recurso, mitigado por el prechequeo del paso 0). `ci-role.test.ts` asierta < 51.200 bytes, < 6.144 caracteres por política administrada y que cada nombre fijo de `docs/architecture.md` §1 está cubierto por un statement con su ARN exacto | WP-03 |

## `.github/workflows/`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `ci.yml` | Adaptar | Checks de `docs/architecture.md` §18 | WP-03 |
| `deploy.yml` | Adaptar | Sin el smoke del canal descartado; prechequeo del rule set activo; build de la web y `lint:forbidden -- --dist`; asume `qa-runner` para `SC-00` | WP-03, WP-40 |
| — | Nuevo | `scenarios.yml` | WP-03, WP-40 |

## `packages/shared`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `dates.ts`, `hash.ts`, `errors.ts` (+ tests) | Copiar | Códigos de error de `docs/tool-catalog.md` | WP-05 |
| `caller.ts` (+ test) | Adaptar | `kind` `WORKER`, `CHANNEL`, `CONSOLE`, `QA`, `SCHEDULER` | WP-05 |
| `ids.ts` (+ test) | Adaptar | Prefijos de `docs/seed-spec.md` §2 | WP-05 |
| `document-keys.ts` | Adaptar | Claves de `Documents`, `Uploads`, `Media` | WP-05 |
| `flows.ts` (+ test) | Adaptar | Formato `FL-XXX` | WP-05 |
| `enums*.ts`, `policy-rules.ts`, `money.ts`, `countries.ts` | Descartar | Enums nuevos (`CP-*`, `CED-*`, `LAM-*`) | WP-05 |

## `packages/bff/src`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `lib/{clients,crypto,retry,resource,deadline}.ts` (+ tests) | Copiar | — | WP-07, WP-13 |
| `lib/log.ts` (+ test) | Adaptar | Suma redacción de CBU/CVU y DNI | WP-13 |
| `lib/clock.ts` | Adaptar | Relojes por mundo (`worldClock(clockId)`) | WP-13 |
| `lib/secrets.ts` | Adaptar | `SECRET_NAMES` de este repo | WP-13 |
| `auth/{jwt,testing,errors,config}.ts` (+ tests) | Copiar | — | WP-14 |
| `auth/{principal,staff,totp}.ts` | Adaptar | Principal `{sub, brokerId, firmId, role}`; TOTP opcional; login reciente para aprobar | WP-14 |
| `auth-triggers/**` | Adaptar | Pre-token con `firmId` y rol | WP-14 |
| `routers/{trpc,handler,deps,index}.ts` | Adaptar | `firmProcedure`, `brokerProcedure`, `recentLoginProcedure` | WP-14 |
| `routers/**` (resto) | Descartar | Routers nuevos | — |
| `agent/harness-client.ts` (+ test) | Adaptar | Endpoint `live`, `runtimeSessionId` por operación, `actorId` del importador | WP-28 |
| `agent-proxy/**` | Descartar | La consola no invoca el Harness | — |
| `channels/{adapter,normalizer,registry}.ts` (+ tests) | Adaptar | Sobre de `docs/design-brief.md` §5.2; registro por modo | WP-19 |
| `channels/email/{mime,thread,receipt,storage,validate,events,inbound,outbound}.ts` (+ tests) | Adaptar | Dirección de la operación, remitente registrado, encabezados `X-Legajo-*`, dominios reservados | WP-19 |
| `channels/email/{content,branded,config,adapter}.ts` | Adaptar | Marca y textos | WP-19 |
| `channels/email/fixtures/**` | Adaptar | Se reescriben con los dominios de este repo; se descartan los que nombran flujos anteriores | WP-19 |
| `channels/whatsapp/**` (+ fixtures) | Adaptar | Suma `SimulatedWhatsAppTransport`, nonces y ruteo por operación; plantillas nuevas; fixtures con la forma real de EUM Social | WP-20 |
| Adaptador del canal descartado (`channels/<canal>/**`) | Descartar | — | — |
| `inbound/{envelope,identity,gate,limits,keywords,routing,record,audit,media,metrics}.ts` | Adaptar | Pasan a `channels/*` y `handlers/*` de este repo | WP-19, WP-20, WP-29 |
| `inbound/{turn,harness,harness-stream,process}.ts` | Adaptar | Base de `turns/` y `worker/` | WP-28 |
| `inbound/{approval-workflow,direct-reply,transcribe-client,postbacks,channel-effects}.ts` y el entrante del canal descartado | Descartar | Sin aprobación por workflow, sin respuestas directas (ADR-0011), sin audio | — |
| `outbound/{pipeline,checks,grounding,facts,text,persist,port,deps,types,metrics}.ts` (+ tests) | Adaptar | Política `CP-*`, verificación de idioma y datos sensibles | WP-25 |
| `outbound/recipient.ts` | Adaptar → `recipient-fence.ts` | Cerco de este repo con dominios reservados | WP-25 |
| `outbound/render/{ses,whatsapp}.ts` (+ tests) | Adaptar | Plantillas y encabezados nuevos | WP-25 |
| `outbound/{documents,postbacks}.ts` y el render del canal descartado | Descartar | — | — |
| `policy/{engine,result,types,context,counters,windows,check,kinds,reasons,params}.ts` (+ tests) | Adaptar | Reglas `CP-*` y orden de `docs/design-brief.md` §5.7 | WP-17 |
| `policy/rules/**`, `policy/alternative.ts` | Descartar | Reglas nuevas | — |
| `connector/{ports,ports-agent,index,keys,table-client}.ts`, `connector/dynamo/{client,expressions,repo}.ts`, `connector/memory/**` (+ tests) | Adaptar | Puertos de este dominio | WP-07 |
| `connector/dynamo/*` (por tabla), `connector/{fixtures,seed-schemas}.ts` | Descartar | Nuevos por tabla | — |
| `agent-tools/common/{build-schemas,scope}.ts` y el wrapper (+ tests) | Adaptar | Sesión de operación; sin adjuntos de sesión | WP-22 |
| `agent-tools/**` (targets) | Descartar | Targets nuevos | — |
| `services/{session,verify-identity,ratecard}.ts` (+ tests) | Adaptar | Sesión de operación; identidad por teléfono y por remitente | WP-13, WP-19 |
| `services/business-days.ts` (+ test) | Adaptar → `business-hours.ts` | Horario por zona IANA y feriados AR | WP-13 |
| `services/pdf.ts` | Adaptar → `scripts/seed/lib/pdf.ts` | Documentos comerciales sintéticos con `LegajoDocId` | WP-08 |
| `services/**` (resto) | Descartar | — | — |
| `copy/{helpers,types,forbidden,buttons}.ts` | Adaptar | Textos de este repo | WP-10 |
| `copy/**` (resto) | Descartar | Textos nuevos | — |
| `public-web/{handler,http,html,links,audit}.ts` | Adaptar | Página de carga | WP-38 |
| `public-web/{pages,webhook,tools}.ts` y `pages/**` | Descartar | — | — |
| `domain/{common,audit,runtime}.ts` | Adaptar | Entidades de este repo | WP-07 |
| `domain/**` (resto), `workflows/**` | Descartar | — | — |

## `packages/web`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `src/components/{Table,DataTable,table-parts,SelectField,FilterPills,Drawer,Button,Badge,Callout,EmptyState,ApiErrorNotice,RemoteBlock,PageHeader,Section,StatTile,Chart,chart-geometry,FullScreenMessage,form-classes}.*` (+ tests) | Copiar | — | WP-12 |
| `src/components/{ScopeBar,ClockBanner,RuleChip,RuleChips}.tsx`, `layout/AppShell.tsx` | Adaptar | Estudio y rango de ETA; reloj del mundo; reglas `CP-*`; navegación de §6 del brief | WP-12 |
| `src/components/brand/**` | Adaptar | "Legajo listo · Powered by Craftech" | WP-12 |
| `src/components/MoneyText.tsx` | Descartar | — | — |
| `src/lib/{http,trpc,trpc-router,api-error,use-remote,router,match-path,env,local-datetime,format,auth-claims}.ts` y `lib/auth/**` (+ tests) | Copiar / adaptar | `auth-claims` con `firmId` y rol; `format` sin monedas del producto anterior | WP-12 |
| `src/lib/{stream,hardship,use-administration,use-scope-period}.ts` | Descartar / adaptar | `use-administration` → `use-firm` | WP-12 |
| `src/context/SessionContext.tsx` | Copiar | — | WP-12 |
| `src/context/AdminContext.tsx` | Adaptar → `FirmContext.tsx` | — | WP-12 |
| `src/views/login/**` | Adaptar | Textos | WP-12 |
| `src/views/landing/{Lightbox,gallery,MediaFigure}.tsx` | Copiar | — | WP-36 |
| `src/views/landing/{LandingView,Sections,DemoScenes,scenes,copy,media,conversations}.*` y el componente de teléfono del prototipo anterior | Adaptar | Historia de este producto; el teléfono pasa a `WhatsAppPhone` | WP-36 |
| `src/views/**` (resto) | Descartar | Vistas nuevas | — |
| `src/copy/**` | Adaptar | Textos de la consola | WP-12 |
| `public/brand/logo-craftech-*` | Copiar | — | WP-12 |
| `public/brand/**` (resto), `public/landing/**` | Descartar | Marca y capturas nuevas | — |
| `public/legal/*.html` | Adaptar | Legales de esta demo | WP-36 |
| `e2e/support/**`, `e2e/playwright.config.ts`, `e2e/tsconfig.json` | Copiar / adaptar | Clave efímera, sesiones por rol, trazas apagadas por defecto | WP-12 |
| `e2e/*.spec.ts` | Descartar | Specs nuevos | — |
| `index.html`, `vite.config.ts`, `tsconfig.json` | Adaptar | Título y marca | WP-12 |

## `scripts/` y `tests/`

| Ruta | Decisión | Qué cambia | WP |
|---|---|---|---|
| `scripts/lint/{max-lines,duplicates,typecheck-infra}.ts` | Copiar | `ALLOWED` vacío al empezar | WP-01 |
| `scripts/channels/cli-args.ts` (+ test) | Copiar | — | WP-03 |
| `scripts/channels/ingress-route.ts` (+ test) | Descartar | Sin stage `local` no hay enrutamiento de entrada | — |
| `scripts/channels/check-flags.ts` (+ test) | Adaptar → `check-modes.ts` | Modos y P-01 | WP-03 |
| Scripts y assets del canal descartado | Descartar | — | — |
| `scripts/seed/generate/{rng,hashing,writer,time,context}.ts` | Adaptar | Semilla `20260925` | WP-08 |
| `scripts/seed/validate/{run,load,conformance}.ts`, `scripts/seed/lib/{tables,conformance,text}.ts` | Adaptar | Invariantes de `docs/seed-spec.md` §15 | WP-08 |
| `scripts/seed/load/**`, `scripts/seed/load.ts` | Adaptar | Huella, overrides desde el secreto, relojes y schedules | WP-31 |
| `scripts/seed/**` (resto: generadores, datos, documentos, media, flujos) | Descartar | — | — |
| `scripts/seed/build-flow-catalog.ts`, `scripts/seed/flows/catalog.ts` | Adaptar → `scripts/flows/check.ts` | Parser de `docs/flows-catalog.md` y de la matriz de `docs/test-plan.md` | WP-03 |
| `scripts/smoke/lib/{http,report,stage,cli,guards,probes,console-checks,email-checks}.ts` (+ tests) | Adaptar → `scripts/scenarios/lib/` | Base del ejecutor | WP-37 |
| `scripts/smoke/{email,console,cases}.ts`, `scripts/smoke/lib/{messages,conversations,recipients}.ts` y los checks del canal descartado | Descartar | Reemplazados por escenarios; `scripts/smoke/interim.ts` es nuevo (WP-03) | — |
| `scripts/landing/{capture-console,console-server,console-world,render-visuals}.ts`, `captures.json` | Adaptar | Capturas de este producto; `console-server` es la base de `tests/ui-server/` | WP-33, WP-36 |
| Muestras del canal descartado para la landing | Descartar | — | — |
| `tests/cases/**` | Descartar | Casos nuevos (`FL-XXX.md`) | WP-42 |
