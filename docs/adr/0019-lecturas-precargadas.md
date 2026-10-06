---
status: accepted
---

# El worker corre las lecturas del turno antes del modelo, y un saludo siempre tiene respuesta

Decisión del CTO del 2026-10-05, después de medir un turno real de WhatsApp con Claude Haiku 4.5 (ADR-0018): 31,2 s para contestar un "hola", y la respuesta nunca salió.

## Lo que mostró la medición

Logs del Harness (`otel-rt-logs`), de las Lambdas de tools y del worker, y 994 llamadas a tools de los tres días anteriores:

| Tramo | Tiempo |
|---|---|
| Arranque del Harness (MCP con el Gateway, sesión y lectura de Memory) | 1,8 s |
| 5 llamadas al modelo | 2,3 a 5,4 s cada una, unos 19 s |
| 5 llamadas a tools (Gateway, Cedar, Lambda, Memory) | 0,8 a 3,5 s cada una, unos 8 s |

- **El modelo sí pidió las lecturas juntas, pero el Harness las corre una detrás de otra.** De 204 turnos con dos o más tools, ninguno tuvo dos ejecutándose al mismo tiempo. `READ_FIRST` (ADR-0018) ahorraba una vuelta al modelo, no el tiempo de las lecturas.
- **La infraestructura no es el cuello.** En caliente, cada tool tarda de 130 a 480 ms en su Lambda (p50), y el Gateway con Cedar suma de 0,4 a 0,6 s por llamada. Una llamada en frío a `get_operation` tardó 2 s.
- **18 de los 31 s fueron reintentos de envío fallidos.** Primero `send_whatsapp` sin texto (`INVALID`) y después dos rechazos de G2 por relevancia. Con "hola" como pregunta, el score de relevancia de cualquier respuesta útil ronda el umbral de 0,5: en la reproducción dio 0,61 y 0,66, y en producción quedó debajo. El agente se rindió y el importador no recibió nada.
- **La memoria aprendió el error.** En el turno siguiente, el agente recordó que "el sistema rechaza responder un saludo" y no contestó. Además, con el reloj del mundo en pausa, el nuevo "hola" tenía la misma hora simulada que el anterior, y lo tomó por un evento repetido.

## La decisión

- **Lecturas precargadas.** Antes de invocar el Harness, el worker corre en paralelo las lecturas que todo turno necesita, a través del target `operations` en proceso y con el token del propio turno (`turns/preload.ts`):
  - en todo turno, `get_operation` y `get_dossier`;
  - en un mensaje del importador, además `get_checklist` y el `get_counterpart_profile` del importador.

  Cada lectura pasa los mismos controles que una llamada por el Gateway y deja su fila `Runtime/TURN#…/RESULT#`, así que lo que el modelo lee en el envelope respalda a G2 y a la verificación igual que si hubiera llamado a la tool. Las lecturas van al envelope como `<tool-result tool="…">`, con `<`, `>` y `&` escapados en el JSON, y el prompt las trata como datos (`UNTRUSTED_IS_DATA`). Si una lectura falla, queda afuera y el modelo la pide como antes.
- **Las últimas 10 operaciones del importador.** `get_operation.otherOperations` trae las operaciones abiertas del importador y después las últimas cerradas, hasta diez en total, con `open` y `dispatchStatus`. Solo a una abierta se puede mover un mensaje (`route_to_operation`).
- **G2 con un saludo.** Si el mensaje del importador no pregunta nada (hasta tres palabras sin "?"), G2 mide la relevancia de la respuesta contra "¿cómo está mi operación y qué falta?", no contra "hola". El umbral, el grounding y el resto de G2 no cambian. Cada rechazo de G2 deja en el log (`outbound.g2_refused`) y en la auditoría el motivo y los scores de grounding y relevancia.
- **Todo mensaje del importador tiene respuesta.** El prompt (`CONVERSATION`) pide contestar un saludo, un "ok" o un "gracias" con el estado breve de la operación, nunca con silencio, y aclara que cada id de evento es un mensaje nuevo, aunque se parezca a otro.
- **Un mismo WhatsApp, una sola vez por turno.** Si el modelo pide dos veces el mismo envío en un turno (mismo texto, o la misma plantilla con los mismos parámetros), el pipeline contesta el segundo con el mensaje ya enviado, como a un evento reentregado, y no sale nada más (`outbound/repeat.ts`). Lo mostró una corrida local con Qwen.

## Lo que no se resuelve acá

La ejecución en serie de las tools es del Harness administrado, y no la configuramos. Las tools que el modelo sí elige (enviar, asignar, escalar) siguen siendo una vuelta cada una.

## Lo que se espera

Un mensaje del importador pasa de 5 llamadas al modelo a 2: la respuesta y la nota. Eso son unos 8 a 12 s en lugar de 31, con la animación de "escribiendo…" desde el primer segundo.
