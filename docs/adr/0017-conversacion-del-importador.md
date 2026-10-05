---
status: accepted
---

# La conversación del importador: una sesión de Memory por chat, operación activa y el agente decide a qué operación va un mensaje

Decisión del CTO del 2026-10-05, después de la primera prueba con WhatsApp real. FL-019 mandaba a cada texto libre de un importador con varias operaciones abiertas una lista determinista "¿sobre cuál es tu mensaje?". No recordaba la elección y el modelo solo intervenía después de elegir. En un chat real eso no es una conversación: cada mensaje volvía a la lista. Este ADR reemplaza esa regla de FL-019 y amplía ADR-0011 (el agente habla solo por herramientas), sin cambiar ADR-0012 (política de contacto en código).

## 1. La memoria de la conversación vive en AgentCore Memory

- Los turnos que abre un mensaje del importador (`IMPORTER_MESSAGE`) usan **una sesión por chat del importador**, no una por operación. El `runtimeSessionId` es `importerSessionId` (lib/crypto.ts): HMAC de `imp|importerId|clockId|worldEpoch|sessionEpoch` con la subclave `runtime-session`.
- La memoria de corto plazo de AgentCore guarda así el chat completo, en cualquier operación en que haya corrido cada turno.
- Los demás disparadores (email del proveedor, hitos, lecturas, ETA) siguen en la sesión de su operación.
- La memoria de largo plazo no cambia: preferencias y hechos por importador, resumen por sesión.
- La purga de un mundo (`purgeTargetOf`) incluye la sesión del importador en cada `sessionEpoch` que alcanzó.

## 2. Operación activa en vez de lista

- Un **texto** de un importador con varias operaciones abiertas va a la **operación activa**. Es la del último mensaje, en cualquier dirección, de las últimas 24 h entre sus operaciones abiertas (`activeOperationOf`, channels/whatsapp/routing.ts). Las listas de elección del sistema no cuentan, y una copia movida gana el empate con su original.
- Con el chat quieto, va a la operación ancla de siempre: legajo en trabajo y ETA más próxima.
- **Ese texto abre un turno sin lista.**
- Un **PDF** con varias operaciones abiertas sigue esperando la elección determinista: un documento en el legajo equivocado cuesta caro, y la elección del importador es la evidencia.

## 3. El agente decide: `route_to_operation` y las otras operaciones

- **El sobre:** los turnos `IMPORTER_MESSAGE` traen en `<facts>` una línea `importerOperation` por operación abierta. Cada una lleva número, `current`, ETA, estado del legajo y documentos válidos sobre el total.
- **`get_operation`:** devuelve `otherOperations`, con número, `etaText`, estado, documentos válidos y faltantes. Así una respuesta que cruza operaciones pasa la verificación determinística: todo número que el agente escribe sale de un resultado de herramienta del turno.
- **`route_to_operation(toOperationNumber)`** (target `messaging`) es para cuando el mensaje es de otra operación:
  - la herramienta solo verifica: que sea una operación abierta del importador de la sesión, en su mundo, y no la actual;
  - el campo está fuera de `LAM-OP-SCOPE` a propósito, y el cerco es esa verificación;
  - al cerrar el turno, el worker (turns/routed.ts) copia el mensaje con `routedFrom` y encola el turno `IMPORTER_MESSAGE` de esa operación, con un `eventId` propio (`<wamid>#to#<operationId>`), en la misma sesión del importador;
  - una copia nunca se vuelve a mover.
- **Cuando no se entiende de qué operación habla,** el agente repregunta con un `REPLY` breve que nombra las operaciones candidatas: las opciones las escribe el modelo.
- **La regla `CONVERSATION` del system prompt:** decidir primero; si el mensaje es de otra operación, `route_to_operation` es la única llamada; una pregunta que cruza operaciones se contesta donde cayó; no volver a saludar en un chat en curso.

## 4. Lo que no cambia

- Cedar, `CP-*`, G1, G2 y la verificación determinística.
- El agente no aprueba nada, solo le escribe al importador por WhatsApp y nunca nombra un id interno.
- Los nonces de los botones siguen atando mensaje, operación, importador, teléfono y mundo.

## 5. Consecuencias

- 16 herramientas en el Gateway; el target `messaging` pasa a tener 4.
- FL-019, su caso de QA y SC-18/4..5 describen la operación activa y el movimiento. La lista queda solo para PDF (FL-017).
- Hay más turnos: un mensaje movido corre dos (el que lo mueve y el de la operación destino). El que lo mueve suele ser corto.
- El diagrama de arquitectura de la landing, `docs/architecture.md` §9.1, §9.3 y §13, y los textos de la submission describen la memoria por conversación.
