# Plan de construcción · aws-cds-hackathon-poc-legajo

Paquetes de trabajo (WP) para construir con agentes en paralelo. Deriva de `docs/design-brief.md`, `docs/architecture.md`, `docs/architecture-integrations.md`, `docs/tool-catalog.md`, `docs/flows-catalog.md`, `docs/seed-spec.md` y `docs/test-plan.md`, y del mapa de reuso `docs/reuse-map.md`.

Reglas del plan:

- Cada WP tiene **un** agente dueño (`devops`, `typescript-dev`, `seed-generator` o `qa`) y una lista **exacta** de archivos y directorios que solo él toca durante su ola. **Dos WP de la misma ola nunca comparten un archivo**: `npm run lint:wp-ownership` (`scripts/lint/wp-ownership.ts`) parsea las listas de este documento y falla si dos WP de una ola se superponen. Un WP puede leer cualquier cosa.
- Entre olas hay dependencia: una ola arranca cuando la anterior está mergeada a `main`, desplegada por CI y con su smoke en verde: el interino (`scripts/smoke/interim.ts`: `curl` de `/` y `/api/health` y `describe` de lo que ya existe) hasta que exista `SC-00` (WP-37), `SC-00` después. El estado de cada ola se declara en §5 y lo verifica `npm run lint`.
- Cada WP entra en una sesión de un agente: si un WP no cierra en una sesión, se parte en la ola siguiente, no se estira.
- Un WP de infra que apunta a un handler que todavía no existe crea ese archivo con un **stub** que devuelve `UNAVAILABLE`; el WP dueño del código lo reemplaza en su ola.
- `security` revisa la rama al cierre de cada ola (lo que toque IAM, secretos, canales, datos o superficies públicas); `qa` verifica los criterios de aceptación antes de dar un WP por hecho. Ninguna ola se mergea sin las dos.
- Todo WP escribe los tests unitarios de lo que produce, con los nombres de archivo que cita `docs/flows-catalog.md` y la etiqueta `[FL-xxx]` en cada `describe`/`it` que prueba un flujo.
- No hay stage `local`: todo se prueba con `U`, `LF` y `UI` en la máquina y en `poc` por CI (`docs/architecture.md` §2).

## 1. Estructura del monorepo

```
.
├── CLAUDE.md · CONTEXT.md · README.md
├── package.json · package-lock.json · tsconfig.json · tsconfig.infra.json · vitest.config.ts · .nvmrc
├── sst.config.ts · sst-env.d.ts (commiteado; vacío hasta el primer deploy)
├── .github/workflows/{ci,deploy,scenarios}.yml
├── .claude/{agents,skills,commands}/ · .claude/{settings,launch}.json
├── infra/
│   ├── tags.ts · ci.ts · ci-spec.ts · secrets.ts · channel-modes.ts · late-links.ts · iam-capabilities.ts · dns.ts · web.ts · web-spec.ts
│   ├── storage.ts · storage-tables.ts · storage-buckets.ts · storage-keys.ts · malware.ts
│   ├── guardrail.ts · guardrail-policies.ts · policy.ts · policy-rules.ts · auth.ts · auth-email.ts
│   ├── messaging-email.ts · messaging-email-spec.ts · messaging-whatsapp.ts · mocks.ts · feeds.ts
│   ├── agent-tool-schemas.ts · agent-tools.ts · agentcore.ts · agentcore-spec.ts · agentcore-iam.ts
│   ├── operations.ts · scheduler.ts · bff.ts · observability.ts · observability-spec.ts
│   ├── *-spec.test.ts, *-policies.test.ts, policy-rules.test.ts, secrets.test.ts, storage-keys.test.ts, iam-capabilities.test.ts, mocks-spec.test.ts (tests de infra sin cuenta)
│   └── bootstrap/{ci-role.yaml, ci-role.test.ts, README.md}
├── packages/
│   ├── shared/src/                 enums, ids, errors, caller, flows, dates
│   ├── reader-contract/            openapi.yaml + src/schemas.ts (zod)
│   ├── reader-mock/src/            handler, catalog, faults
│   ├── platform-mock/src/          handler, events
│   ├── bff/src/
│   │   ├── lib/ · copy/ · domain/ · connector/ · services/ · auth/ · auth-triggers/
│   │   ├── policy/ · outbound/ · channels/{adapter,normalizer,registry,rate-limit}.ts · channels/email/ · channels/whatsapp/
│   │   ├── reader/ · intake/ · timers/ · milestones/ · clock/ · escalations/ · agent/ · turns/ · worker/ · feeds/
│   │   ├── agent-tools/{common,operations,documents,messaging,followups,handoff}/
│   │   ├── services/{consent,contacts,dossier-actions,conversation-control,operations-admin}/
│   │   ├── handlers/ (entradas Lambda finas) · sim-mail/ · public-web/ · worlds/ · qa-driver/ · metrics/ · policy-audit/
│   │   └── routers/
│   └── web/
│       ├── src/{main.tsx,app.tsx,routes.ts,console-routes.tsx,index.css} · lib/ · context/ · components/
│       ├── src/views/{login,landing,operations,dossier,escalations,registry,clock,simulator,mailbox,metrics,audit,tour}/
│       ├── public/{brand,landing,legal}/
│       └── e2e/ (Playwright)
├── scripts/
│   ├── lint/{max-lines,duplicates,typecheck-infra,forbidden-terms,wp-ownership,no-intl,wave-status}.ts · flows/check.ts · reader/contract-check.ts · tour/{check,timeline}.ts
│   ├── channels/{check-modes,whatsapp-templates,waba-event-destination}.ts · console/invite.ts · smoke/interim.ts · metrics/batch-local.ts
│   ├── seed/{generate.ts,generate/,validate.ts,validate/,load.ts,load/,lib/,data/,pdfs/,overrides.example.json,__tests__/}
│   ├── scenarios/{run.ts,lib/,sc-00-smoke.ts … sc-24-judge.ts,load-light.ts}
│   └── landing/ (capturas de la landing)
├── tests/
│   ├── flows/ (LF) · flows/support/{world.ts,scripted-harness.ts,fakes/}
│   ├── ui-server/ (servidor local de Playwright: Vite + appRouter + PublicWeb + emulador de S3)
│   └── cases/ (qa)
└── docs/ (architect)
```

Notas que cruzan todas las olas (heredadas del scaffolding):

1. `sst-env.d.ts` se commitea (raíz, `packages/bff/`, `packages/web/`) y está vacío hasta el primer deploy: el código lee recursos linkeados con `readLinked(nombre, zod)` y secretos con `secretValue(nombre)`; después de cada deploy que cambie links se commitea el archivo regenerado.
2. `module: ESNext` + `moduleResolution: Bundler`; `npm run typecheck` = raíz + infra (`scripts/lint/typecheck-infra.ts`) + cada paquete.
3. Todos los `sst.Secret` se declaran una sola vez en `infra/secrets.ts`.
4. El rol de CI y el de QA no los crea SST (ADR-0009).
5. **Todas las dependencias** de todos los paquetes se declaran en la ola 0 (WP-01), con versión estable verificada (incluidas las de desarrollo: extractor de texto de PDF para `lint:forbidden`, parser de direcciones RFC 5322, parser acotado de PDF del lector); agregar una después exige que el WP la pida y que la integración de la ola la sume (`package.json`/`package-lock.json` son de WP-01 y, al cierre de cada ola, del integrador `devops`).
6. Ninguna Lambda lee `process.env` salvo `STAGE` y `NODE_ENV`; toda llamada externa lleva timeout y reintento; ningún archivo TS/TSX pasa 400 líneas.
7. `packages/web/src/components/**`, `packages/web/e2e/support/**` y las claves compartidas de `copy/` se congelan al cierre de la ola 4; en la ola 5 cada vista tiene su propio archivo de textos (`views/<vista>/copy.ts`) y un componente compartido nuevo se pide al integrador, no se agrega desde una vista.

## 2. Paquetes de trabajo

Formato: **id · título** — dueño · depende de. Objetivo · Archivos · Aceptación · Tests.

### Ola 0 · Scaffold desde el scaffolding interno

**WP-01 · Raíz del monorepo, paquetes vacíos y agentes** — devops · —
Objetivo: repo que instala, tipa y testea, copiado y adaptado según `docs/reuse-map.md`. Archivos: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.infra.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.nvmrc` (Node exacto; también en `engines`), `sst.config.ts` (app `aws-cds-hackathon-poc-legajo`, solo stage `poc`, cualquier otro stage falla con mensaje, providers pinneados, importa todos los módulos de `infra/` de §1 en orden), `sst-env.d.ts` ×3, `packages/{shared,bff,web,reader-contract,reader-mock,platform-mock}/{package.json,tsconfig.json}`, `scripts/lint/{max-lines,duplicates,typecheck-infra,no-intl}.ts`, `.claude/**`, `docs/viewer.html`. Aceptación: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run lint:duplicates`, `npm test` en verde; `sst.config.ts` rechaza un stage distinto de `poc`. Tests: los de `scripts/lint/` copiados, `no-intl.test.ts`.

**WP-02 · Esqueleto de `infra/`, tags, secretos, modos de canal, capacidades IAM y cercas de CI** — devops · WP-01
Objetivo: todos los módulos de `infra/` existen con exports tipados para que ninguna ola cree archivos de infra nuevos. Archivos: `infra/tags.ts`, `infra/ci.ts`, `infra/ci-spec.ts`, `infra/ci-spec.test.ts`, `infra/secrets.ts`, `infra/secrets.test.ts`, `infra/channel-modes.ts` (`{ email: "live", whatsapp: "simulated" }`), `infra/late-links.ts`, `infra/iam-capabilities.ts` (capacidades por Lambda de `docs/architecture.md` §14) + `infra/iam-capabilities.test.ts`, y stubs de todos los demás módulos de `infra/` de §1 **salvo `dns.ts`, `web.ts` y `web-spec.ts`**, que crea WP-04 (cada stub solo exporta, sin recursos). Aceptación: el primer deploy de `poc` por CI crea solo los Linkables; `$transform` estampa path y boundary; nombres de CloudFront fijados; el test de capacidades compara contra las políticas que generan los stubs. Tests: `ci-spec.test.ts`, `secrets.test.ts`, `iam-capabilities.test.ts` (incluye la capacidad `WORLDS` con sus `LeadingKeys` por rol, y los permisos de DLQ y de historial de alarma del `QaDriver`).

**WP-03 · Bootstrap de CI, workflows y checks** — devops · WP-01
Objetivo: rol de deploy, rol `qa-runner`, boundary, KVS del Router y response headers policy en un template; CI reproducible. Archivos: `infra/bootstrap/{ci-role.yaml,ci-role.test.ts,README.md}`, `.github/workflows/{ci,deploy,scenarios}.yml` (pasos que dependen de scripts todavía inexistentes imprimen aviso y pasan, salvo `lint:forbidden`), `scripts/channels/{check-modes,cli-args}.ts` + tests, `scripts/lint/forbidden-terms.ts` + `.test.ts`, `scripts/lint/wp-ownership.ts` + `.test.ts`, `scripts/flows/check.ts` + `.test.ts`, `scripts/smoke/interim.ts` + `.test.ts`. Aceptación: template < 51.200 bytes y cada política < 6.144 caracteres; trust con `sub` en sus dos formas + claims numéricos + `job_workflow_ref` (deploy: `deploy.yml`; `qa-runner`: `deploy.yml` y `scenarios.yml`); cada nombre fijo de `docs/architecture.md` §1 cubierto por un statement con su ARN exacto; statements de `events:CreateEventBus/DeleteEventBus/TagResource` sobre `event-bus/aws-cds-hackathon-poc-legajo-*`, `lambda:CreateFunctionUrlConfig`/`AddPermission` con `lambda:FunctionUrlAuthType`, presupuesto del proyecto y plan de GuardDuty Malware Protection cercados; riesgos residuales declarados en `README.md`; `qa-runner` solo invoca la función `…-poc-qa-driver`; un PR con `*.local.json` falla; un PR con `whatsapp: "live"` falla; `flows:check` falla si un flujo no tiene fila en la matriz o si un test citado no lleva su etiqueta; `lint:wp-ownership` falla con dos WP de una ola sobre el mismo archivo; `lint:forbidden` cubre árbol, `git log --format=%B`, texto y metadatos de PDF, seed y `--dist`, coincide por palabra completa con banderas por término, **falla con `CI=true` y `FORBIDDEN_TERMS` vacío** y nunca imprime el término; `npm run lint:forbidden` en verde con la lista del operador (ningún archivo nombra el producto anterior). Tests: los seis `.test.ts` (el de términos incluye el falso positivo "al día siguiente" y la falla cerrada).

**WP-04 · Dominio y shell web de infra** — devops · WP-02
Objetivo: `legajo.demo.craftech.io` sirve una StaticSite vacía con cabeceras de seguridad. Archivos: `infra/dns.ts`, `infra/web.ts`, `infra/web-spec.ts`, `infra/web-spec.test.ts`. Aceptación: tras el primer deploy, `curl -I https://legajo.demo.craftech.io` → 200 con CSP, HSTS, `X-Frame-Options DENY`; certificado validado en la zona `demo.craftech.io`; rutas `/api/*` y `/u/*` reservadas. Tests: `web-spec.test.ts`.

Cierre de la ola 0: operador aplica el bootstrap y carga secretos (`docs/architecture.md` §15 pasos 0-3, con la compuerta de SES del paso 0); merge a `main`; primer deploy verde con el smoke interino.

### Ola 1 · Cimientos (paralela)

**WP-05 · `packages/shared`** — typescript-dev · WP-01
Objetivo: enums, ids y tipos únicos. Archivos: `packages/shared/src/**`. Aceptación: exporta como zod + tipos todo lo de `docs/tool-catalog.md` "Tipos compartidos", `DossierStatus`, `EscalationReason`, `TurnTrigger`, `TimerKind`, `ClockMode`, `ObservationCode`, `SupplierBehaviour`, `ChannelMode`, `Caller`, ids con prefijo, `EventId` (`evt_` + 26 base32 Crockford o `qa-<40 hex>`, con el derivado de `docs/architecture.md` §7) y el vocabulario fijo de `docs/tool-catalog.md` (`rules.ts`, `tools.ts`, `clock-ids.ts`, `addresses.ts`, `document-keys.ts`). Tests: `enums.test.ts` (snapshots), `ids.test.ts`.

**WP-06 · Storage: tablas, buckets y escaneo** — devops · WP-02
Objetivo: tablas y buckets de `docs/architecture.md` §5-§6 (salvo las tablas de los mocks, que son de WP-21). Archivos: `infra/storage.ts`, `infra/storage-tables.ts`, `infra/storage-buckets.ts`, `infra/storage-keys.ts`, `infra/storage-keys.test.ts`, `infra/malware.ts`. Aceptación: claves, GSIs y TTL (`expiresAt`, también en `Parties`) exactamente como §5; bucket de correo con nombre fijo `aws-cds-hackathon-poc-leg-inbound-mail-776805327629`; buckets ≤ 16 caracteres de nombre lógico, privados, TLS obligatorio, lifecycle (incluido `qa/`); CORS de `Uploads` y `Media`; GuardDuty Malware Protection for S3 sobre `Uploads` y `Media` (o, si el provider pinneado no lo modela, el riesgo residual declarado en `docs/architecture.md` §13). Tests: `storage-keys.test.ts` (incluye CORS); `qa` compara `describe-table` con §5 tras el deploy.

**WP-07 · Dominio zod y conector** — typescript-dev · WP-05, WP-06
Objetivo: puerto `Connector` con adaptador DynamoDB y adaptador en memoria. Archivos: `packages/bff/src/domain/**`, `packages/bff/src/connector/**`, `packages/bff/src/lib/{resource,retry,clients,deadline}.ts`. Aceptación: métodos por caso de uso (operaciones, documentos, versiones, observaciones, temporizadores, partes con `ADDR#` condicional, contactos, conversaciones, bitácora, runtime con `OPSTATE`, leases y tumbas, métricas); escrituras condicionales por `version`; historias con fecha en consentimiento, autorización, contacto y control; ninguna tool importará `@aws-sdk/lib-dynamodb`. Tests: `connector/memory/*.test.ts`, `connector/dynamo/{expressions,parties,operations}.test.ts`.

**WP-09 · Guardrails G1/G2 y Cedar** — devops · WP-02, WP-13
Objetivo: guardrails versionados y políticas Cedar. Archivos: `infra/guardrail.ts`, `infra/guardrail-policies.ts`, `infra/guardrail-policies.test.ts`, `infra/policy.ts`, `infra/policy-rules.ts`, `infra/policy-rules.test.ts`. Aceptación: G1 con los cinco temas denegados (definición y ejemplos es/en), prompt attack `HIGH`, PII según `docs/design-brief.md` §5.5 con las regex importadas de `packages/bff/src/lib/mask.ts` (sin copias); un test verifica que ningún fixture normalizado dispara una regex de G1; G2 grounding 0,75 y relevance 0,5; Cedar con permits por target antes que forbids, forbids con `dependsOn` de todos los permits, cada statement < 10.000 caracteres calificado con el ARN del Gateway, todo campo citado presente en el schema generado y protegido con `has`, `CED-KILL-SWITCH` desactivado. Tests: los dos `.test.ts` (tamaño, orden, campos y guardas `has`).

**WP-10 · Textos y plantillas** — typescript-dev · WP-05
Objetivo: una sola fuente de textos. Archivos: `packages/bff/src/copy/**` (`es-AR.ts` con `guardrailRefusal`, que solo se usa para responder a un mensaje del importador bloqueado; no hay texto de rechazo para proveedores porque un bloqueo de origen proveedor no responde, `en.ts`, `en-supplier-sim.ts` con los dos cuerpos de `INJECTION`, `en-gloss.ts`, `templates.ts` con las 8 plantillas de `docs/architecture-integrations.md` §4.3, `buttons.ts`, `consent.ts`, `dispatch-glossary.ts`, `observation-labels.ts`, `forbidden.ts`). Aceptación: botones ≤ 25 caracteres (plantilla) y ≤ 20 (interactivos); ninguna plantilla empieza ni termina con parámetro; ningún texto pide datos sensibles; toda plantilla y texto fijo tiene glosa en inglés. Tests: `copy.test.ts`.

**WP-11 · Cognito y emails de autenticación** — devops · WP-02
Objetivo: user pool de la consola. Archivos: `infra/auth.ts`, `infra/auth-email.ts`, `infra/auth-email.test.ts`. Aceptación: sin auto-registro; grupos `BROKER`/`ANALYST`/`JUDGE`; `custom:firmId`; cliente SRP sin hosted UI; tokens de 15 min, refresh 12 h; MFA TOTP opcional; invitaciones con la marca "Legajo listo" por SES. Tests: `auth-email.test.ts`.

**WP-12 · Shell de la consola y login** — typescript-dev · WP-05
Objetivo: consola vacía con login propio, rutas de todas las vistas con placeholders y componentes compartidos. Archivos: `packages/web/{index.html,vite.config.ts}`, `packages/web/src/{main.tsx,app.tsx,routes.ts,console-routes.tsx,index.css,vite-env.d.ts}`, `packages/web/src/{lib,context,components}/**` (incluye la barra de hora simulada y el sondeo de actualización), `packages/web/src/views/login/**`, un `View.tsx` placeholder por vista de §1 (lo reemplaza su WP), `packages/web/public/brand/**`, `packages/web/e2e/{playwright.config.ts,tsconfig.json,support/**,login.spec.ts}`. Aceptación: `npm run build -w packages/web`; tema Tailwind propio sin hex en JSX; "Legajo listo · Powered by Craftech"; tokens solo en `sessionStorage`; `login.spec.ts` corre contra Vite con el mock de ruta de `cognito-idp` (`docs/test-plan.md` §2) sin servidor de UI, e incluye la variante `JUDGE`. Tests: `lib/*.test.ts`, `login.spec.ts`.

**WP-13 · Núcleo: log, enmascarado, reloj, crypto, secretos, horarios** — typescript-dev · WP-05
Objetivo: lo que todo módulo comparte y no toca un SDK de canal. Archivos: `packages/bff/src/lib/{log,mask,clock,crypto,secrets}.ts`, `packages/bff/src/services/{business-hours,holidays,session,ratecard,language}.ts`. Aceptación: `mask.ts` reemplaza CUIT/CUIL, DNI, CBU/CVU, tarjetas (Luhn), IBAN, E.164 y emails por marcadores tipados, y exporta los patrones como única fuente para `log.ts`, el normalizador e `infra/guardrail-policies.ts` (regex de G1); `clock.ts` expone relojes inyectables (`fixedClock`, `worldClock(clockId)` con modos `PAUSED`/`RUNNING`); `crypto.ts` deriva subclaves HKDF con etiquetas fijas; `session.ts` emite y verifica `sessionToken` (≤ 15 min, ligado a un turno); horarios hábiles por zona IANA con feriados; detector de idioma es/en determinista. Tests: `lib/{log,mask,clock,crypto}.test.ts`, `services/{session,business-hours,language}.test.ts`.

**WP-14 · Contexto tRPC, principal y triggers de auth** — typescript-dev · WP-05, WP-07
Objetivo: BFF base. Archivos: `packages/bff/src/auth/**`, `packages/bff/src/auth-triggers/**`, `packages/bff/src/routers/{trpc,handler,deps,index,health}.ts`, `packages/bff/src/routers/{health,isolation}.test.ts`. Aceptación: verificación offline del id token (sin forma de inyectar JWKS desde el handler de la Lambda); `firmProcedure`, `brokerProcedure` (`BROKER` o `JUDGE`), `recentLoginProcedure` (15 min con 60 s de tolerancia, reloj real); cross-firm → 403 + `AuditLog DENY CROSS_FIRM`; pre-token agrega `firmId`, rol e `isJudge`; `createCaller` usable desde el `QaDriver` con un principal armado en el servidor. Tests: `auth/jwt.test.ts` (clave efímera), `auth/no-jwks-override.test.ts`, `auth-triggers/triggers.test.ts`, `routers/isolation.test.ts`.

**WP-15 · Contrato del lector, mock y cliente** — typescript-dev · WP-05
Objetivo: ADR-0003. Archivos: `packages/reader-contract/**`, `packages/reader-mock/**`, `packages/bff/src/reader/**`, `scripts/reader/contract-check.ts`. Aceptación: OpenAPI de `docs/architecture-integrations.md` §5; mock con URLs solo de `Documents`, tope de 10 MB y 5 s, parser acotado, búsqueda por SHA-256 y por `LegajoDocId`, `UNRECOGNIZED`, fallas por mundo con `X-Fault-Scope`, caché de idempotencia por (clave, SHA-256); cliente SigV4 con timeout 8 s, 3 reintentos con `Retry-After`; `npm run reader:contract` compara zod y YAML. Tests: `reader-mock/src/reader.test.ts`, `bff/src/reader/client.test.ts`, `scripts/reader/contract-check.test.ts`.

**WP-16 · Plataforma de gestión aduanera (mock)** — typescript-dev · WP-05
Objetivo: `PlatformMock`. Archivos: `packages/platform-mock/**`. Aceptación: rutas y eventos de `docs/architecture-integrations.md` §6 (con `firmId` y `/v1/health`); `PutEvents` al bus por un puerto inyectable; `eventId` único. Tests: `platform-mock/src/platform.test.ts`.

**WP-45 · Casos de QA** — qa · —
Objetivo: `docs/test-plan.md` §8 antes de construir. Archivos: `tests/cases/**`. Aceptación: un `FL-XXX.md` por flujo con entrada, pasos, resultado esperado verificable sin leer código, oráculo si depende del modelo y evidencia. Tests: —.

### Ola 2 · Datos, política, canales y agente (paralela)

**WP-08 · Generador y validador del seed, PDFs sintéticos** — seed-generator · WP-05, WP-10, WP-15
Objetivo: `docs/seed-spec.md` completo. Archivos: `scripts/seed/generate.ts`, `scripts/seed/generate/**`, `scripts/seed/lib/**` (incluye `pdf.ts`, el escritor de PDF adaptado), `scripts/seed/validate.ts`, `scripts/seed/validate/**`, `scripts/seed/data/**`, `scripts/seed/pdfs/**`, `scripts/seed/overrides.example.json`, `scripts/seed/__tests__/{determinism,invariants,reader-catalog,conforms-to-domain}.test.ts`. Aceptación: determinismo byte a byte en procesos separados, sin `Intl`; 30 operaciones, 90 PDFs v1 + versiones, catálogo del lector con SHA-256 reales, 200 entradas del lote (sin resultados), fixture de métricas de QA, plantillas de mundo (`data/worlds/`: `demo-firm-delta`, `demo-firm-norte`, `qa-min`, `judge`, `models`) con inicio 14/10 10:30, los estados de hitos de `docs/seed-spec.md` §3 y la ventana del recorrido declarada en `judge` (`tour`), invariantes 10 (la política real sobre cada mensaje histórico de `judge` y `demo-firm-delta`, en `invariants.test.ts`), 20 (`qainject-`) y 21 (ventana del recorrido), direcciones de operación con la etiqueta HMAC de la clave de prueba (invariante 2), `NAMECHECK` con la búsqueda web registrada, feriados verificados contra el calendario oficial; invariantes en verde; textos importados de `copy/`. Tests: los cuatro de `__tests__/`.

**WP-17 · Motor de política de contacto** — typescript-dev · WP-07, WP-13
Objetivo: `evaluate` puro con las reglas `CP-*` en orden. Archivos: `packages/bff/src/policy/**`. Aceptación: entrada `{message, operation, importer, supplier, contact, history, clock, modes, fence}` → `{allowed | deferred, ruleIds, reason, nextAllowedAt, evaluated[]}`; orden de `docs/design-brief.md` §5.7; evaluación en un instante pasado desde las historias con fecha (para `PolicyAudit`); ninguna regla lee la hora de la máquina. Tests: `policy/{engine,hours,holidays,window,frequency,as-of}.test.ts`.

**WP-18 · Infra de email** — devops · WP-06
Objetivo: SES de punta a punta. Archivos: `infra/messaging-email.ts`, `infra/messaging-email-spec.ts`, `infra/messaging-email-spec.test.ts`. Aceptación: compuerta del paso 0 de `docs/architecture.md` §15 cumplida (SES en producción, cuota ≥ 5.000); identidad, Easy DKIM, MAIL FROM `bounce.legajo.demo.craftech.io` (MX de feedback y SPF), MX de `legajo.` y `sim.`, **registros DMARC `_dmarc.legajo.demo.craftech.io` y `_dmarc.sim.legajo.demo.craftech.io` con `v=DMARC1; p=reject; adkim=r; aspf=r`**; rule set `aws-cds-hackathon-poc-legajo-inbound` activo con reglas `ops-poc` y `sim-poc`, `scanEnabled`; configuration sets `…-email-poc` (→ EventBridge → `ChannelEvents`) y `…-sim-poc` (sin eventos); Functions `InboundEmail`, `SimMail`, `ChannelEvents` (stubs); `SEND_EMAIL` con `ses:FromAddress` y `ses:Recipients` según `docs/architecture.md` §14; paso de CI que falla si hay otro rule set activo. Tests: `messaging-email-spec.test.ts` (registros DMARC, MX, MAIL FROM y condiciones IAM como datos).

**WP-19 · Adaptador de email, normalizador y comunes de canal** — typescript-dev · WP-07, WP-13
Objetivo: `ChannelAdapter` de email. Archivos: `packages/bff/src/channels/{adapter,normalizer,registry,rate-limit}.ts` (+ tests), `packages/bff/src/channels/email/**`. Aceptación: parseo del MIME desde S3, confianza **solo** con `dmarcVerdict PASS` (sin leer `d=` ni usar `dkimVerdict`), etiqueta de la dirección, contacto `ACTIVE` de la operación, hilo, adjuntos (allowlist, `%PDF-`, tamaños), descartes; normalizador que enmascara y escapa con delimitador aleatorio; cliente único de SES con perfiles de remitente (`SYSTEM`, `SIMULATOR`, `QA`), el cerco por perfil adentro y la verificación del `From` contra el registro (`SIMULATOR`: contacto `ACTIVE` del proveedor de la operación a la que resuelve el destinatario, sin reglas de prefijo; `QA`: inyector `qainject-*` o parte de un mundo `qa-*` que no es contacto `ACTIVE` de la operación destinataria; `docs/architecture-integrations.md` §1), el registro de correo pendiente (`PENDING#<clockId>`, `X-Legajo-Mail-Id`) y parser estricto de direcciones y encabezados; el normalizador enmascara con los patrones de `lib/mask.ts` (única fuente, también para `log.ts` y G1); eventos SES → estados y temporizadores; registro que instancia transportes por modo; rate limit por mundo y hora simulada. Tests: `channels/normalizer.test.ts`, `channels/rate-limit.test.ts`, `channels/email/{inbound,outbound,events,address}.test.ts` con fixtures (`reply.eml`, `auto-reply.eml`, `spoofed.eml`, `spoofed-dual-dkim.eml`, `dmarc-gray.eml`, `pending-contact.eml`, `html-hidden.eml`, recibos con veredictos, eventos SES).

**WP-20 · Adaptador de WhatsApp (vivo y simulado)** — typescript-dev · WP-07, WP-13
Objetivo: ADR-0002. Archivos: `packages/bff/src/channels/whatsapp/**`. Aceptación: parseo del sobre SNS y de `whatsAppWebhookEntry`; identidad por `phoneHash`; ruteo por operación y lista `OPERATION_CHOICE`; nonces; palabras clave de baja; media (`GetWhatsAppMessageMedia` con borrado de lo que excede límites, y `sim-media:`); render del JSON de Meta (texto, interactivo, plantilla con `quick_reply` y `url`); `SimulatedWhatsAppTransport` con estados sintéticos y firma del sobre simulado (subclave `sim-envelope`); rechazo cruzado de modos. Tests: `channels/whatsapp/{inbound,media,routing,nonces,outbound,events,simulated,registry}.test.ts` con fixtures de la forma real.

**WP-21 · Infra de WhatsApp, mocks y feeds** — devops · WP-06
Objetivo: topic, mocks externos y bus. Archivos: `infra/messaging-whatsapp.ts` (topic `aws-cds-hackathon-poc-legajo-wa-inbound` con política de `social-messaging`, `InboundWhatsApp` + suscripción, link de `WabaId` y `WhatsAppPhoneNumberId`), `infra/mocks.ts` (`ReaderMock`, `PlatformMock`, tablas `ReaderCatalog` y `Platform`, Function URLs `AWS_IAM`), `infra/feeds.ts` (bus `Feeds`, regla → `FeedEvents` stub), `infra/mocks-spec.test.ts`. Aceptación: `socialmessaging` solo con el `phone-number-id` del secreto; cada invocante de un mock con el par `lambda:InvokeFunctionUrl` (con `FunctionUrlAuthType AWS_IAM`) **y** `lambda:InvokeFunction` en su política de identidad y un par de `aws.lambda.Permission` por rol en la política de recurso. Tests: `infra/mocks-spec.test.ts` (nombres, políticas y los dos permisos como datos).

**WP-22 · Schemas de las tools, wrapper común y system prompt** — typescript-dev · WP-05, WP-13
Objetivo: fuente única de schemas y handlers stub. Archivos: `packages/bff/src/agent-tools/common/**`, `packages/bff/src/agent-tools/{operations,documents,messaging,followups,handoff}/{schema,handler,index}.ts` (handlers que despachan a stubs `UNAVAILABLE`), `packages/bff/src/agent/system-prompt.ts`, `infra/agent-tool-schemas.ts`. Aceptación: `createToolHandler` resuelve `sessionToken` XOR `caller`, aplica `LAM-OP-SCOPE`/`LAM-CALLER`/`LAM-STRICT`/`LAM-TRIGGER`, rechaza tokens de turnos cerrados, escribe `TURN#`, audita; `decision` y `overrideAssumptions` declarados en el schema y rechazados por zod; `npm run tools:build-schemas` genera 5 payloads con 15 tools y solo palabras soportadas; el system prompt cubre `docs/design-brief.md` §5.9 y nombra el delimitador del turno. Tests: `agent-tools/common/{handler,build-schemas,scope}.test.ts`, `agent/system-prompt.test.ts` (reglas presentes, sin nombres prohibidos).

**WP-23 · AgentCore: Memory, Gateway, targets y Harness** — devops · WP-09, WP-22
Objetivo: el agente como recurso. Archivos: `infra/agent-tools.ts` (5 Functions target), `infra/agentcore.ts`, `infra/agentcore-spec.ts`, `infra/agentcore-spec.test.ts`, `infra/agentcore-iam.ts`. Aceptación: Memory con 3 estrategias propias con instrucción de exclusión y `retrievalConfig` de preferencias, hechos y resumen (`docs/architecture.md` §9.3); Gateway `AWS_IAM`, targets en cadena con `ignoreChanges`, política de recurso de cada target con el rol del Gateway y los roles internos específicos; políticas Cedar de WP-09 adjuntas después del último target; Harness con los límites de §4, endpoint `live`, log group de `live` creado antes del endpoint con retención; captura de contenido en trazas apagada o retención de `aws/spans` fijada (registrado en el PR); Linkable `Agent`. Tests: `agentcore-spec.test.ts`; `qa` verifica Harness `READY` y 5 targets `READY` tras el deploy.

**WP-24 · Cola por operación y Scheduler** — devops · WP-06
Objetivo: orquestación. Archivos: `infra/operations.ts` (`OperationEvents.fifo`, DLQ, `OperationWorker` con concurrencia reservada 5, `DocumentIntake` con la regla del resultado de escaneo de GuardDuty), `infra/scheduler.ts` (grupo `aws-cds-hackathon-poc-legajo-poc-schedules`, rol de invocación, `ScheduleDispatch`, `WorldJanitor` con su schedule diario, timeout de 12 min y política de recurso que admite la invocación asíncrona `MEMORY_PURGE` solo de los roles de `Bff` y `QaDriver`, Linkable `Scheduler`), `infra/operations-spec.test.ts`. Aceptación: visibilidad 720 s, `maxReceiveCount 2`, batch 1; `sqs:ChangeMessageVisibility` del worker solo sobre la cola (capacidad declarada en `infra/iam-capabilities.ts`); rol del Scheduler solo sobre `ScheduleDispatch`; capacidad `TIMERS` (acciones sobre el grupo y `iam:PassRole` condicionado a `scheduler.amazonaws.com`). Tests: `infra/operations-spec.test.ts`.

### Ola 3 · Lógica del producto (paralela)

**WP-25 · Pipeline de salida y target `messaging`** — typescript-dev · WP-17, WP-19, WP-20, WP-22
Objetivo: un solo camino de salida. Archivos: `packages/bff/src/outbound/**`, `packages/bff/src/agent-tools/messaging/**`. Aceptación: control → política → render → G2 (con `query` por `MessageKind` y los límites de longitud) → verificación determinista (hechos, idioma, datos sensibles, `CP-NO-FOREIGN-LINKS`) → cerco (perfil `SYSTEM`; `outbound/recipient-fence.ts` es el mismo módulo de cerco que aplica el cliente de SES a los tres perfiles, con los casos de `docs/architecture-integrations.md` §1 en su test) → transporte → `Conversations` + `AuditLog` (`ALLOW` con `messageId` y reglas evaluadas); `send_whatsapp`, `send_email`, `propose_supplier_contact` según `docs/tool-catalog.md`; diferidos como `TIMER#DEFERRED_SEND#`. Tests: `outbound/{pipeline,verify,grounding,recipient-fence}.test.ts`, `outbound/render/whatsapp.test.ts`, `agent-tools/messaging/{messaging,propose-contact}.test.ts`.

**WP-26 · Tools `operations` y `documents`, intake** — typescript-dev · WP-15, WP-22
Objetivo: lectura de estado y documentos. Archivos: `packages/bff/src/agent-tools/{operations,documents}/**`, `packages/bff/src/intake/**`. Aceptación: 6 + 2 tools; intake con versión, lectura, observaciones, intentos, regla de dos intentos, cuarentena, `UNRECOGNIZED` y `TIMER#READER_RETRY`; matriz de responsabilidad. Tests: `intake/{intake,attempts,escalation-rules}.test.ts`, `agent-tools/operations/{operations,assign-responsible}.test.ts`, `agent-tools/documents/documents.test.ts`.

**WP-27 · Temporizadores, hitos, reloj, seguimientos y traspaso** — typescript-dev · WP-17, WP-22
Objetivo: tiempo y escalamiento. Archivos: `packages/bff/src/timers/**`, `packages/bff/src/milestones/**`, `packages/bff/src/clock/**`, `packages/bff/src/escalations/**`, `packages/bff/src/agent-tools/{followups,handoff}/**`. Aceptación: entidad `TIMER#<kind>` con `GSI3` y a lo sumo un schedule; `schedule_milestones`, `fire_timer` (versión, legajo completo, fallback), `reschedule_on_eta_change`, `advance_clock` (`advance`, `advanceTo`, `advanceToNext`, modos `PAUSED`/`RUNNING` con horizonte de 1 h, resincronización de schedules en todo movimiento en `RUNNING`, `unfreeze({leadSec})` atómico y vuelta a pausa), compuerta `WORLD_BUSY` con `force` después de 5 min, épocas desde `COUNTER#EPOCH#`, `reset` del mundo (sin la recarga, que es de WP-31), escalamientos deterministas y de agente con tope de `UNTRUSTED_SENDER`, `request_approval`, `estimate_delay_risk` con supuestos. Tests: `timers/timers.test.ts`, `milestones/{schedule,fire,reschedule,escalation,arrival,fallback}.test.ts`, `clock/{advance,reset}.test.ts` (un caso por `kind`), `agent-tools/followups/{followups,risk}.test.ts`, `agent-tools/handoff/handoff.test.ts`.

**WP-28 · Turnos del agente y worker** — typescript-dev · WP-22, WP-23
Objetivo: `docs/architecture.md` §7 y §9.1. Archivos: `packages/bff/src/agent/{harness-client,envelope}.ts`, `packages/bff/src/turns/**`, `packages/bff/src/worker/**`, `packages/bff/src/handlers/operation-worker.ts`. Aceptación: sesión, sobre con delimitador aleatorio, `InvokeHarness` con `runtimeSessionId`/`actorId` con épocas, pre-filtro G1 que solo bloquea ante `BLOCKED` (temas, `PROMPT_ATTACK`, tarjeta) y sigue con el texto de G1 ante `ANONYMIZED` (`GUARDRAIL_MASK`), y bloqueo determinista según la fuente (sin reenviar el centinela; respuesta fija solo a un mensaje del importador; ningún saliente ante un email del proveedor o un turno sin mensaje del importador; escalamiento directo con motivo por política; `GUARDRAIL_BLOCK` con `origin` y `source`; `sessionEpoch + 1`), lectura del stream, uso de tokens, nota del turno, control del estudio, `TURN_CAP`, reintento de `ThrottlingException`, idempotencia doble, `OPSTATE` y `WORLDSTATE` (`inFlight`), despacho por tipo de evento incluidos `OUTBOUND_SEND`, `ESCALATE`, `HEALTH_PROBE` y `POISON` (solo `qa-*`, con `ChangeMessageVisibility` a 0); camino de evento perdido en el último intento (`inFlight` vaciado, `processError`, `EVENT_DEAD_LETTERED`, `docs/architecture.md` §7); verificación en el `.d.ts` de si el Harness propaga atributos de sesión, de si admite `maxIterations` por invocación y de qué campos trae `MemoryRecordSummary` (`memoryRecordId`, `createdAt` y el texto del registro, que usa la clave de `memory.inspect`; `docs/architecture.md` §9.3) (registrado en el PR). Tests: `worker/{worker,idempotency,settle,guardrail-block,turn-cap}.test.ts`, `turns/{envelope,turn}.test.ts`, `agent/harness-client.test.ts`.

**WP-29 · Entradas: WhatsApp, email, eventos de canal, feeds, schedules** — typescript-dev · WP-19, WP-20, WP-16, WP-43
Objetivo: Lambdas de entrada finas sobre los adaptadores. Archivos: `packages/bff/src/handlers/{inbound-whatsapp,inbound-email,channel-events,feed-events,schedule-dispatch,document-intake}.ts`, `packages/bff/src/feeds/**`. Aceptación: orden obligatorio de `docs/architecture-integrations.md` §2 (etiqueta, tumba por época, DMARC, contacto `ACTIVE`, cierre del correo pendiente con `PROBE#MAIL#`) y del adaptador de WhatsApp; `ChannelEvents` y `DocumentIntake` cierran sus pendientes; `DISPATCH_BEFORE_APPROVAL`; `notify_dispatch_status`; resolución de feeds por estudio y número; intake de link y media solo con `NO_THREATS_FOUND`; todo encolado en la FIFO con `eventId` y `OPSTATE`; `SIM_REPLY` entregado a `SimMail`. Tests: `feeds/{feed-events,dispatch}.test.ts`, `handlers/{inbound-whatsapp,inbound-email,channel-events,feed-events,schedule-dispatch,document-intake}.test.ts`.

**WP-30 · Simulador de proveedor y buzón de demo** — typescript-dev · WP-19, WP-10
Objetivo: `SimMail`. Archivos: `packages/bff/src/sim-mail/**`, `packages/bff/src/handlers/sim-mail.ts`. Aceptación: guarda `SIM_UNTRUSTED` antes de todo (DMARC, `From`, `Message-ID` contra un saliente registrado para ese buzón); respuestas con el perfil `SIMULATOR` del cliente de SES; cierre del correo pendiente con `PROBE#MAIL#` recién después de dejar su efecto; todos los comportamientos de `docs/architecture-integrations.md` §3 con `TIMER#SIM_REPLY`; `SEND_NOW` solo para mundos QA; protecciones de bucle y topes en tiempo simulado y real; buzón con `firmId` de la operación del saliente. Tests: `sim-mail/{supplier-simulator,mailbox,guard}.test.ts`.

**WP-32 · Infra de BFF, superficie pública, QA y observabilidad** — devops · WP-11, WP-24
Objetivo: el resto de las funciones y la observabilidad. Archivos: `infra/bff.ts` (`Bff`, `PublicWeb`, `QaDriver` con nombre fijo, política de recurso para `qa-runner` y la fila IAM explícita de `docs/architecture.md` §14, incluidos `ses:FromAddress` ∈ {`qainject-*@sim…`, `qa-*@sim…`} del `QaDriver` y `lambda:InvokeFunction` de `WorldJanitor` en `Bff` y `QaDriver`, `PolicyAudit` con schedule diario), `infra/observability.ts`, `infra/observability-spec.ts`, `infra/observability-spec.test.ts`. Aceptación: rutas del Router `/api/*` y `/u/*`; concurrencia reservada de §12; métricas y alarmas de `docs/architecture.md` §12 sobre `fn.nodes.logGroup`; alarma de tasa de rebote de SES al 2 %; presupuesto del proyecto con avisos; ningún secreto en `Environment`; `iam simulate-principal-policy` del rol del `QaDriver` contra mundos no QA y otro proyecto (debe denegar) en la verificación del WP. Tests: `observability-spec.test.ts`.

**WP-43 · Handlers deterministas de consola y canal** — typescript-dev · WP-17, WP-22
Objetivo: los handlers de invocación directa que consumen los routers y las entradas. Archivos: `packages/bff/src/services/{consent,contacts,dossier-actions,conversation-control,operations-admin}/**`. Aceptación: `record_consent`, `revoke_consent`, `authorize_supplier_contact`, `confirm_supplier_contact`, `verify_sender`, `upsert_party`, `create_operation`, `approve_dossier`, `reopen_dossier`, `waive_observation`, `classify_unrecognized`, `take_conversation`/`release_conversation`, `broker_send` (encola `OUTBOUND_SEND`), `apply_email_event`, `deferred_send`, `record_activity` según `docs/tool-catalog.md`, con historias con fecha. Tests: `services/*/*.test.ts`.

### Ola 4 · Mundos, consola (backend) y superficies de prueba (paralela)

**WP-31 · Mundos, loader del seed e invitaciones** — typescript-dev · WP-08, WP-27
Objetivo: una fábrica de mundos que usan el loader, el primer login de un jurado, "Reiniciar demo", `WorldJanitor` y el `QaDriver`. Archivos: `packages/bff/src/worlds/**`, `packages/bff/src/handlers/world-janitor.ts`, `scripts/seed/load.ts`, `scripts/seed/load/**`, `scripts/seed/__tests__/load.test.ts`, `scripts/console/invite.ts`, `scripts/channels/{whatsapp-templates,waba-event-destination}.ts`. Aceptación: carga idempotente con huella (manifest + overrides), plantillas subidas a `Seed/worlds/`, relojes en pausa, un reloj existente recargado como reinicio (época por `ADD`, nunca 1 otra vez), `ADDR#`, `cognitoSub` conservado, overrides desde `SeedOverrides`; `createWorld` (demo, jurado, QA, lote) idempotente con leases de teléfono y número, etiqueta de dirección reclamada con `ADDR#`, partes por operación (`operations: [{key, model, importer, supplier}]`), buzones propios, filas de `Platform` escritas directo (capacidad `WORLDS`) y parámetros de QA; `destroyWorld` completo (Memory incluida) con condiciones `world = qa` y tumba por época, sin borrar `COUNTER#EPOCH#`; `reset` con época, filas de `Platform` reescritas y purga de Memory en pasadas repetidas (`worlds/memory-purge.ts`: primera pasada en la llamada, segunda a los 60 s y listados hasta dos vacíos seguidos, en `WorldJanitor` con el evento `MEMORY_PURGE`; `docs/architecture.md` §9.3); última sesión por mundo de jurado (`lastSession`); `console:invite --judge` (contraseña permanente, MFA apagado, grupo `JUDGE`) y `--judge-test`; scripts de WhatsApp listos para P-01 (verifican comandos del SDK en el `.d.ts` antes de usarlos). Tests: `worlds/memory-purge.test.ts` (registro tardío entre pasadas, tope con `MEMORY_PURGE_INCOMPLETE`), `worlds/worlds.test.ts` (colisiones, restos, tumba, `GLOBAL#firm-delta` → `FORBIDDEN`, dos clones de una operación modelo, dos mundos de jurado con direcciones distintas, época después de `destroy` + `create`), `scripts/seed/__tests__/load.test.ts` (dos recargas → época 3 con ids nuevos).

**WP-33 · Routers de la consola, métricas, auditoría de política y servidor de UI** — typescript-dev · WP-14, WP-25, WP-26, WP-27, WP-43
Objetivo: procedimientos de `docs/tool-catalog.md` y el servidor local de UI. Archivos: `packages/bff/src/routers/index.ts` (registro de routers), `packages/bff/src/routers/{operations,dossier,conversation,escalations,registry,clock,simulator,mailbox,metrics,audit,activity,tour,account}.ts` (+ tests), `packages/bff/src/metrics/**`, `packages/bff/src/policy-audit/**`, `packages/bff/src/handlers/policy-audit.ts`, `tests/ui-server/**`. Aceptación: roles y login reciente donde corresponde; `JUDGE` sin cambio de contraseña ni MFA y `account.session` con el aviso de otra sesión; `clock.*` con `WORLD_BUSY` y pendientes; aislamiento; simulador solo en modo `simulated`; KPIs por pestaña con N, fuente y rótulo; `policy_audit` con los dos chequeos detecta una violación sembrada y no marca revocaciones ni rebotes posteriores; `tests/ui-server` sirve Vite + `appRouter` real + `PublicWeb` + emulador de S3 con mundo en memoria y JWKS efímero inyectado solo desde su entrada. Tests: `routers/*.test.ts`, `metrics/kpis.test.ts`, `policy-audit/audit.test.ts`.

**WP-38 · Backend de la página de carga** — typescript-dev · WP-24, WP-26
Objetivo: `/u/<token>`. Archivos: `packages/bff/src/public-web/**`. Aceptación: página sin datos de terceros, POST prefirmado con condiciones y tope por link, CSP propia con el endpoint de `Uploads`, auditoría de accesos válidos y métrica agregada de los inválidos, páginas de error. Tests: `public-web/upload.test.ts`.

### Ola 5 · Consola, landing, QA en el stage y flujos locales (paralela)

**WP-34 · Vistas: operaciones, detalle del legajo, escalamientos** — typescript-dev · WP-12, WP-33
Archivos: `packages/web/src/views/{operations,dossier,escalations}/**`, `packages/web/e2e/{operations,dossier,isolation}.spec.ts`. Aceptación: `docs/design-brief.md` §6 filas 1-3; la 4471 fijada como Historia principal; pendientes con motivo y "Avanzar hasta ahí"; reusa `Table`, `DataTable`, `Drawer`, `Badge`, `FilterPills`; aprobar solo `BROKER`/`JUDGE` con modal de contraseña si el login es viejo; línea de tiempo por `sentAtSim`. Tests: los tres specs + `views/*/*-model.test.ts`.

**WP-35 · Vistas: registro, reloj, simulador, buzón, métricas, bitácora y recorrido** — typescript-dev · WP-12, WP-33
Archivos: `packages/web/src/views/{registry,clock,simulator,mailbox,metrics,audit,tour}/**`, `packages/web/e2e/{registry,clock,simulator,mailbox,metrics,audit,tour}.spec.ts`, `scripts/tour/check.ts` + `.test.ts`. Aceptación: simulador rotulado, burbujas y plantillas como WhatsApp, estados, hilo por defecto, "El agente está escribiendo…", glosa "EN"; reloj con avanzar al próximo evento, mover ETA, disparar, estado de despacho, reloj en vivo, reiniciar, controles deshabilitados con motivo y espera mientras el mundo está ocupado y "Avanzar igual" a los 5 min; recorrido con la espera esperada de cada paso; aviso de otra sesión en el shell de `JUDGE`; buzón en texto plano; métricas con pestañas y rótulos; bitácora con decisiones por regla; `views/tour/steps.ts` como fuente única del recorrido (paso 2 con `clock.advanceTo` 15/10 10:00; horas de "Qué mirar" completadas desde `clock.get` en el panel y con valores esperados para el README) y `tour:check` que compara README y `SC-24`. Tests: los siete specs + modelos.

**WP-36 · Landing, legales y capturas** — typescript-dev · WP-12, WP-33, WP-38
Archivos: `packages/web/src/views/landing/**`, `packages/web/public/{landing,legal}/**`, `scripts/landing/**`, `packages/web/e2e/{landing,public-upload}.spec.ts`. Aceptación: landing bilingüe con escenas, galería con zoom, "Powered by Craftech", bloque "qué es real y qué es simulado" y botón para jurados; capturas tomadas en `poc` con la cuenta `judge-test` después de una corrida real (o rotuladas "entorno local, agente guionado"); legales de la demo; `public-upload.spec.ts` contra el emulador de S3 del servidor de UI. Tests: `views/landing/landing.test.ts`, los dos specs.

**WP-37 · `QaDriver` y ejecutor de escenarios** — qa · WP-31, WP-33
Objetivo: `docs/test-plan.md` §4. Archivos: `packages/bff/src/qa-driver/**`, `packages/bff/src/handlers/qa-driver.ts`, `scripts/scenarios/**`. Aceptación: todas las acciones del `QaDriver` cercadas a estudios de tipo QA y relojes `qa-*`, con la lista cerrada de acciones sobre `GLOBAL#firm-qa` y `JUDGE#firm-judge-test` (`docs/tool-catalog.md`), con `createCaller` para la consola; `mail.outcome`, `dlq.find`/`dlq.delete`, `alarm.history`, `platform.get`, `memory.inspect` con `waitForExtraction` y completitud por estrategia (preferencia que coincide con el centinela; hechos y resumen por registro nuevo o cambiado contra la base o por namespace quieto 60 s pasados 180 s del turno), clave `{memoryRecordId, createdAt, contentSha256}`, estabilidad de 60 s y centinelas de tono por palabras clave (`scripts/scenarios/lib/sentinels.ts` con `sentinels.test.ts`), `email.inject` desde el inyector `qainject-…` y `clock.unfreeze({leadSec})`; `SC-00` a `SC-22`, `SC-24` y `SC-25` con los pasos y líneas de tiempo que citan los flujos, `flows: [...]` en cada paso, `op.settle` antes de todo negativo, oráculos, `eventually` con los topes de §4.3, presupuesto de turnos, idempotencia por paso, limpieza en `finally`, reporte JSON y markdown con duración y origen de bloqueos; `batch.run`; `npm run scenarios -- --suite smoke|full --scenario SC-xx`. Tests: `qa-driver/guard.test.ts`, `scripts/scenarios/lib/*.test.ts`; corrida de `SC-00` contra `poc`.

**WP-39 · Flujos locales y lote guionado** — qa · WP-25..WP-30, WP-33, WP-35, WP-43
Objetivo: `LF` de la matriz, el lote de métricas con agente guionado y la línea de tiempo del recorrido. Archivos: `tests/flows/**`, `scripts/metrics/**`, `scripts/tour/timeline.ts` + `scripts/tour/timeline.test.ts` (simula los pasos de `views/tour/steps.ts` sobre la plantilla `judge` con el mundo en proceso y el Harness guionado). Aceptación: mundo en proceso y Harness guionado con Cedar local; un archivo por área (`importer`, `supplier`, `observations`, `questions`, `policy`, `eta`, `handoff`, `approval`, `security`) con todos los flujos que la matriz le asigna; `scripts/metrics/batch-local.ts` corre las 200 entradas y escribe `LegajoMetrics` `agentMode SCRIPTED`. Tests: los propios.

### Ola 6 · Cierre

**WP-40 · Smoke y escenarios en CI** — devops · WP-37
Archivos: `.github/workflows/{deploy,scenarios}.yml`. Aceptación: `deploy.yml` asume `qa-runner` tras el seed y corre `SC-00`; `scenarios.yml` por `workflow_dispatch` con `--suite full` (incluye `SC-24` y `SC-25` con el secreto `JUDGE_TEST_PASSWORD`), artefactos del reporte; sin `environment:`. Tests: corrida real de los dos workflows.

**WP-41 · Tarifas verificadas y umbrales** — devops · WP-08
Archivos: `scripts/seed/generate/ratecard.ts` (regenera las filas `RATECARD` de `scripts/seed/data/Reference.json`). Aceptación: cada fila con precio, fuente oficial y fecha; `provisional: false`; umbral de costo fijado con el CTO; costo estimado de la compuerta calculado (`docs/test-plan.md` §6). Es compuerta antes de la primera corrida completa y antes de entregar credenciales a los jurados. Tests: invariante 15.

**WP-42 · Ejecución "100 % probada"** — qa · WP-37, WP-39, WP-40, WP-41
Archivos: `tests/cases/**` (actualización de lo que escribió WP-45). Aceptación: un caso por flujo al día; matriz de `docs/test-plan.md` §2.2 regenerada y verde; suite completa (con `SC-24`) 3 veces seguidas sobre el mismo commit; `policy_audit` = 0; checks de §6; informe final al orquestador con los ids de los runs.

Revisión de seguridad final (`security`, `docs/test-plan.md` §7) sobre el commit de WP-42. Documentación de submission (README en inglés con la sección de pruebas generada desde el recorrido, bloque de real y simulado, diagrama) la escribe `architect` en paralelo con la ola 6.

## 3. Dependencias y camino crítico

```
Ola 0  WP-01 → WP-02, WP-03 → WP-04
Ola 1  WP-05, WP-06, WP-07, WP-09, WP-10, WP-11, WP-12, WP-13, WP-14, WP-15, WP-16, WP-45
Ola 2  WP-08, WP-17, WP-18, WP-19, WP-20, WP-21, WP-22, WP-23, WP-24
Ola 3  WP-25, WP-26, WP-27, WP-28, WP-29, WP-30, WP-32, WP-43
Ola 4  WP-31, WP-33, WP-38
Ola 5  WP-34, WP-35, WP-36, WP-37, WP-39
Ola 6  WP-40, WP-41 → WP-42
```

Camino crítico: WP-01 → WP-02 → WP-06 → WP-07 → WP-17 → WP-25 → WP-33 → WP-37 → WP-40 → WP-42. Dentro de una ola, un WP que depende de otro de la misma ola (WP-07 de WP-05 y WP-06; WP-14 de WP-07; WP-23 de WP-22; WP-29 de WP-43; WP-39 de WP-35; WP-42 de WP-41) arranca cuando su dependencia está en la rama de integración de la ola; nunca comparten archivos.

## 4. Propiedad de archivos por ola (verificación)

Ningún archivo aparece en dos WP de la misma ola (`npm run lint:wp-ownership`). Los archivos que cambian de dueño entre olas:

| Archivo | De | A |
|---|---|---|
| Stubs de `infra/` (salvo `dns.ts`, `web.ts`, `web-spec.ts`) | WP-02 (ola 0) | Su WP de infra |
| Placeholders de vistas | WP-12 (ola 1) | WP-34/35/36 (ola 5) |
| `agent-tools/<target>/handler.ts` | WP-22 (ola 2) | WP-25/26/27 (ola 3) |
| `packages/bff/src/routers/index.ts` | WP-14 (ola 1) | WP-33 (ola 4), que registra los routers |
| `scripts/seed/__tests__/` | WP-08 (ola 2) | WP-31 (ola 4) suma `load.test.ts` |
| `.github/workflows/{deploy,scenarios}.yml` | WP-03 (ola 0) | WP-40 (ola 6) |
| `tests/cases/**` | WP-45 (ola 1) | WP-42 (ola 6) |
| `package.json`/`package-lock.json` | WP-01 | Integrador de cada ola |
| `packages/web/src/components/**`, `e2e/support/**`, claves compartidas de `copy/` | WP-12 | Congelados desde el cierre de la ola 4 (§1 nota 7) |

El integrador de cada ola (`devops`) solo toca `package.json`, `package-lock.json` y `sst-env.d.ts` regenerados.

## 5. Estado de las olas

Una ola se declara `aceptada` solo cuando cumple la regla de entrada del plan para la siguiente: mergeada a `main`, desplegada por CI y con su smoke en verde, con `security` y `qa` cerrados. `npm run lint` corre `scripts/lint/wave-status.ts`, que falla si una ola figura `aceptada` y todavía tiene un bloqueo: una ola anterior no aceptada, un archivo de sus WP que no existe, un marcador pendiente en un archivo suyo (`it.todo`, `test.fixme`, stub de WP-02, puerto sin cablear por defecto en código productivo) o ningún deploy registrado (`sst-env.d.ts` sin recursos).

| Ola | Estado | Qué falta para aceptarla |
|---|---|---|
| Ola 0 | `no aceptada` | Primer deploy de `poc` por CI con el smoke interino en verde (`sst-env.d.ts` sigue sin recursos). |
| Ola 1 | `no aceptada` | Deploy por CI y smoke interino en verde; depende de la ola 0. Falta además el schema `EventId` de WP-05 con su derivación (`docs/architecture.md` §7), que el formato cerrado de los ids de evento dejó pendiente. |
| Ola 2 | `no iniciada` | Ningún commit: faltan seed (`scripts/seed/generate/**`), política, canales, agente, tools y cola. |
| Ola 3 | `no iniciada` | Ningún commit: faltan salida, intake, reloj, turnos y worker, entradas, `SimMail` y el `infra/bff.ts` real (sigue el stub de WP-02, sin `QaDriver`, `Bff`, `PublicWeb`, `PolicyAudit` ni `WorldJanitor`). |
| Ola 4 | `no aceptada` | Arrancó sin las olas 2 y 3; le faltan el loader del seed, routers y los scripts de WhatsApp. |
| Ola 5 | `no aceptada` | Arrancó sin las olas 2 y 3: el `QaDriver` usa puertos sin cablear por defecto (`NOT_WIRED` en `world.create`, reloj, `wa.inbound`, `email.inject`, `supplier.sendNow`, `event.poison`, `fence.probe`, `batch.run`), el lote de métricas usa el corredor sin cablear, `tests/flows` conserva `it.todo`, `packages/web/e2e` conserva `test.fixme` y `SC-00` nunca corrió contra `poc`. Se acepta después de mergear y desplegar las olas 2 y 3, cablear los puertos reales y convertir esos pendientes en pruebas. |
| Ola 6 | `no iniciada` | Depende de las olas 0 a 5. |
