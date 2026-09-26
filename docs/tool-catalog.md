# Catálogo de tools y handlers

Tools expuestas al Harness por AgentCore Gateway (5 targets Lambda, **15 tools**), handlers deterministas de invocación directa (no están en el Gateway), procedimientos de la consola (tRPC) y acciones del `QaDriver`. Nombres en inglés, `snake_case`. Los schemas se escriben en JSON para leer; la fuente única es zod en `packages/bff/src/agent-tools/<target>/schema.ts`, de donde `npm run tools:build-schemas` genera el `inlinePayload` de cada target.

## Convenciones

| Convención | Regla |
|---|---|
| Target | Un `GatewayTarget` por dominio y una Lambda por target (`packages/bff/src/agent-tools/<target>/`); nombre en el Gateway `<target>___<tool>`; todo handler pasa por `createToolHandler` (`agent-tools/common/handler.ts`) |
| Principales | `harness` (rol de ejecución del Harness; **único principal del Gateway**) · `worker` (`OperationWorker`, handlers por import) · `channel` (`InboundWhatsApp`, `InboundEmail`, `SimMail`, `ChannelEvents`, `FeedEvents`, `DocumentIntake`) · `console` (BFF con JWT de Cognito: `brokerId`, `firmId`, `role`, `isJudge`, `authTime`) · `qa` (`QaDriver`, rol `qa-runner`; llega a los handlers de consola por el `appRouter` real con un principal armado en el servidor, ver "Acciones del `QaDriver`") · `scheduler` (`ScheduleDispatch`) |
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

---

## Target `operations` (`ToolOperations`)

### `get_operation`
Determinista · lee `Operations`, `Parties`, `Firms` · invocan: `harness`, `worker`, `console` · sin efectos.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "operation": {"operationNumber": "string", "firmName": "string", "importer": {"name": "string", "contactFirstName": "string"}, "supplier": {"name": "string", "country": "string", "timezone": "string", "language": "string"}, "vessel": "string", "carrier": "string", "regime": "string", "portOfLoading": "string", "eta": "string", "etaText": "string", "invoiceNumber": "string", "incoterm": "string", "dossierStatus": "DossierStatus", "control": "AGENT | BROKER", "dispatch": {"status": "string", "channel": "string"}}, "nowSim": "string", "nowSimText": "string", "error": "Error"}}
```

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

Reglas: destinatario = teléfono registrado del contacto del importador de la sesión (`LAM-RECIPIENT`); `text` fuera de la ventana → `TEMPLATE_REQUIRED` sin enviar; parámetros de plantilla que no están en los resultados del turno → `GROUNDING_FAIL`; cada botón se convierte en un nonce (`Runtime/NONCE#`, 7 días, ligado a `phoneHash` y `operationId`) y el título lo pone el código (`copy/es-AR.ts`); `UPLOAD` genera el link de carga si no hay uno vigente. `DEFERRED` crea `Operations/TIMER#DEFERRED_SEND#<id>` (y su schedule solo si el mundo está `RUNNING`).

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
| `approve_dossier` | `console` (`BROKER`/`JUDGE`, login ≤ 15 min), `qa` | `READY_FOR_REVIEW` → `APPROVED`; encola `OUTBOUND_SEND` con `legajo_aprobado` | `META` | `ACTION APPROVED` con `brokerId` |
| `reopen_dossier` | `console` (`BROKER`/`JUDGE`), `qa` | `APPROVED` → `REOPENED` con motivo; el agente retoma | `META` | `ACTION REOPENED` |
| `waive_observation` | `console` (`BROKER`, `ANALYST`, `JUDGE`), `qa` | Observación `WAIVED_BY_BROKER` con motivo; documento `VALID` si no quedan bloqueantes | `OBS#`, `DOC#` | `ACTION WAIVED` |
| `classify_unrecognized` | `console`, `qa` | El estudio asigna tipo a una versión `UNRECOGNIZED` o la descarta | `DOC#…#V#` | `ACTION` |
| `take_conversation` / `release_conversation` | `console`, `qa` | `control = BROKER` / `AGENT`; el release encola `AGENT_TURN(BROKER_RELEASED)` | `META.control` (con historia) | `ACTION TAKEOVER` / `RELEASE` |
| `broker_send` | `console`, `qa` | Mensaje del estudio al importador: encola `OUTBOUND_SEND` (`author = BROKER:<id>`); el worker lo pasa por el pipeline (ventana o plantilla) | `Conversations` | `ALLOW`/`DENY` |
| `advance_clock` | `console`, `qa` | `advance`, `advanceTo`, `advanceToNext`, `setMode` (`docs/architecture.md` §8); en `RUNNING` resincroniza los schedules en el mismo movimiento; desde la consola exige el mundo quieto (`WORLD_BUSY` con los pendientes; `force: true` solo si el pendiente más viejo pasó 5 min) | `CLOCK#`, `TIMER#`, Scheduler | `ACTION CLOCK_ADVANCED` / `CLOCK_FORCED` |
| `move_eta`, `emit_dispatch_status` | `console`, `qa` | Llaman a `PlatformMock` (que publica al bus `Feeds`); desde la consola exigen el mundo quieto (`WORLD_BUSY`), igual que `fire_milestone` | `Platform` | `ACTION` |
| `create_world` | `console` (primer login `JUDGE`), `qa`, `seed:load` (primera carga de un mundo de demo) | Fábrica de mundos (capacidad `WORLDS`, `docs/architecture.md` §14): lee la plantilla de `Seed/worlds/<plantilla>.json`; estudio, reloj en `PAUSED` con la época del contador `COUNTER#EPOCH#<clockId>` (1 solo la primera vez), clones con ids y partes según `operations` (`docs/seed-spec.md` §14), teléfonos (lease), buzones y números propios, dirección de operación con etiqueta HMAC reclamada con `ADDR#`, filas `POP#<firmId>#<número>` de `Platform` escritas directo; idempotente por (`runId`, escenario) o por estudio de jurado | Todo el mundo | `ACTION WORLD_CREATED` |
| `reset_demo_world` | `console` (`BROKER`/`JUDGE`, 1 cada 10 min por `clockId`), `qa` (sin límite, solo `GLOBAL#firm-qa`), `WorldJanitor`, `seed:load` (recarga de un mundo de demo existente) | `ADD 1` a la época (nunca la vuelve a 1), `TOMB#<clockId>#<época anterior>`, borra schedules, `TIMER#` e items del mundo (salvo `CLOCK#` y `COUNTER#EPOCH#`), borra y reescribe sus filas de `Platform` (la ETA vuelve a la de la plantilla), lo recarga de `Seed/worlds/<plantilla>.json` con ids nuevos de actor, sesión y dirección, y **purga Memory en pasadas repetidas** para los actores de la época anterior (primera pasada en la misma llamada; segunda 60 s reales después y listados cada 15 s hasta dos listados seguidos vacíos, tope 10 min, en `WorldJanitor` invocado en forma asíncrona; `docs/architecture.md` §9.3); capacidad `WORLDS` | Todo el mundo | `ACTION WORLD_RESET` |
| `record_activity` | `console` | Latido de 30 s (tiempo de consola observado, métrica secundaria) | `LegajoMetrics` | — |
| `policy_audit` | `scheduler`, `qa` | Dos chequeos por envío: decisión `ALLOW` con el mismo `messageId`, y reevaluación con las historias con fecha (`docs/architecture.md` §12) | `AuditLog VIOLATION` | — |
| `sim_reply` | `SimMail`, `scheduler` (`SIM_REPLY`), `qa` (`SEND_NOW`) | Respuesta del simulador de proveedor; `SEND_NOW` manda sin pedido pendiente | SES, `META.simState`, `TIMER#SIM_REPLY#` | `ACTION SIM_REPLY` |

## Procedimientos de la consola (tRPC)

Todo procedimiento pasa por `firmProcedure`; los marcados **B** exigen rol `BROKER` o `JUDGE` y los marcados **R** login ≤ 15 min. Las entradas de los procedimientos que cambian un legajo, una conversación, el registro o reinician un mundo se definen una sola vez en `packages/shared/src/console-inputs.ts` (`.strict()`, `clockId` opcional en el registro y el reinicio, obligatorio de hecho para `firm-qa`; `classifyDocument` = `{operationId, docVersionId, outcome: CLASSIFY \| DISCARD, docType?}`; `waiveObservation` con `operationId`; `consent.record` con `grantedAt` obligatorio): la consola, los escenarios (`scripts/scenarios/lib/console.ts`, que tipa la acción `console` desde `AppRouter` o, si el procedimiento aún no está registrado, desde ese esquema) y el router que los registra importan el mismo esquema.

| Router | Procedimientos |
|---|---|
| `operations` | `list`, `get` (con `processError` para mostrar "con error de proceso"), `create`, `documentUrl` (GET prefirmado 5 min, descarga PDF), `timeline` (incluye pendientes con motivo) |
| `dossier` | `approve` (**B R**), `reopen` (**B R**), `waiveObservation`, `classifyDocument`, `requestUploadLink` |
| `conversation` | `take`, `release`, `send` |
| `escalations` | `list`, `resolve` |
| `registry` | `importers.list`, `importers.upsert`, `consent.record`, `consent.revoke`, `authorization.set`, `suppliers.list`, `suppliers.upsert`, `contacts.confirm`, `contacts.upsert`, `supplierBehaviour.set` |
| `clock` | `get` (modo, hora simulada, próximos eventos, `busy` y pendientes), `advance`, `advanceTo`, `advanceToNext`, `setRunning` (30 min), `fireMilestone`, `moveEta`, `emitDispatchStatus` (estos seis devuelven `WORLD_BUSY` con el mundo ocupado; aceptan `force` según `docs/architecture.md` §8), `reset` (**B**, del mundo del usuario) |
| `simulator` | `threads`, `sendText`, `tapButton`, `attachDocument`, `presignMedia`, `markRead` (solo con `ChannelModes.whatsapp = simulated`) |
| `mailbox` | `list`, `get` (filtrado por el estudio de la operación del hilo; cuerpo en texto plano) |
| `metrics` | `summary` (por pestaña: este mundo, lote con agente real, lote con agente guionado; cada KPI con N, fuente y rótulo), `export` |
| `audit` | `list`, `violations`, `decisionsByRule` |
| `tour` | `steps` (con las horas de "Qué mirar" completadas desde los temporizadores pendientes de la 4471 que devuelve `clock.get`, nunca escritas a mano), `run(step)` (llama los procedimientos de arriba; el paso 2 es `clock.advanceTo` 15/10 10:00) |
| `activity` | `heartbeat` |
| `health` | `ping` (incluye `GET /v1/health` de `PlatformMock` con el rol del BFF) |
| `account` | `changePassword`, `mfa.setup` (rechazados para `JUDGE`), `session` (para `JUDGE`: si otra sesión actuó sobre el mundo en las últimas 2 h, devuelve el aviso de `docs/design-brief.md` §7.1) |

## Acciones del `QaDriver`

Invocación directa (`lambda:InvokeFunction`) del rol `qa-runner`. Toda acción que muta exige un estudio de tipo QA (`firm-qa`, `firm-sim`, `firm-judge-test`) **y** un `clockId` permitido para esa acción (ADR-0005, `docs/test-plan.md` §4):

| Reloj | Acciones permitidas |
|---|---|
| `qa-*` | Todas |
| `GLOBAL#firm-qa` | Solo `wa.inbound`, `snapshot`, `op.settle`, `memory.inspect`, `console.clock.reset` (sin límite de frecuencia) y `metrics.get` |
| `JUDGE#firm-judge-test` | Solo `world.destroy` (para que `SC-24` y `SC-25` prueben el primer login), `snapshot`, `op.settle` y `platform.get` |
| Cualquier otro (`GLOBAL#firm-delta`, `GLOBAL#firm-norte`, `JUDGE#firm-judge-<nn>`, `sim-*`) | Ninguna: `FORBIDDEN` (salvo `batch.run`, que crea sus propios relojes `sim-*` en `firm-sim`) |

`world.destroy` sobre `GLOBAL#firm-qa` → `FORBIDDEN` (ese mundo solo se reinicia). Las acciones `console.*` no llaman handlers sueltos: ejecutan `appRouter.createCaller(ctx)` con un principal armado en el servidor, `{sub: "qa", firmId: "firm-qa", brokerId, role: input.role ∈ BROKER | ANALYST, authTime: input.authTime ?? now}`, así que `firmProcedure`, `brokerProcedure` y `recentLoginProcedure` corren de verdad (un `authTime` viejo da 403). Solo la verificación de firma del JWT queda fuera (se prueba en `U` y `UI`, y el login real en `SC-24`). Toda acción lleva `idempotencyKey = runId/escenario/paso`; los ids de proveedor que genera (`wamid`, `Message-ID`) se derivan de esa clave.

| Acción | Qué hace |
|---|---|
| `world.create` | Crea un mundo (idempotente por `runId` y escenario, que puede llevar sufijo, p. ej. `sc18-rate`): reloj `qa-<runId>-<escenario>` en `PAUSED` con `startAtSim` pedido y época del contador; `operations: [{key, model, importer: "own" \| "<key>", supplier: "own" \| "<key>"}]` (por defecto `own`: importador `imp-qa-<runId>-<escenario>-<key>` con teléfono propio de la reserva QA por lease atómico y consentimiento y autorizaciones propios; proveedor propio con buzón `qa-<runId>-<escenario>-<key>-<código>@sim…` o `bounce+`/`complaint+<runId>-<escenario>-<key>@simulator.amazonses.com`, `docs/seed-spec.md` §14); números 7000-7999 reservados por lease; buzón del estudio `estudio-qa-<runId>-<escenario>@sim…`; filas `Platform`. Parámetros por operación o del mundo: `settings.rateLimitPerHour` (20 por defecto), `etaOverride`, `authorizations`, `consent`, `altContacts` (cada contacto alternativo del seed mapeado a `qa-<runId>-<escenario>-<key>-<código>-ops@sim…`), `supplierOverride`, `platformRow` |
| `world.destroy` | Borra, con condición `world = qa` y `clockId` `qa-*` (o `JUDGE#firm-judge-test`): operaciones, temporizadores y schedules (`tm-q-*`, `tm-j-*` del mundo de `judge-test`), conversaciones, buzón, bitácora, `Parties` (importadores, proveedores, contactos, `ADDR#`, incluidos los de las direcciones de operación), claves de `Runtime` del mundo (`NONCE`, `LINK`, `RATE`, `IDEMP`, `CLOCK#`, `SESSION`, `TURN`, `OPSTATE`, `WORLDSTATE`, `PENDING`, leases; **nunca** `COUNTER#EPOCH#`), filas de `Platform`, `LegajoMetrics`, fallas del lector, objetos S3 bajo `qa/<runId>/` y los eventos y registros de Memory de los actores del mundo (`imp-qa-<runId>-<escenario>-*`, o los de `firm-judge-test`) con la misma purga en pasadas repetidas que el reinicio (`docs/architecture.md` §9.3); deja `Runtime/TOMB#<clockId>#<época>` para que un email tardío se descarte. Cualquier otro `clockId` `GLOBAL#*` o `JUDGE#*` → `FORBIDDEN` |
| `clock.advance`, `clock.advanceTo`, `clock.advanceToNext`, `clock.fireMilestone` | Igual que la consola |
| `clock.unfreeze({leadSec})`, `clock.freeze` | Paso de prueba del Scheduler, **atómico**: con el reloj todavía `PAUSED`, fija `pausedSimNow = próximoTemporizador.dueAtSim − leadSec` (120 por defecto; mínimo 90, para quedar lejos del umbral de encolado directo de 60 s), pasa a `RUNNING` y crea los schedules del horizonte de 1 h en la misma invocación, así que el schedule del próximo temporizador queda a `leadSec` segundos reales. Devuelve `{timerKey, dueAtSim, dueAtReal}`. `clock.freeze` lo vuelve a `PAUSED` y borra los schedules |
| `op.settle` | `{operationId, timeoutSec = 300}`: vuelve cuando la operación está quieta (`inFlight` vacío, ningún temporizador vencido) **y** no queda ningún pendiente abierto en `PENDING#<clockId>` de su reloj (correo hasta que su receptor lo procesó, no hasta el `Delivery` de SES; escaneos), y lo sigue estando 10 s; si no, falla al vencer el plazo listando lo pendiente (`docs/architecture.md` §7) |
| `wa.inbound` | Texto, botón (por acción, resuelve el nonce del último mensaje), documento; mismo camino que el simulador de teléfono; `wamid = wamid.SIM.<sha256(idempotencyKey)>` |
| `upload.presign`, `upload.done` | Actúa como el navegador en `/u/<token>` (el token sale del último mensaje con link) |
| `supplier.setBehaviour` | Comportamiento del simulador para una operación |
| `supplier.sendNow` | `{operationId, docTypes, version, body?}`: `SimMail` manda por SES real, desde el buzón registrado del proveedor de la operación a su dirección de operación (perfil `SIMULATOR`), los PDF de plantilla pedidos, encadenado al último mensaje (FL-058, FL-069); devuelve el `mailId` |
| `reader.setFaults` | Fallas del lector **del mundo** (`FAULTS#<clockId>`); nunca de `GLOBAL#*` ni `JUDGE#*` |
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
