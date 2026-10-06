# Catálogo de tools y handlers

Tools expuestas al Harness por AgentCore Gateway (5 targets Lambda, **16 tools**), handlers deterministas de invocación directa (no están en el Gateway), procedimientos de la consola (tRPC) y acciones del `QaDriver`. Nombres en inglés, `snake_case`. Los schemas se escriben en JSON para leer; la fuente única es zod en `packages/bff/src/agent-tools/<target>/schema.ts`, de donde `npm run tools:build-schemas` genera el `inlinePayload` de cada target.

## Convenciones

| Convención | Regla |
|---|---|
| Target | Un `GatewayTarget` por dominio y una Lambda por target (`packages/bff/src/agent-tools/<target>/`); nombre en el Gateway `<target>___<tool>`; todo handler pasa por `createToolHandler` (`agent-tools/common/handler.ts`) |
| Principales | `harness` (rol de ejecución del Harness; **único principal del Gateway**) · `worker` (`OperationWorker`, handlers por import) · `channel` (`InboundWhatsApp`, `InboundEmail`, `SimMail`, `ChannelEvents`, `FeedEvents`, `DocumentIntake`) · `console` (BFF con JWT de Cognito: `brokerId`, `firmId`, `role`, `isGuest`, `authTime`) · `public` (BFF sin JWT: solo `signup.*`, detrás de WAF, OAC y del encabezado de origen verificado, nunca en lote) · `dispatch` (`SignupDispatch`, invocado asíncrono solo por `Bff`) · `cognito` (triggers del user pool) · `qa` (`QaDriver`, rol `qa-runner`; llega a los handlers de consola por el `appRouter` real con un principal armado en el servidor, ver "Acciones del `QaDriver`") · `scheduler` (`ScheduleDispatch`) |
| Sesión | Toda tool del Gateway exige `sessionToken` = `<sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>` (clave `SessionTokenKey`, `exp` ≤ 15 min). La Lambda verifica firma y vencimiento, carga `Runtime/SESSION#<sessionId>` y **deriva** `operationId`, `firmId`, `importerId`, `supplierId`, `clockId` y `eventAtSim`. Ningún id de operación, parte, contacto o documento del input se acepta si no pertenece a la operación de la sesión (`LAM-OP-SCOPE` → `FORBIDDEN` + `AuditLog DENY`) |
| Invocación directa | Input con `caller` en lugar de `sessionToken`: `{"kind": "WORKER" \| "CHANNEL" \| "CONSOLE" \| "QA" \| "SCHEDULER", "firmId", "brokerId", "role", "eventId"}`. `caller` **no autentica** (una Lambda no conoce el rol que la invocó): la cerca es la política de recurso de cada Lambda (quién puede invocar) y la unión zod `sessionToken` XOR `caller`, que rechaza `caller` si viene `sessionToken` o las marcas del Gateway en el contexto (`LAM-CALLER`). Los handlers de consola y QA se importan en proceso en `Bff` y `QaDriver` y nunca se despliegan en una Lambda target; `CONSOLE` y `QA` quedan cercados al `firmId` del principal que armó el servidor |
| Resultados del turno | Toda tool escribe su salida (ya redactada) en `Runtime/TURN#<turnId>/RESULT#<tool>#<seq>` (TTL 1 h). El pipeline de salida los usa como `grounding_source` de G2 y como fuente de la verificación determinista |
| Errores | Nunca lanzan: `{"ok": false, "error": {"code", "message"}}` con `code` ∈ `NOT_FOUND`, `FORBIDDEN`, `INVALID`, `CONFLICT`, `UNAVAILABLE`, `POLICY_DENIED`, `DEFERRED`, `CONTROL_BROKER`, `TEMPLATE_REQUIRED`, `RECIPIENT_NOT_ALLOWED`, `GROUNDING_FAIL`, `NOT_COMPLETE` |
| Fechas | ISO 8601 con zona; toda fecha de negocio es simulada (reloj de la operación) y la tool devuelve además `…Text` ya formateado (es-AR para el importador, en + zona del proveedor para el proveedor) para que el modelo copie y no calcule |
| Schemas del Gateway | Solo `type`, `properties`, `required`, `items`, `description`; los `enum` bajan a `description` ("uno de: …"); zod valida el `enum` real dentro de la Lambda con `.strict()`: una clave que el schema no declara → `INVALID`. Los campos que una política Cedar prohíbe (`decision`, `overrideAssumptions`) se declaran como propiedades opcionales documentadas ("never set; denied by policy") para que el statement sea válido contra el schema y se dispare; zod los rechaza con cualquier valor (`LAM-STRICT`) |
| PII | Las salidas enmascaran teléfonos (`+54 9 11 •••• 0101`) y emails (`s•••@sim.legajo…`) salvo que la tool exista para devolverlos; ninguna devuelve CUIT completo; los textos entrantes ya llegan enmascarados por el normalizador (`[CUIT]`, `[CBU]`, …) |
| Bitácora | Toda tool con efecto escribe `AuditLog` con `decision`, `action`, `ruleIds`, `actor = AGENT`, `refs {operationId, turnId, …}` |

Tipos compartidos (`@legajo/shared`, `packages/shared/src/enums*.ts`):

```json
{
  "DocType": ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"],
  "DocStatus": ["MISSING", "RECEIVED", "WITH_OBSERVATION", "VALID"],
  "Party": ["IMPORTER", "SUPPLIER", "BROKER"],
  "DossierStatus": ["OPEN", "READY_FOR_REVIEW", "APPROVED", "REOPENED"],
  "ObservationStatus": ["OPEN", "CORRECTION_REQUESTED", "RESOLVED", "ESCALATED", "WAIVED_BY_BROKER"],
  "MessageKind": ["DOCS_REQUEST", "REMINDER", "CORRECTION_REQUEST", "NO_ACTION_NEEDED", "CONTACT_REQUEST", "CONTACT_CONFIRMATION", "UPLOAD_LINK", "ETA_CHANGE", "ESCALATION_NOTICE", "ESCALATION", "APPROVAL_NOTICE", "DISPATCH_STATUS", "REPLY", "BROKER_MESSAGE", "OPT_OUT_CONFIRMATION", "OPERATION_CHOICE"],
  "WaButtonAction": ["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT", "CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT", "TALK_TO_FIRM", "CHOOSE_OPERATION"],
  "TimerKind": ["MILESTONE", "DEFERRED_SEND", "FOLLOWUP_DUE", "SIM_REPLY", "READER_RETRY", "CONTACT_CHECK", "BOUNCE_RETRY"],
  "ClockMode": ["RUNNING", "PAUSED"],
  "PolicyResult": {"allowed": "boolean", "ruleIds": ["string"], "reason": "string?", "nextAllowedAt": "string?"},
  "Guardrail": {"action": "NONE | BLOCKED", "groundingScore": "number?"}
}
```

Vocabulario fijo fuera de los enums (`@legajo/shared`). Estos módulos solo fijan los strings para que schemas, Cedar, bitácora, seed, consola y tests usen los mismos; la fuente es el documento de la derecha, que se cambia primero:

| Módulo | Qué fija | Fuente |
|---|---|---|
| `rules.ts` | Ids de regla que cita una decisión: `CP-*` en el orden del motor, `CED-*` (con `CED-PERMIT-<TARGET>` y `CED-SESSION-<TARGET>` por target), `LAM-*`, y `RESP-MATRIX`, `G1`, `G2`; `PolicyResult` | `docs/design-brief.md` §5.5-5.7 |
| `tools.ts` | Los 5 targets y sus 16 tools; nombre de acción en el Gateway y en Cedar `<target>___<tool>` | Este catálogo; `docs/architecture.md` §9.2 |
| `clock-ids.ts` | `clockId` (`GLOBAL#<firmId>`, `GUEST#<firmId>`, `qa-<runId>-<escenario>`, `sim-<batchId>`), su alcance (`GLOBAL`, `GUEST`, `QA`, `SIM`), los estudios de tipo QA (`firm-qa`, `firm-sim`, `firm-guest-test`) y los relojes fijos `GLOBAL#firm-qa` y `GUEST#firm-guest-test` | `docs/architecture.md` §8; ADR-0005 y ADR-0007 |
| `addresses.ts` | Dominios del stage (`legajo.demo.craftech.io`, `sim.legajo.demo.craftech.io`, `simulator.amazonses.com`), `avisos@`, los prefijos `qainject-` (inyector) y `qa-` (partes QA), los dominios reservados que el cerco rechaza y la dirección de operación con su etiqueta HMAC de 6 caracteres | `docs/architecture-integrations.md` §1; `docs/seed-spec.md` §2 |
| `document-keys.ts` | Claves de objeto de `Documents`, `Uploads`, `Media` y `Seed` (prefijo `qa/<runId>/` en mundos QA), la referencia `sim-media:<clave>` del simulador y los nombres de plantilla de mundo | `docs/architecture.md` §6; `docs/architecture-integrations.md` §4.2 |
| `ids.ts` | Ids con prefijo de las entidades | `docs/seed-spec.md` §2 |

---

## Target `operations` (`ToolOperations`)

### `get_operation`
Determinista · lee `Operations`, `Parties`, `Firms` · invocan: `harness`, `worker`, `console` · sin efectos.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "operation": {"operationNumber": "string", "firmName": "string", "importer": {"name": "string", "contactFirstName": "string"}, "supplier": {"name": "string", "country": "string", "timezone": "string", "language": "string"}, "vessel": "string", "carrier": "string", "regime": "string", "portOfLoading": "string", "eta": "string", "etaText": "string", "invoiceNumber": "string", "incoterm": "string", "dossierStatus": "DossierStatus", "control": "AGENT | BROKER", "dispatch": {"status": "string", "channel": "string"}}, "nowSim": "string", "nowSimText": "string", "otherOperations": [{"operationNumber": "string", "open": "boolean", "etaText": "string", "dossierStatus": "DossierStatus", "dispatchStatus": "string", "documentsValid": "integer", "missing": ["DocType"]}], "error": "Error"}}
```

`otherOperations` (ADR-0017, ADR-0019): las otras operaciones del importador, las abiertas primero y después las últimas cerradas, hasta diez en total. Solo a una abierta se puede mover un mensaje (`route_to_operation`). El worker corre esta lectura y `get_dossier` antes de cada turno y las pone en el sobre (ADR-0019).

### `get_dossier`
Determinista · lee `Operations` · invocan: `harness`, `worker`, `console`. Estado del legajo, plazos ya calculados y próximo hito.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "complete": "boolean", "missing": ["DocType"], "documents": [{"docType": "DocType", "label": "string", "status": "DocStatus", "responsibleParty": "Party", "currentVersion": "integer", "currentDocVersionId": "string", "receivedAtText": "string", "requestedFrom": "Party", "lastRequestedAtText": "string", "observations": [{"observationId": "string", "code": "string", "label": "string", "field": "string", "expected": "string", "found": "string", "severity": "BLOCKING | WARNING", "status": "ObservationStatus", "responsibleParty": "Party", "attempts": "integer"}]}], "deadlines": {"importer": {"atSim": "string", "text": "string"}, "supplier": {"atSim": "string", "text": "string", "timezone": "string"}}, "nextMilestone": {"name": "string", "dueAtSim": "string", "text": "string"}, "openEscalations": "integer", "error": "Error"}}
```

Plazo por defecto: importador = `FOLLOWUP_FINAL` (ETA − 3 días 10:00 AR); proveedor = ETA − 4 días 17:00 en su zona horaria.

### `assign_responsible`
Determinista · escribe `Operations/OBS#`, `AuditLog` · invocan: `harness`, `console`. El agente decide quién corrige; la tool compara con la matriz del estudio (`Firms/RESP_MATRIX#v<nnn>`) y marca para revisión una asignación distinta.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "observationId": {"type": "string"}, "responsibleParty": {"type": "string", "description": "uno de: SUPPLIER | IMPORTER | BROKER"}, "rationale": {"type": "string", "description": "máx. 300 caracteres"}}, "required": ["sessionToken", "observationId", "responsibleParty", "rationale"]},
 "output": {"ok": "boolean", "matchesMatrix": "boolean", "matrixDefault": "Party", "flaggedForReview": "boolean", "error": "Error"}}
```

Efectos: `Observation.responsibleParty`, `matchesMatrix`, `flaggedForReview`; `AuditLog ACTION ASSIGN_RESPONSIBLE` con `ruleIds: ["RESP-MATRIX"]`. `BROKER` siempre se marca para revisión.

### `get_counterpart_profile`
Determinista · lee `Parties`, `Conversations` · invocan: `harness`, `console`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "party": {"type": "string", "description": "uno de: IMPORTER | SUPPLIER"}}, "required": ["sessionToken", "party"]},
 "output": {"ok": "boolean",
  "importer": {"contactFirstName": "string", "optIn": {"active": "boolean", "grantedAtText": "string"}, "windowOpen": "boolean", "windowClosesAtText": "string", "supplierContactAuthorized": "boolean", "otherOpenOperations": ["string"]},
  "supplier": {"name": "string", "language": "string", "timezone": "string", "localTimeText": "string", "businessHoursOpenNow": "boolean", "nextBusinessOpenText": "string", "contacts": [{"contactId": "string", "emailMasked": "string", "status": "PENDING_CONFIRMATION | ACTIVE | BOUNCED | COMPLAINED", "confirmed": "boolean"}], "profile": {"medianReplyHours": "number", "lateDocTypes": ["DocType"], "lastBounceAtText": "string"}},
  "error": "Error"}}
```

### `get_checklist`
Determinista · lee `Firms/CHECKLIST#` · invocan: `harness`, `console`. Única fuente para responder dudas del importador (ADR-0013).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "docType": {"type": "string", "description": "opcional; uno de los DocType"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "firmName": "string", "checklistVersion": "string", "items": [{"itemId": "string", "docType": "DocType", "text": "string", "required": "boolean"}], "coverageNote": "string", "error": "Error"}}
```

`coverageNote` recuerda que lo que no está en los ítems no se responde (se escala `OUT_OF_CHECKLIST`).

### `get_dispatch_status`
Determinista · lee `Operations`, `Reference/DISPATCH_GLOSSARY` · invocan: `harness`, `console`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "status": "NONE | OFICIALIZADO | CANAL_ASIGNADO | LIBERADO", "channel": "VERDE | NARANJA | ROJO", "occurredAtText": "string", "genericExplanation": "string", "error": "Error"}}
```

---

## Target `documents` (`ToolDocuments`)

### `read_document`
Determinista (el lector es externo) · lee `Operations/DOC#…#V#`; si la versión está `RECEIVED` sin lectura, llama al lector con `Idempotency-Key = docVersionId` · invocan: `harness`, `worker`, `console`. El modelo nunca ve el PDF ni sus metadatos.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "docVersionId": {"type": "string"}}, "required": ["sessionToken", "docVersionId"]},
 "output": {"ok": "boolean", "docType": "DocType", "versionNo": "integer", "source": {"party": "Party", "channel": "EMAIL | WHATSAPP | UPLOAD_LINK | CONSOLE"}, "reading": {"status": "RECOGNIZED | UNRECOGNIZED | ERROR", "docType": "DocType", "confidence": "number", "fields": {"documentNumber": "string", "invoiceNumber": "string", "incoterm": "string", "grossWeightKg": "number", "netWeightKg": "number", "packages": "integer", "originCountry": "string", "signed": "boolean", "stamped": "boolean"}, "observations": [{"observationId": "string", "code": "string", "label": "string", "field": "string", "expected": "string", "found": "string", "severity": "string"}]}, "error": "Error"}}
```

### `create_upload_link`
Determinista · escribe `Runtime/LINK#`, `AuditLog` · invocan: `harness`, `worker` (render de plantilla), `console`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "docTypes": {"type": "array", "items": {"type": "string"}}}, "required": ["sessionToken", "docTypes"]},
 "output": {"ok": "boolean", "url": "string", "token": "string", "expiresAtText": "string", "error": "Error"}}
```

Link de 72 h reales, un importador, una operación, solo los `docTypes` que están `MISSING` o `WITH_OBSERVATION` con responsable `IMPORTER`. El `url` solo puede salir por `send_whatsapp` al importador de la sesión.

---

## Target `messaging` (`ToolMessaging`)

Las tres tools usan el **pipeline de salida** (`packages/bff/src/outbound/`): `LAM-CONTROL` → política de contacto (`docs/design-brief.md` §5.7) → render (plantilla o texto) → G2 `ApplyGuardrail` sobre el texto libre → verificación determinista (cifras, fechas, números de operación y factura presentes en `Runtime/TURN#`; sin pedido de datos sensibles; idioma correcto; sin enlaces ni contactos ajenos, `CP-NO-FOREIGN-LINKS`) → cerco de destinatarios (dentro del cliente de SES para email) → transporte (SES, EUM Social o simulado) → `Conversations` + `AuditLog` (`ALLOW` con `messageId` y reglas evaluadas). El mismo pipeline lo corren el worker (fallback de hitos, estados de despacho, escalamientos, envíos que ordena la consola) y `ToolHandoff`. El texto final del turno del Harness nunca se envía (ADR-0011).

### `send_whatsapp`
Determinista · EUM Social `SendWhatsAppMessage` o transporte simulado · invocan: `harness`, `worker` (fallback de hito), `console` (`broker_send`).

```json
{"input": {"type": "object", "properties": {
   "sessionToken": {"type": "string"},
   "recipientRole": {"type": "string", "description": "siempre IMPORTER (Cedar CED-WA-IMPORTER-ONLY)"},
   "kind": {"type": "string", "description": "MessageKind"},
   "text": {"type": "string", "description": "texto libre, solo dentro de la ventana de 24 h, máx. 900 caracteres"},
   "template": {"type": "object", "properties": {"name": {"type": "string"}, "params": {"type": "array", "items": {"type": "string"}}}},
   "buttons": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "description": "WaButtonAction"}, "operationNumber": {"type": "string"}}}},
   "refs": {"type": "object", "properties": {"docTypes": {"type": "array", "items": {"type": "string"}}, "observationIds": {"type": "array", "items": {"type": "string"}}}}},
  "required": ["sessionToken", "recipientRole", "kind"]},
 "output": {"ok": "boolean", "messageId": "string", "status": "SENT | DEFERRED", "deferredUntilText": "string", "windowState": "OPEN | TEMPLATE_REQUIRED", "templateUsed": "string", "policyResult": "PolicyResult", "guardrail": "Guardrail", "error": "Error"}}
```

Reglas: destinatario = teléfono registrado del contacto del importador de la sesión (`LAM-RECIPIENT`); `kind REMINDER` solo en sesiones con disparador `MILESTONE` o `FOLLOWUP_DUE` (`LAM-TRIGGER`, leído de la sesión; si no, `FORBIDDEN` sin enviar): un recordatorio nunca reemplaza un acuse o una respuesta que la ventana no deja salir (`docs/design-brief.md` §5.7, "Acuse de una carga por link"); `text` fuera de la ventana → `TEMPLATE_REQUIRED` sin enviar; parámetros de plantilla que no están en los resultados del turno → `GROUNDING_FAIL`; cada botón se convierte en un nonce (`Runtime/NONCE#`, 7 días, ligado a `phoneHash` y `operationId`) y el título lo pone el código (`copy/es-AR.ts`); `UPLOAD` genera el link de carga si no hay uno vigente. `DEFERRED` crea `Operations/TIMER#DEFERRED_SEND#<id>` (y su schedule solo si el mundo está `RUNNING`).

### `send_email`
Determinista · SES v2 `SendEmail` · invocan: `harness`, `worker`.

```json
{"input": {"type": "object", "properties": {
   "sessionToken": {"type": "string"},
   "recipientRole": {"type": "string", "description": "siempre SUPPLIER (Cedar CED-EMAIL-SUPPLIER-ONLY)"},
   "kind": {"type": "string", "description": "DOCS_REQUEST | REMINDER | CORRECTION_REQUEST | ETA_CHANGE | REPLY"},
   "contactId": {"type": "string", "description": "opcional; por defecto el contacto ACTIVE que funciona"},
   "text": {"type": "string", "description": "cuerpo en inglés, máx. 2.500 caracteres"},
   "refs": {"type": "object", "properties": {"docTypes": {"type": "array", "items": {"type": "string"}}, "observationIds": {"type": "array", "items": {"type": "string"}}}}},
  "required": ["sessionToken", "recipientRole", "kind", "text", "refs"]},
 "output": {"ok": "boolean", "messageId": "string", "status": "SENT | DEFERRED", "deferredUntilText": "string", "policyResult": "PolicyResult", "guardrail": "Guardrail", "error": "Error"}}
```

Reglas: `CP-SUPPLIER-AUTH` y `CP-BOUNCED-CONTACT` (`LAM-SUPPLIER-AUTH`); asunto, `From`, `Reply-To`, `In-Reply-To`, `References`, `X-Legajo-Operation` y `X-Legajo-Request` los arma el código desde `kind` y `refs`; el cuerpo tiene que contener el número de factura y, si hay plazo, el plazo en la zona del proveedor tal como lo devolvió `get_dossier`.

### `propose_supplier_contact`
Determinista · escribe `Parties/SUP#…/CONTACT#` (`PENDING_CONFIRMATION`), `Conversations`, `AuditLog` · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "email": {"type": "string"}, "sourceMessageId": {"type": "string", "description": "id del mensaje del importador que contiene la dirección"}}, "required": ["sessionToken", "email", "sourceMessageId"]},
 "output": {"ok": "boolean", "contactId": "string", "status": "PENDING_CONFIRMATION", "confirmationMessageId": "string", "error": "Error"}}
```

Reglas: solo en sesiones con disparador `IMPORTER_MESSAGE` (`LAM-TRIGGER`, leído de la sesión); `sourceMessageId` tiene que ser un mensaje entrante del importador de la sesión y contener la dirección textual (`LAM-EVIDENCE`); la dirección pasa el cerco de destinatarios (si no, `RECIPIENT_NOT_ALLOWED` y el agente escala); la tool manda al importador los botones `CONFIRM_CONTACT` / `REJECT_CONTACT`. Solo el botón del importador (o la consola) activa el contacto (`confirm_supplier_contact`); mientras está `PENDING_CONFIRMATION`, un email que llegue desde esa dirección va a cuarentena (`UNTRUSTED_SENDER`).

### `route_to_operation`
Determinista · lee `Operations` · escribe `AuditLog` · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "toOperationNumber": {"type": "string", "description": "número de otra operación abierta del importador, como la lista el sobre"}}, "required": ["sessionToken", "toOperationNumber"]},
 "output": {"ok": "boolean", "routed": "boolean", "operationId": "string", "operationNumber": "string", "note": "string", "error": "Error"}}
```

Reglas (ADR-0017): solo en sesiones con disparador `IMPORTER_MESSAGE` (`LAM-TRIGGER`). `toOperationNumber` tiene que ser una operación abierta del importador de la sesión, en su mundo, y distinta de la actual; si no, `NOT_FOUND` / `INVALID` y `DENY` auditado. La tool no mueve nada: cuando el turno cierra, el worker copia el mensaje a esa operación (`routedFrom`) y corre su turno `IMPORTER_MESSAGE` en la misma sesión de conversación del importador (Memory). Un mensaje ya movido no se vuelve a mover.

---

## Target `followups` (`ToolFollowups`)

### `schedule_followup`
Determinista · escribe `Operations/TIMER#FOLLOWUP_DUE#<id>` (+ schedule si el mundo está `RUNNING`) · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "party": {"type": "string", "description": "IMPORTER | SUPPLIER"}, "atSim": {"type": "string", "description": "ISO con zona"}, "reason": {"type": "string", "description": "PROMISED_BY_SUPPLIER | IMPORTER_ASKED_LATER | OTHER"}}, "required": ["sessionToken", "party", "atSim", "reason"]},
 "output": {"ok": "boolean", "followupId": "string", "scheduledForSim": "string", "scheduledForText": "string", "adjustedBy": ["string"], "error": "Error"}}
```

Reglas: máximo 2 seguimientos abiertos por operación; nunca después del hito `ESCALATION`; se corre al próximo horario hábil de la parte (`CP-HOURS-*`); al vencer, `AGENT_TURN(FOLLOWUP_DUE)`.

### `estimate_delay_risk`
Determinista · lee `Operations`, `Firms/SETTINGS` · invocan: `harness`, `console`, `worker` (escalamiento).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "overrideAssumptions": {"type": "object", "description": "never set; denied by policy CED-RISK-ASSUMPTIONS"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "missing": ["DocType"], "hoursToEta": "number", "daysAtRisk": {"min": "integer", "max": "integer"}, "estimatedCostUsd": {"min": "number", "max": "number"}, "assumptions": [{"name": "string", "value": "string", "label": "supuesto", "source": "string"}], "text": "string", "error": "Error"}}
```

`text` ya lleva la palabra "supuesto" y la fuente ("fuentes secundarias no verificadas"); `overrideAssumptions` existe en el schema solo para que Cedar lo deniegue (`CED-RISK-ASSUMPTIONS`) y zod lo rechaza (`LAM-STRICT`). Días en riesgo: 0 si el legajo está completo; si no, de `max(0, díasSinDocumentos − díasLibres)` a `díasSinDocumentos` con los supuestos del estudio.

---

## Target `handoff` (`ToolHandoff`)

### `escalate_to_broker`
Determinista · escribe `Operations/ESC#`, `AuditLog`; envía email al buzón del estudio cuando el motivo lo pide · invocan: `harness` (motivos `OUT_OF_CHECKLIST`, `IMPORTER_ASKED`, `OTHER`), `worker` (todos los motivos deterministas de `docs/design-brief.md` §5.8, incluidos los bloqueos de G1).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "reason": {"type": "string", "description": "OUT_OF_CHECKLIST | IMPORTER_ASKED | OTHER"}, "summary": {"type": "string", "description": "máx. 500 caracteres, sin datos personales"}, "notifyImporter": {"type": "boolean"}}, "required": ["sessionToken", "reason", "summary"]},
 "output": {"ok": "boolean", "escalationId": "string", "emailSent": "boolean", "error": "Error"}}
```

Reglas: un escalamiento abierto por motivo y operación (el segundo devuelve el existente); `notifyImporter` manda `legajo_escalado` por el pipeline; email a `Firm.mailboxAddress` (y a los destinatarios de demo del estudio) para `IMPORTER_ASKED`, `MISSING_AT_ETA_48H`, `OBSERVATION_ATTEMPTS`, `UNTRUSTED_SENDER` y `NO_VALID_CONTACT`, con estado del legajo, lo intentado, quién debe qué y el riesgo de `estimate_delay_risk` rotulado. Los emails `UNTRUSTED_SENDER` tienen tope por estudio y día (los siguientes solo quedan en la consola).

### `request_approval`
Determinista · escribe `Operations/META.dossierStatus = READY_FOR_REVIEW`, `AuditLog`; email "listo para revisión" al buzón del estudio · invocan: `harness`, `worker`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "summary": {"type": "string", "description": "máx. 800 caracteres: cómo se resolvió cada observación"}, "decision": {"type": "string", "description": "never set; denied by policy CED-NO-APPROVE"}}, "required": ["sessionToken", "summary"]},
 "output": {"ok": "boolean", "dossierStatus": "READY_FOR_REVIEW", "error": "Error"}}
```

Reglas: `NOT_COMPLETE` si algún documento no está `VALID` (o con su observación `WAIVED_BY_BROKER`); nunca lleva decisión: `decision` existe en el schema solo para que Cedar la deniegue (`CED-NO-APPROVE`) y zod la rechaza (`LAM-STRICT`); no existe forma de pasar a `APPROVED` desde el agente (ADR-0010).

---

## Handlers de invocación directa (no están en el Gateway)

Los marcados con `qa` los alcanza el `QaDriver` por el `appRouter` real (mismos middlewares que la consola); ninguno está desplegado en una Lambda target del Gateway.

| Handler | Principales | Qué hace | Efectos | Bitácora |
|---|---|---|---|---|
| `verify_sender` | `channel` | WhatsApp: `phoneHash` → importador (único por `ADDR#`). Email: dirección de la operación (etiqueta) + contacto `ACTIVE` del proveedor de esa operación + `dmarcVerdict PASS` | Ninguno | `DENY UNKNOWN_SENDER` / `UNTRUSTED_SENDER` |
| `record_consent` | `console`, `qa` | Registra opt-in de WhatsApp con fecha, medio (`SIGNED_FORM`, `EMAIL`, `IN_PERSON`) y versión del texto mostrado | `Parties/CONSENT#WHATSAPP` (con historia) | `ACTION CONSENT_GRANTED` |
| `revoke_consent` | `channel` (palabra clave o botón `OPT_OUT`), `console`, `qa` | Revoca; manda `OPT_OUT_CONFIRMATION` (texto fijo, exento) y escala `OPTED_OUT` | `revokedAt`, historia, `Escalation` | `ACTION CONSENT_REVOKED` |
| `authorize_supplier_contact` | `console`, `qa` | Autoriza o revoca que el agente escriba al proveedor de un importador | `Parties/IMP#…/AUTH#<supplierId>` (con historia) | `ACTION` |
| `confirm_supplier_contact` | `channel` (nonce `CONFIRM_CONTACT`/`REJECT_CONTACT`), `console`, `qa` | Contacto `ACTIVE` (o descartado); encola `AGENT_TURN(CONTACT_CONFIRMED)` | `CONTACT#` (con historia) | `ACTION CONTACT_CONFIRMED` |
| `upsert_party` | `console`, `qa` | Alta y edición de importadores, proveedores y contactos con `ADDR#` condicional (colisión → `CONFLICT`) y cerco (`RECIPIENT_NOT_ALLOWED`) | `Parties` | `ACTION` / `DENY` |
| `create_operation` | `console`, `qa` | Copia la operación desde `PlatformMock`, crea legajo con 3 documentos `MISSING` (o el estado que traiga), dirección de la operación con su etiqueta y reloj; llama `schedule_milestones` | `Operations` | `ACTION OPERATION_CREATED` |
| `schedule_milestones` | `worker` | Crea los 5 `TIMER#MILESTONE#` (y sus schedules si el mundo está `RUNNING`, `docs/architecture.md` §8) | `TIMER#`, Scheduler | `ACTION` |
| `intake_document` | `worker` | Copia, llama al lector, versión, documento, observaciones, intentos, escalamiento al segundo intento fallido, `UNRECOGNIZED` a cuarentena y escalamiento, `TIMER#READER_RETRY` si el lector no responde | `DOC#`, `OBS#`, `ESC#`, `TIMER#`, S3 | `ACTION DOCUMENT_READ` |
| `fire_timer` | `worker`, `scheduler` | Despacha un `TIMER#` por `kind`; ignora versiones viejas; no-op auditado si el legajo está completo (hitos) o si el documento ya llegó (seguimientos) | `TIMER#` | `ACTION TIMER_FIRED` / `SKIPPED` |
| `fire_milestone` | `worker` | Hitos de turno o deterministas | `TIMER#MILESTONE#` | `ACTION MILESTONE_FIRED` / `SKIPPED` |
| `reschedule_on_eta_change` | `worker` | Recalcula y actualiza los hitos; dispara vencidos una vez | `META.eta`, `etaHistory`, `TIMER#MILESTONE#` | `ACTION ETA_RESCHEDULED` |
| `notify_dispatch_status` | `worker` | Plantilla `despacho_estado` (solo legajo `APPROVED`); `LIBERADO` cancela temporizadores y cierra | `META.dispatch` | `ACTION` |
| `apply_email_event` | `worker` | Estado del mensaje; rebote (`TIMER#CONTACT_CHECK`), rebote transitorio (`TIMER#BOUNCE_RETRY`), queja | `Conversations`, `CONTACT#`, `TIMER#` | `ACTION` |
| `deferred_send` | `worker` | Reevalúa la política de un envío diferido y envía o vuelve a diferir | `TIMER#DEFERRED_SEND#` | `ALLOW` / `DEFER` |
| `handle_guardrail_block` | `worker` | Solo ante una evaluación `BLOCKED` (tema denegado → `OUT_OF_CHECKLIST`; `PROMPT_ATTACK` → `OTHER` "posible inyección"; tarjeta → `OTHER` "datos de tarjeta"). Según la fuente del texto bloqueado: mensaje del importador → respuesta fija `guardrailRefusal` (`REPLY`, `author SYSTEM`) al importador; email del proveedor o turno sin mensaje del importador → **ningún saliente** (ni al proveedor ni al importador). Siempre: escalamiento directo, `GUARDRAIL_BLOCK` con `origin` (`PREFILTER`/`HARNESS`) y `source` (`IMPORTER`/`SUPPLIER`/`SYSTEM`), `sessionEpoch + 1` si vino del Harness. Un resultado solo `ANONYMIZED` no llega acá: el turno sigue con el texto de G1 y se audita `GUARDRAIL_MASK` (`docs/architecture.md` §9.1) | `ESC#`, `META.sessionEpoch`, `Conversations` (solo el `REPLY` al importador) | `GUARDRAIL_BLOCK` / `ACTION GUARDRAIL_MASK` |
| `approve_dossier` | `console` (`BROKER`/`GUEST`, login ≤ 15 min), `qa` | `READY_FOR_REVIEW` → `APPROVED`; encola `OUTBOUND_SEND` con `legajo_aprobado` | `META` | `ACTION APPROVED` con `brokerId` |
| `reopen_dossier` | `console` (`BROKER`/`GUEST`), `qa` | `APPROVED` → `REOPENED` con motivo; el agente retoma | `META` | `ACTION REOPENED` |
| `waive_observation` | `console` (`BROKER`, `ANALYST`, `GUEST`), `qa` | Observación `WAIVED_BY_BROKER` con motivo; documento `VALID` si no quedan bloqueantes | `OBS#`, `DOC#` | `ACTION WAIVED` |
| `classify_unrecognized` | `console`, `qa` | El estudio asigna tipo a una versión `UNRECOGNIZED` o la descarta | `DOC#…#V#` | `ACTION` |
| `take_conversation` / `release_conversation` | `console`, `qa` | `control = BROKER` / `AGENT`; el release encola `AGENT_TURN(BROKER_RELEASED)` | `META.control` (con historia) | `ACTION TAKEOVER` / `RELEASE` |
| `broker_send` | `console`, `qa` | Mensaje del estudio al importador: encola `OUTBOUND_SEND` (`author = BROKER:<id>`); el worker lo pasa por el pipeline (ventana o plantilla) | `Conversations` | `ALLOW`/`DENY` |
| `advance_clock` | `console`, `qa` | `advance`, `advanceTo`, `advanceToNext`, `setMode` (`docs/architecture.md` §8); en `RUNNING` resincroniza los schedules en el mismo movimiento; desde la consola exige el mundo quieto (`WORLD_BUSY` con los pendientes; `force: true` solo si el pendiente más viejo pasó 5 min) | `CLOCK#`, `TIMER#`, Scheduler | `ACTION CLOCK_ADVANCED` / `CLOCK_FORCED` |
| `move_eta`, `emit_dispatch_status` | `console`, `qa` | Llaman a `PlatformMock` (que publica al bus `Feeds`); desde la consola exigen el mundo quieto (`WORLD_BUSY`), igual que `fire_milestone` | `Platform` | `ACTION` |
| `create_world` | `WorldJanitor` (`GUEST_CREATE`, que dispara `account.ensureWorld` de un `GUEST`), `qa`, `seed:load` (primera carga de un mundo de demo) | Fábrica de mundos (capacidad `WORLDS`, `docs/architecture.md` §14): lee la plantilla de `Seed/worlds/<plantilla>.json`; estudio, reloj en `PAUSED` con la época del contador `COUNTER#EPOCH#<clockId>` (1 solo la primera vez), clones con ids y partes según `operations` (`docs/seed-spec.md` §14), teléfonos (lease), buzones y números propios, dirección de operación con etiqueta HMAC reclamada con `ADDR#`, filas `POP#<firmId>#<número>` de `Platform` escritas directo; idempotente por (`runId`, escenario) o por cupo de invitado (`GUESTWORLD#<sub>` y `SLOT#GUEST#<nn>` arrendados antes con el mismo `leaseId`, ADR-0015 §4; un `GUEST_CREATE` cuyo `leaseId` ya no es el vigente no hace nada) | Todo el mundo | `ACTION WORLD_CREATED` |
| `destroy_world` | `WorldJanitor` (`GUEST_SWEEP` por TTL, `GUEST_DESTROY` a pedido del operador), `qa` (`world.destroy`) | Como `reset_demo_world` pero sin recargar la plantilla, en este orden: la fila `BROKER#` del invitado (primero: desde ahí sus tokens reciben 403), schedules `tm-g-*`/`tm-q-*`, `TIMER#`, **objetos de S3 del mundo** (prefijo `guest/<pub\|res>/<firmId>/e<época>/` de `Documents` y `Media`, `uploads/<token>/` de sus links y los MIME crudos del bucket de correo que citan sus `Message`), items del `clockId`, filas `POP#<firmId>#*`, purga de Memory en pasadas, `TOMB#`, `GUESTWORLD#<sub>` a `DESTROYED`; `CLOCK#` pasa a `DESTROYED`; al final libera `SLOT#GUEST#<nn>` con `releasedAtReal` (no se arrienda de nuevo por 20 min); ningún objeto del mundo sobrevive (`worlds/guest-worlds.test.ts`); nunca borra `COUNTER#EPOCH#`; capacidad `WORLDS` | Todo el mundo | `ACTION WORLD_DESTROYED` (con `reason` `TTL_IDLE` \| `TTL_MAX` \| `REQUEST`) |
| `reset_demo_world` | `console` (`BROKER`/`GUEST`, 1 cada 10 min por `clockId` y 12 por día en mundos de invitado), `qa` (sin límite, solo `GLOBAL#firm-qa`), `WorldJanitor`, `seed:load` (recarga de un mundo de demo existente) | `ADD 1` a la época (nunca la vuelve a 1), `TOMB#<clockId>#<época anterior>`, borra schedules, `TIMER#` e items del mundo (salvo `CLOCK#` y `COUNTER#EPOCH#`), borra y reescribe sus filas de `Platform` (la ETA vuelve a la de la plantilla), lo recarga de `Seed/worlds/<plantilla>.json` con ids nuevos de actor, sesión y dirección, y **purga Memory en pasadas repetidas** para los actores de la época anterior (primera pasada en la misma llamada; segunda 60 s reales después y listados cada 15 s hasta dos listados seguidos vacíos, tope 10 min, en `WorldJanitor` invocado en forma asíncrona; `docs/architecture.md` §9.3); capacidad `WORLDS` | Todo el mundo | `ACTION WORLD_RESET` |
| `record_activity` | `console` | Latido de 30 s (tiempo de consola observado, métrica secundaria) | `LegajoMetrics` | — |
| `policy_audit` | `scheduler`, `qa` | Dos chequeos por envío: decisión `ALLOW` con el mismo `messageId`, y reevaluación con las historias con fecha (`docs/architecture.md` §12) | `AuditLog VIOLATION` | — |
| `sim_reply` | `SimMail`, `scheduler` (`SIM_REPLY`), `qa` (`SEND_NOW`) | Respuesta del simulador de proveedor; `SEND_NOW` manda sin pedido pendiente | SES, `META.simState`, `TIMER#SIM_REPLY#` | `ACTION SIM_REPLY` |

## Procedimientos de la consola (tRPC)

Todo procedimiento pasa por `firmProcedure` salvo los de `signup` (`signupProcedure`: ruta exacta `/api/signup.<nombre>` sin lote) `account.session`, `account.ensureWorld`, `account.world` y `account.usage` (`guestBootstrapProcedure`: aceptan un `GUEST` todavía sin `firmId`) y `account.preferences` / `account.setLanguage` (`accountProcedure`: un `GUEST` con o sin mundo, o el personal por la puerta de `firmProcedure`); antes de cualquiera, el handler exige `X-Origin-Verify` y rechaza un lote que contenga un `signup.*`. Para un `GUEST`, `firmProcedure` falla cerrado si su fila `BROKER#` no existe, está inactiva o no coincide en `firmId` y `leaseId` con el token (403 `GUEST_WORLD_GONE`, ADR-0015 §4); los marcados **B** exigen rol `BROKER` o `GUEST` y los marcados **R** login ≤ 15 min. En un mundo `GUEST#*`, el middleware de cuotas (ADR-0015 §4) cuenta y puede rechazar con `QUOTA_EXCEEDED {kind, resetsAtReal}`: `simulator.sendText`/`tapButton`/`attachDocument` (mensajes del simulador; cargas), `simulator.presignMedia` y `dossier.requestUploadLink` (cargas), `clock.advance*`/`fireMilestone`/`moveEta`/`emitDispatchStatus` (movimientos del reloj), `clock.setRunning` (reloj en vivo), `clock.reset` (reinicios) y `operations.create` (operaciones nuevas); los turnos y los emails salientes los cuentan el worker y el pipeline. Las entradas de los procedimientos que cambian un legajo, una conversación, el registro o reinician un mundo se definen una sola vez en `packages/shared/src/console-inputs.ts` (`.strict()`, `clockId` opcional en el registro y el reinicio, obligatorio de hecho para `firm-qa`; `classifyDocument` = `{operationId, docVersionId, outcome: CLASSIFY \| DISCARD, docType?}`; `waiveObservation` con `operationId`; `consent.record` con `grantedAt` obligatorio): la consola, los escenarios (`scripts/scenarios/lib/console.ts`, que tipa la acción `console` desde `AppRouter` o, si el procedimiento aún no está registrado, desde ese esquema) y el router que los registra importan el mismo esquema.

| Router | Procedimientos |
|---|---|
| `operations` | `list`, `get` (con `processError` para mostrar "con error de proceso"), `create`, `documentUrl` (GET prefirmado 5 min, descarga PDF), `timeline` (incluye pendientes con motivo) |
| `dossier` | `approve` (**B R**), `reopen` (**B R**), `waiveObservation`, `classifyDocument`, `requestUploadLink` (`{operationId, docTypes}`: `create_upload_link` para el importador de la operación; en un mundo de invitado consume una unidad de `PDF_UPLOADS`, y cada carga en la página consume otra: el tope de 40 por día cuenta pedidos de link y cargas) |
| `conversation` | `take`, `release`, `send` |
| `escalations` | `list`, `resolve` |
| `registry` | `importers.list`, `importers.upsert`, `consent.record`, `consent.revoke`, `authorization.set`, `suppliers.list`, `suppliers.upsert`, `contacts.confirm`, `contacts.upsert`, `supplierBehaviour.set` |
| `clock` | `get` (modo, hora simulada, próximos eventos, `busy` y pendientes), `advance`, `advanceTo`, `advanceToNext`, `setRunning` (30 min), `fireMilestone`, `moveEta`, `emitDispatchStatus` (estos seis devuelven `WORLD_BUSY` con el mundo ocupado; aceptan `force` según `docs/architecture.md` §8), `reset` (**B**, del mundo del usuario) |
| `simulator` | `threads`, `sendText`, `tapButton`, `attachDocument`, `presignMedia`, `markRead` (solo con `ChannelModes.whatsapp = simulated`) |
| `mailbox` | `list`, `get` (filtrado por el estudio de la operación del hilo; cuerpo en texto plano) |
| `metrics` | `summary` (por pestaña: este mundo, lote con agente real, lote con agente guionado; cada KPI con N, fuente y rótulo), `export` |
| `audit` | `list`, `violations`, `decisionsByRule` |
| `tour` | Los pasos (títulos, textos y horas esperadas) tienen una sola fuente, `packages/web/src/views/tour/steps.ts`; el servidor no los duplica. `steps` (query): la operación 4471 del mundo del usuario (`operationId`, ETA) y **todos** sus temporizadores pendientes en orden de `dueAtSim`, de donde salen las horas de "Qué mirar" (nunca escritas a mano; `clock.get` lista solo los próximos cinco eventos del mundo). `run({action})` (mutation): un movimiento de un paso, corrido en el servidor con los procedimientos de arriba y sus mismos cercos (rol, login reciente, `WORLD_BUSY`, cuotas, auditoría): `advanceTo` (el paso 2 es 15/10 10:00), `advanceToNext`, `moveEta {shiftDays}` (desde la ETA actual de la 4471), `approve` (`dossier.approve`, **B R**) y `emitDispatchStatus`; sin la 4471 responde `NOT_FOUND TOUR_OPERATION_MISSING` |
| `activity` | `heartbeat` |
| `health` | `ping` (incluye `GET /v1/health` de `PlatformMock` con el rol del BFF) |
| `account` | `session` (para `GUEST`: estado del mundo `NONE` \| `CREATING` \| `READY` \| `EXPIRED` \| `CAPACITY` \| `FAILED` y, para un invitado público, actualiza `Leads.lastLoginAt`), `ensureWorld` (`GUEST`), `world` (`GUEST`, solo lectura), `usage` (`GUEST`): ver "Alta pública e invitados"; `preferences` y `setLanguage` (todo usuario: el idioma de la consola, ADR-0020). Cambio de contraseña y alta de TOTP no son procedimientos: la consola los hace directo contra Cognito con su access token (`ChangePassword`, `AssociateSoftwareToken`/`VerifySoftwareToken`); a un `GUEST` se los niega `AuthPreToken`, que le quita el scope `aws.cognito.signin.user.admin`, y `account.session` responde `canChangePassword`/`canSetUpMfa` en `false` |
| `signup` | `form`, `start`, `resend`, `confirm`: ver "Alta pública e invitados" |

## Acciones del `QaDriver`

Invocación directa (`lambda:InvokeFunction`) del rol `qa-runner`. Toda acción que muta exige un estudio de tipo QA (`firm-qa`, `firm-sim`, `firm-guest-test`) **y** un `clockId` permitido para esa acción (ADR-0005, `docs/test-plan.md` §4):

| Reloj | Acciones permitidas |
|---|---|
| `qa-*` | Todas |
| `GLOBAL#firm-qa` | Solo `wa.inbound`, `snapshot`, `op.settle`, `memory.inspect`, `console.clock.reset` (sin límite de frecuencia) y `metrics.get` |
| `GUEST#firm-guest-test` | Solo `world.destroy` (para que `SC-24` y `SC-25` prueben el primer ingreso), `snapshot`, `op.settle` y `platform.get` |
| Cualquier otro (`GLOBAL#firm-delta`, `GLOBAL#firm-norte`, `GUEST#firm-guest-<nn>`, `sim-*`) | Ninguna: `FORBIDDEN` (salvo `batch.run`, que crea sus propios relojes `sim-*` en `firm-sim`) |

`world.destroy` sobre `GLOBAL#firm-qa` → `FORBIDDEN` (ese mundo solo se reinicia). Las acciones `console.*` no llaman handlers sueltos: ejecutan `appRouter.createCaller(ctx)` con un principal armado en el servidor, `{sub: "qa", firmId: "firm-qa", brokerId, role: input.role ∈ BROKER | ANALYST, authTime: input.authTime ?? now}`, así que `firmProcedure`, `brokerProcedure` y `recentLoginProcedure` corren de verdad (un `authTime` viejo da 403). Solo la verificación de firma del JWT queda fuera (se prueba en `U` y `UI`, y el login real en `SC-24`). Toda acción lleva `idempotencyKey = runId/escenario/paso`; los ids de proveedor que genera (`wamid`, `Message-ID`) se derivan de esa clave.

| Acción | Qué hace |
|---|---|
| `world.create` | Crea un mundo (idempotente por `runId` y escenario, que puede llevar sufijo, p. ej. `sc18-rate`): reloj `qa-<runId>-<escenario>` en `PAUSED` con `startAtSim` pedido y época del contador; `operations: [{key, model, importer: "own" \| "<key>", supplier: "own" \| "<key>"}]` (por defecto `own`: importador `imp-qa-<runId>-<escenario>-<key>` con teléfono propio de la reserva QA por lease atómico y consentimiento y autorizaciones propios; proveedor propio con buzón `qa-<runId>-<escenario>-<key>-<código>@sim…` o `bounce+`/`complaint+<runId>-<escenario>-<key>@simulator.amazonses.com`, `docs/seed-spec.md` §14); números 7000-7999 reservados por lease; buzón del estudio `estudio-qa-<runId>-<escenario>@sim…`; filas `Platform`. Parámetros por operación o del mundo: `settings.rateLimitPerHour` (20 por defecto), `etaOverride`, `authorizations`, `consent`, `altContacts` (cada contacto alternativo del seed mapeado a `qa-<runId>-<escenario>-<key>-<código>-ops@sim…`), `supplierOverride`, `platformRow` |
| `world.destroy` | Borra, con condición `world = qa` y `clockId` `qa-*` (o `GUEST#firm-guest-test`): operaciones, temporizadores y schedules (`tm-q-*`, `tm-g-*` del mundo de `guest-test`), conversaciones, buzón, bitácora, `Parties` (importadores, proveedores, contactos, `ADDR#`, incluidos los de las direcciones de operación), claves de `Runtime` del mundo (`NONCE`, `LINK`, `RATE`, `IDEMP`, `CLOCK#`, `SESSION`, `TURN`, `OPSTATE`, `WORLDSTATE`, `PENDING`, leases; **nunca** `COUNTER#EPOCH#`), filas de `Platform`, `LegajoMetrics`, fallas del lector, objetos S3 bajo `qa/<runId>/` y los eventos y registros de Memory de los actores del mundo (`imp-qa-<runId>-<escenario>-*`, o los de `firm-guest-test`) con la misma purga en pasadas repetidas que el reinicio (`docs/architecture.md` §9.3); deja `Runtime/TOMB#<clockId>#<época>` para que un email tardío se descarte. Cualquier otro `clockId` `GLOBAL#*` o `GUEST#*` → `FORBIDDEN`. `world.destroy` no toca `Leads` ni el pool de Cognito: las cuentas y los leads del alta de `SC-26` (buzones `qa-signup-<runId>-*`) los leen y borran solo `signup.readCode`, `lead.inspect` y `lead.purge`, con la capacidad cercada del `QaDriver` de `docs/test-plan.md` §4.1 |
| `clock.advance`, `clock.advanceTo`, `clock.advanceToNext`, `clock.fireMilestone` | Igual que la consola |
| `clock.unfreeze({leadSec})`, `clock.freeze` | Paso de prueba del Scheduler, **atómico**: con el reloj todavía `PAUSED`, fija `pausedSimNow = próximoTemporizador.dueAtSim − leadSec` (120 por defecto; mínimo 90, para quedar lejos del umbral de encolado directo de 60 s), pasa a `RUNNING` y crea los schedules del horizonte de 1 h en la misma invocación, así que el schedule del próximo temporizador queda a `leadSec` segundos reales. Devuelve `{timerKey, dueAtSim, dueAtReal}`. `clock.freeze` lo vuelve a `PAUSED` y borra los schedules |
| `op.settle` | `{operationId, timeoutSec = 300}`: vuelve cuando la operación está quieta (`inFlight` vacío, ningún temporizador vencido) **y** no queda ningún pendiente abierto en `PENDING#<clockId>` de su reloj (correo hasta que su receptor lo procesó, no hasta el `Delivery` de SES; escaneos), y lo sigue estando 10 s; si no, falla al vencer el plazo listando lo pendiente (`docs/architecture.md` §7) |
| `wa.inbound` | Texto, botón (por acción, resuelve el nonce del último mensaje), documento; mismo camino que el simulador de teléfono; `wamid = wamid.SIM.<sha256(idempotencyKey)>` |
| `upload.presign`, `upload.done` | Actúa como el navegador en `/u/<token>` (el token sale del último mensaje con link) |
| `supplier.setBehaviour` | Comportamiento del simulador para una operación |
| `supplier.sendNow` | `{operationId, docTypes, version, body?}`: `SimMail` manda por SES real, desde el buzón registrado del proveedor de la operación a su dirección de operación (perfil `SIMULATOR`), los PDF de plantilla pedidos, encadenado al último mensaje (FL-058, FL-069); devuelve el `mailId` |
| `reader.setFaults` | Fallas del lector **del mundo** (`FAULTS#<clockId>`); nunca de `GLOBAL#*` ni `GUEST#*` |
| `feed.eta`, `feed.customs` | Eventos de la plataforma |
| `console.*` | Cualquier procedimiento del `appRouter` (`operations.*`, `dossier.*`, `conversation.*`, `registry.*`, `audit.*`, `metrics.*`, `clock.reset` con `clockId`) como un usuario de `firm-qa` con rol `BROKER` (`brk-qa-runner`) o `ANALYST` (`brk-qa-analyst`), dentro de la cerca de relojes de arriba |
| `email.inject` | Envía por SES con el perfil `QA` (`docs/architecture-integrations.md` §1), `{from: INJECTOR \| {partyContactId}, to, …}`: desde el buzón inyector `qainject-<runId>-<escenario>@sim…` (remitente no registrado, encabezados de auto-respuesta, direcciones que no resuelven, buzones simulados) o, para los negativos de identidad, desde una parte del mismo mundo QA que **no** es contacto `ACTIVE` del proveedor de la operación destinataria (contacto de otra operación en `SC-15/4`, contacto `PENDING_CONFIRMATION` en `SC-15/9`; un contacto `ACTIVE` de la destinataria → `INVALID`). Destinos: una dirección de operación de un reloj `qa-*`, una dirección `op-*` que no resuelve (número inexistente o etiqueta inválida) o un buzón simulado `qa-*@sim…` (correo que `SimMail` tiene que descartar como `SIM_UNTRUSTED`); `mailId` (`X-Legajo-Mail-Id`) derivado de la clave de idempotencia; devuelve `{mailId, sesMessageId}` |
| `mail.outcome` | `{mailId, timeoutSec}`: espera y devuelve `Runtime/PROBE#MAIL#<mailId>` (`outcome`, `reason`): `ENQUEUED`, `QUARANTINED`/`UNTRUSTED_SENDER`, `DISCARDED`/`THREAD_ADDRESS_INVALID` \| `THREAD_ADDRESS_UNKNOWN` \| `TOMBSTONED`, `AUTO_REPLY_IGNORED`, `SIM_UNTRUSTED`, `MAILBOX`, `SIM_REPLY_SCHEDULED`; permite asertar el motivo de un descarte en lugar de la ausencia de efectos |
| `email.redeliver` | Vuelve a invocar `InboundEmail` con el mismo recibo y el mismo objeto de S3 (duplicado) |
| `link.expire`, `nonce.expire` | Vence un link de carga o un nonce del mundo QA |
| `schedule.fireStale` | `{timerKey, version}`: despacha un temporizador con una versión vieja (FL-064) |
| `fence.probe` | Evalúa el cerco de destinatarios y la política para una dirección dada, en modo prueba (nunca llama a SES ni a EUM Social) |
| `guardrail.probe` | `ApplyGuardrail` de G1 con una cadena de ataque conocida; devuelve `GUARDRAIL_INTERVENED` o no (evidencia determinista de que G1 está activo) |
| `turn.forceFailure` | Hace fallar el próximo turno de una operación QA (timeout simulado del Harness) para probar el fallback |
| `event.poison` | Encola un evento `POISON` (con su `ADD` en `inFlight`, como todo productor) que el worker falla con visibilidad 0 hasta la DLQ; en el último intento el worker lo saca de `inFlight`, escribe `OPSTATE#<op>.processError` y audita `EVENT_DEAD_LETTERED` (`docs/architecture.md` §7, FL-098); devuelve el `eventId` |
| `dlq.find`, `dlq.delete` | `{clockId, eventId}`: solo un `eventId` de QA (`qa-<40 hex>`, derivado de la clave del paso); busca el mensaje de la DLQ `OperationEventsDlq.fifo` con ese `eventId` y cuyo cuerpo nombra ese `clockId` (sin mundo o ilegible → `FORBIDDEN QA_FENCE`, nunca se toma) (`ReceiveMessage` con visibilidad corta; los demás mensajes se devuelven sin tocar: los de mundos QA se informan por id en `others`, los de otros estudios o sin mundo legible solo como cantidad en `foreign`) y lo borra (`DeleteMessage`); nunca borra un mensaje que no creó el escenario |
| `alarm.history` | `{since}`: transiciones de la alarma de la DLQ (`DescribeAlarmHistory`) posteriores a `since` |
| `platform.get` | `{firmId, operationNumber}`: `GET /v1/operations/{n}?firm=` de `PlatformMock` con el rol del `QaDriver` (solo lectura; estudios de tipo QA) |
| `probe.mocks` | `GET /v1/health` de `ReaderMock` y `PlatformMock` con el rol del `QaDriver`, y un `HEALTH_PROBE` por la cola para probar el rol del worker contra el lector |
| `memory.inspect` | `{operationId \| actorId, waitForExtraction?: {sentinel: {keywords}, baseline: RecordKey[], afterTs, timeoutSec = 600, stableSec = 60, minQuietSec = 180}}`: `ListEvents` de la sesión de una operación y `ListMemoryRecords`/`RetrieveMemoryRecords` de su actor (asserts de PII y de reinicio). Cada registro vuelve con su namespace, su texto y su clave `RecordKey = {memoryRecordId, createdAt, contentSha256}`: el hash lo calcula el `QaDriver` sobre el texto del registro y los otros dos campos son los que trae `MemoryRecordSummary` (WP-28 los verifica en el `.d.ts` instalado; nunca `updatedAt`, que la API puede no devolver). `baseline` son las claves de un `memory.inspect` del mismo actor tomado justo antes del turno; un registro es **nuevo o cambiado** si su clave no está en `baseline` (una consolidación que reescribe un registro cambia su hash). Con `waitForExtraction`, sondea cada 15 s `ListMemoryRecords` de las tres estrategias del actor (`docs/architecture.md` §9.3): `/importers/{actorId}/preferences/`, `/importers/{actorId}/facts/` y `/importers/{actorId}/{sessionId}/summary/` (sesión vigente de la operación). La completitud es **por estrategia**: (1) **preferencias**: algún registro nuevo o cambiado de ese namespace coincide con el centinela (el centinela se busca solo en preferencias); (2) **hechos** y **resumen**, cada uno por separado: tiene un registro nuevo o cambiado, **o** su conjunto de claves no cambió durante `stableSec` después de que se cumplió (1) y pasaron al menos `minQuietSec` desde `afterTs` (el fin del turno), porque una estrategia que consolida puede actualizar un registro existente o no hacer nada (NO-OP) en vez de crear uno; (3) el conjunto de claves de los tres namespaces no cambió durante `stableSec`. Todo dentro de `timeoutSec`; si no, falla y nombra la estrategia que falta (o dice que el centinela no apareció). La vía de (2) por tiempo quieto vale porque las tres estrategias se disparan desde el mismo lote de eventos del turno (§9.3): una preferencia ya extraída del turno más `minQuietSec` acota a las otras dos. El resultado dice cómo completó cada estrategia (`MATCHED`, `NEW_OR_CHANGED` o `QUIET`) y el reporte del escenario lo muestra; `QUIET` en hechos es `warn`, no falla. El centinela es un conjunto de palabras clave, no una frase: coincide un registro que contiene alguna como palabra completa, sin distinguir mayúsculas ni acentos; así un extractor que parafrasea o traduce ("prefers messages without emojis") sigue coincidiendo. Los conjuntos están en `scripts/scenarios/lib/sentinels.ts`: preferencia A = {emoji, emojis, emoticon, emoticons, emoticones} ("preferiría mensajes sin emojis"), preferencia B = {usted, formal, formally, formalmente} ("tratame de usted, por favor") y hecho benigno F = {link, enlace} ("yo suelo subir los documentos por el link", un hecho del propio importador; F solo se busca en hechos y solo para el informe). A y B son dimensiones de tono: ninguna de sus palabras sale de plazos, del copy ni de los datos del seed. `scripts/scenarios/lib/sentinels.test.ts` falla si una palabra de A o de B aparece en `packages/bff/src/copy/*.ts`, en el checklist o en otro texto de `scripts/seed/data/` (incluidas las plantillas `worlds/*.json`), en los planes del Harness guionado (`tests/flows/**`) o en los textos de los demás pasos de `SC-09` y `SC-20`; si A y B comparten una palabra o una raíz; y si una frase de hecho no está en primera persona o nombra a un tercero (proveedor, exportador, despachante, estudio, transportista o una parte del seed). El `QaDriver` recibe las palabras y no conoce los escenarios. Sin esta espera, un assert negativo sobre una estrategia que todavía no extrajo pasaría vacío |
| `snapshot` | Operación, legajo, `processError` (`{eventId, type, atReal}` si un evento suyo fue a la DLQ), observaciones, temporizadores pendientes con `dueAtSim` y motivo, conversación (con salientes renderizados), escalamientos, bitácora y uso de turnos |
| `policyAudit.run`, `metrics.get` | Corre la auditoría del mundo y devuelve KPIs |
| `batch.run` | Lote de métricas en `firm-sim`: crea mundos desde las entradas del seed, los avanza con el reloj en pausa y el Harness real, con tope de turnos y de costo; escribe `LegajoMetrics` `source BATCH` con `agentMode REAL` y el costo en el reporte |
| `signup.readCode` | `{key, kind: SIGNUP \| EXISTING \| FORGOT, afterTs, timeoutSec = 120}`: solo para `SC-26`; el buzón es `qa-signup-<runId>-<key>@sim.legajo.demo.craftech.io`, armado por el `QaDriver` con su `runId` (nunca recibe un email). Lee de `…/poc/sim/` del bucket de correo el primer MIME posterior a `afterTs` dirigido exactamente a ese buzón y devuelve el código, el asunto, el idioma y el resultado del chequeo de palabras de ADR-0014; nunca el MIME (`docs/test-plan.md` §4.1) |
| `lead.inspect` | `{key}`: datos no personales del lead y de la cuenta de ese buzón (consentimientos con versión y fecha, idioma, UTM, referrer, fechas, `emailStatus` leído de `Runtime/MAILSTATUS#`, `noticeStatus`, `firmId` arrendado, cantidad de leads y de usuarios para ese hash); única lectura de `Leads` fuera de la lista cerrada de ADR-0015 §6 (`Bff`, `SignupDispatch`, `WorldJanitor`, `LeadNotice` y scripts del operador) |
| `lead.purge` | `{key}`: el mismo módulo que `npm run leads:delete` (`GUEST_DESTROY`, `AdminDeleteUser`, borrado de `LEAD`, `SIGNUP#` y contadores, `DELETED#`) para ese buzón; al final de `SC-26` y en `finally` |

## Alta pública e invitados

Diseño en ADR-0015; números en `packages/shared/src/guest-limits.ts`. Entradas y salidas zod `.strict()` en `packages/shared/src/signup.ts`. Tipos de cuota (`QuotaKind` de `guest-limits.ts`): `AGENT_TURNS`, `OUTBOUND_EMAILS`, `SIMULATOR_MESSAGES`, `CLOCK_MOVES`, `PDF_UPLOADS`, `NEW_OPERATIONS`, `WORLD_RESETS`, `LIVE_CLOCK` y `WORLD_PREPARATIONS` (esta última por cuenta, `QUOTA#ACCOUNT#<sub>#WORLD_PREPARATIONS#<hora>`); `QUOTA_EXCEEDED {kind, resetsAtReal}` suma `GLOBAL` (presupuesto global de mundos públicos) y llega a la consola como `TOO_MANY_REQUESTS` (HTTP 429) con `data.reason = QUOTA_EXCEEDED` y `data.quota`; `GUEST_WORLD_GONE` llega como 403 con `data.reason`. Ningún procedimiento de esta sección escribe `AuditLog` ni loguea el email: las métricas `LegajoAgent/Signup*` cuentan por motivo.

**Un solo flujo de alta** (ADR-0015 §1.4): sin modos ni lista de espera. Un lead lo escribe solo `finalizeSignup`, con la prueba de verificación de ADR-0015 §1.3; `signup.start` y `SignupDispatch` nunca escriben un `LEAD`. El cupo de mundos lleno no frena el alta: es el estado `CAPACITY` de `account.ensureWorld` y `account.world` en el ingreso (FL-132).

### Procedimientos tRPC

| Procedimiento | Auth | Entrada | Salida | Efectos |
|---|---|---|---|---|
| `signup.form` | `public` (WAF + OAC + `X-Origin-Verify`) | `{lang: "es" \| "en"}` | `{formToken}` (`formShownAt` firmado con la subclave `form`, válido 2 h) | Ninguno |
| `signup.start` | `public` + desafío de WAF (cookie del `GET /signup`) | `{formToken, email, password, name?, company?, jobTitle?, consents: {terms: true, contact: boolean}, consentVersions: {terms, privacy, contact}, lang, utm?: {source?, medium?, campaign?, term?, content?}, referrer?, website: ""}` (`website` es el honeypot; opcionales ≤ 80 caracteres; `consentVersions` tiene que ser igual a `LEGAL_VERSIONS`) | `{signupId, status: "CODE_SENT", resendAfterSec: 60}` \| `RATE_LIMITED {retryAfterSec}` \| `CAPACITY` (cupo global de altas nuevas o disyuntor abierto) \| `INVALID` (solo errores de forma: email mal formado, contraseña fuera de la política, casilla de términos sin tildar) | `Leads/SIGNUP#` (con la contraseña cifrada, subclave `signup-seal`) e invocación asíncrona de `SignupDispatch {kind: START}`; **ninguna llamada a Cognito** ni lectura del estado del email: el mismo trabajo y la misma respuesta en toda rama (ADR-0015 §1.1). `SignupDispatch` decide después: dominio reservado, propio o sin MX, `MAILSTATUS#`, honeypot, tiempo o cuota por email → `SUPPRESSED`; email nuevo → `SignUp` con ticket; `UNCONFIRMED` sin grupos → `AdminDeleteUser` + `SignUp`; invitado público existente (solo grupo `GUEST`, sin `custom:firmId`) → `ForgotPassword` con `intent signup-existing`; cualquier otra cuenta → `INELIGIBLE`, nada. Disyuntor abierto → `CAPACITY`. Nunca escribe un lead |
| `signup.resend` | `public` | `{signupId}` | `{status: "CODE_SENT", resendAfterSec}` \| `RATE_LIMITED` \| `EXPIRED` | Actualiza `SIGNUP#` e invoca `SignupDispatch {kind: RESEND}` (que llama a `ResendConfirmationCode`, `ForgotPassword` o nada según la rama); sin llamada a Cognito en el pedido; 60 s entre reenvíos, 3 por alta |
| `signup.confirm` | `public` | `{signupId, code, password}` | `{status: "CONFIRMED"}` \| `CODE_INVALID {attemptsLeft}` \| `EXPIRED` \| `RATE_LIMITED` | Según `SIGNUP#.branch`: `NEW` → `ConfirmSignUp`; `EXISTING_GUEST` → `ConfirmForgotPassword`; `SUPPRESSED`, `INELIGIBLE`, `FAILED` o sin rama → `CODE_INVALID` sin Cognito. Tras un éxito escribe `SIGNUP#.verifiedAt` y corre `finalizeSignup` (exige `verifiedAt` o la condición de ADR-0015 §1.3): `Leads/EMAIL#…/LEAD` (el único lugar donde nace un lead; condicional, fusiona datos opcionales y consentimientos nuevos si ya existía), sin importar si después hay cupo de mundo, `AdminAddUserToGroup GUEST` solo si el usuario no tiene grupos, invocación asíncrona de `LeadNotice`, borra `SIGNUP#`. Toda respuesta que no es `CONFIRMED` sale a los 1.500 ms del inicio; 5 códigos errados → `EXPIRED` |
| `account.session` | `guestBootstrapProcedure` y `firmProcedure` | `{}` | Además de lo actual, para `GUEST`: `{world: "NONE" \| "CREATING" \| "READY" \| "EXPIRED" \| "CAPACITY" \| "FAILED", guestKind, worldExpiresAtReal?}` (el mismo estado que `account.world`) | `Leads.lastLoginAt` = `auth_time` si es mayor (invitado público) |
| `account.ensureWorld` | `guestBootstrapProcedure` | `{}` | `{state: "CREATING"}` \| `{state: "READY", firmId, clockId}` \| `{state: "CAPACITY"}` | `PutItem` condicional de `Runtime/GUESTWORLD#<sub>` (no existe, o `DESTROYED`/`FAILED`, o `CREATING` de más de 5 min): un llamado concurrente pierde la condición y recibe el estado vigente sin arrendar nada; después arrienda `SLOT#GUEST#<nn>` (libre o liberado hace ≥ 20 min) con el mismo `leaseId` e invoca asíncrona a `WorldJanitor {kind: GUEST_CREATE, sub, nn, leaseId}`; responde en milisegundos. Sin cupo libre → `{state: "CAPACITY"}` sin arrendar cupo ni invocar `WorldJanitor` (`GUESTWORLD#<sub>` en `FAILED {reason: CAPACITY}`; la cuenta y el lead no cambian; el llamado siguiente reintenta, ADR-0015 §1.4). 10 llamados por hora por cuenta. Nunca crea el mundo dentro del pedido |
| `account.world` | `guestBootstrapProcedure` | `{}` | `{state: "NONE" \| "CREATING" \| "READY" \| "EXPIRED" \| "CAPACITY" \| "FAILED", firmId?, clockId?, since?}` | Ninguno (solo lectura de `GUESTWORLD#<sub>`); la consola lo consulta cada 2 s mientras dure `CREATING` y, con `READY`, refresca los tokens |
| `account.preferences` | `accountProcedure` | `{}` | `{language: "es" \| "en" \| null}` (`null` mientras la cuenta nunca eligió; el navegador decide entonces) | Ninguno (lectura de `Runtime/ACCOUNT#<sub>`) |
| `account.setLanguage` | `accountProcedure` | `{language: "es" \| "en"}` (`.strict()`) | `{language}` | `Runtime/ACCOUNT#<sub>`/`PREFS` creado o reemplazado (`UpdateItem` con `upsert`, sin TTL ni sello de mundo); el `sub` es el del token; el log dice solo el idioma |
| `account.usage` | `guestBootstrapProcedure` | `{}` | `{quotas: [{kind, window, used, limit, resetsAtReal}], globalBudget: "OK" \| "EXHAUSTED"}` (`window`: `TEN_MINUTES` \| `HOUR` \| `DAY`, una entrada por ventana de cada tipo) | Ninguno |

### Triggers de Cognito

| Trigger | `triggerSource` | Qué hace | Falla cuando |
|---|---|---|---|
| `AuthPreSignUp` | `PreSignUp_SignUp` | Verifica `ValidationData.ticket` = HMAC(`signup-ticket`, `username\|emailHash\|signupId\|exp`) con `exp` ≤ ahora + 120 s; no autoconfirma ni autoverifica | Sin ticket, ticket inválido o vencido (no se crea el usuario ni sale email) |
| | `PreSignUp_AdminCreateUser` | Deja pasar (solo el operador) | — |
| | `PreSignUp_ExternalProvider` | — | Siempre |
| `AuthCustomMessage` | `CustomMessage_*` | Plantilla es/en neutral (`docs/architecture-integrations.md` §8); cuenta y aplica las cuotas de emails de cuenta | Cuota por destinatario, dominio o total superada, o destinatario `BOUNCED`/`COMPLAINED` (salvo `_SignUp` y `_AdminCreateUser`, que solo cuentan) |
| `AuthPreToken` | `TokenGeneration_*` | Estampa `custom:firmId`, `custom:role`, `custom:isGuest`; un `GUEST` toma `firmId` solo de su fila `BROKER#` (sin fila: token sin `firmId`, válido solo para `guestBootstrapProcedure`); quita el scope de administración de cuenta a todo `GUEST` | Directorio ilegible (el login falla) |

### Lambdas y eventos

| Pieza | Entrada | Qué hace |
|---|---|---|
| `SignupDispatch` | `{kind: START \| RESEND, signupId, dispatchSeq}` (asíncrona, solo desde `Bff`, sin reintentos) | Descifra y borra la contraseña, valida el dominio (reservado, propio, sin MX o MX nulo), lee cuotas por email, `MAILSTATUS#` y disyuntor, clasifica el email (`ListUsers`, `AdminGetUser`, `AdminListGroupsForUser`) y llama a `SignUp`, `ResendConfirmationCode`, `ForgotPassword`, `AdminDeleteUser` + `SignUp` o a nada; escribe `SIGNUP#.branch` (ADR-0015 §1.1, §1.2); nunca escribe un lead ni invoca `LeadNotice` |
| `LeadNotice` | `{leadKey}` (asíncrona, desde `Bff` y `WorldJanitor`) | Aviso por SES de alta confirmada con el perfil `LEAD_NOTICE` (sin reloj: sin pendiente de correo, sin `X-Legajo-Mail-Id`, sin `Message` en `Conversations`); actualiza `noticeStatus` |
| `WorldJanitor` `GUEST_SWEEP` | Schedule cada hora | TTL de mundos públicos (`destroy_world`), `GUESTWORLD#` en `CREATING` de más de 5 min → `FAILED` con el cupo liberado, usuarios `UNCONFIRMED` sin grupos de más de 24 h, `SIGNUP#` que cumplen la prueba de verificación de ADR-0015 §1.3 (nunca un `EXISTING_GUEST` sin `verifiedAt`), reintento de avisos, retención de leads (una vez por día) |
| `WorldJanitor` `GUEST_CREATE` | `{sub, nn, leaseId}` (asíncrona, desde `Bff` y `QaDriver`) | `create_world('guest', firmId)`, fila `BROKER#brk-guest-<nn>` con `sub` y `leaseId`, `GUESTWORLD#<sub>` a `READY` (o `FAILED` y cupo liberado) |
| `WorldJanitor` `IDLE_GUEST_RESET` | Schedule diario 04:00 ART | `reset_demo_world` de los mundos reservados sin actividad en 24 h |
| `WorldJanitor` `GUEST_DESTROY` | `{firmId, reason: "REQUEST"}` (operador) | `destroy_world` del mundo de una cuenta |
| `ChannelEvents` | Evento de SES sin `Message` en `Conversations` (emails de cuenta, aviso de lead) | Rebote permanente o queja → `Runtime/MAILSTATUS#<emailHash>` (subclave `lead-email`), suma `RL#MAILBAD#<hora>` y abre `MAILBREAKER` al cruzar el umbral (ADR-0015 §3.2); nunca toca `Leads` |

### Scripts del operador

| Script | Qué hace |
|---|---|
| `npm run leads:export -- --out <archivo.csv> [--contactable] [--since AAAA-MM-DD]` | CSV de leads (columnas de ADR-0015 §6), fuera del repo, modo `0600`, celdas neutralizadas; imprime solo la cantidad |
| `npm run leads:optout -- --email <dirección>` | Consentimiento de contacto → `false` con fecha en `consentHistory` |
| `npm run leads:delete -- --email <dirección> [--yes]` | `GUEST_DESTROY` y `AdminDeleteUser`, borra `LEAD`, `SIGNUP#`, `MAILSTATUS#` y contadores; `DELETED#<leadId>`; imprime solo el `leadId` |
| `npm run console:invite -- --guest <n>` / `--guest-test` | Cuentas reservadas (ADR-0014 §7) |
