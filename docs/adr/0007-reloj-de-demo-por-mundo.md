---
status: accepted
---

# Reloj de demo por mundo, en pausa por defecto, con épocas

Un invitado tiene que ver una historia de siete días en minutos, sin que otro invitado ni el ejecutor de escenarios le muevan el mundo, y encontrarla en el día 0 aunque entre semanas después de que la cargamos. Decidimos que cada operación pertenezca a un **reloj** (`clockId`) con dos modos: **`PAUSED`** (por defecto: la hora simulada guardada solo se mueve con los controles; no hay schedules reales y "Avanzar" despacha los temporizadores vencidos en orden) y **`RUNNING`** (`simNow = realNow + offsetMs`, schedules reales dentro de un horizonte de 1 h, vuelta automática a pausa a los 30 minutos). Relojes: `GLOBAL#<firmId>` para la demo del operador, `GUEST#<firmId>` para el mundo propio de cada invitado (creado en su primer ingreso desde una plantilla curada; ADR-0015), `qa-<runId>-<escenario>` para cada mundo del ejecutor (congelado; el tiempo simulado no deriva durante las esperas reales) y `sim-<batchId>` para el lote de métricas. Cada reloj tiene una **época** (`worldEpoch`) que sube en cada "Reiniciar demo", en cada recarga del seed y en cada mundo nuevo, que sale de un contador que nunca se borra (nunca vuelve a 1), y que entra en los identificadores de sesión y actor de AgentCore Memory y en la etiqueta de las direcciones de email de las operaciones. Toda regla de negocio recibe el reloj por inyección y ninguna llama `Date.now()`.

## Considered options

- **Un reloj global del stage**: una corrida del ejecutor movería el tiempo de la demo de un invitado.
- **Tiempo real y operaciones sembradas "a punto" de cada hito**: no permite ver una historia completa ni probar cambios de ETA.
- **Reloj por mundo en tiempo real con offset** (versión anterior de esta decisión): el mundo seguía avanzando solo, así que semanas después del video todas las operaciones habían corrido sus seguimientos y escalamientos (y gastado Bedrock); todos los evaluadores compartían un mundo; y en QA el tiempo simulado derivaba durante cada espera, lo que hacía oscilar las reglas de horario.
- **Reloj por mundo, en pausa por defecto, con épocas** (elegida). Se aparta de mantener la demo del estudio en tiempo real: el camino de schedules reales se prueba igual con un paso explícito (`SMK/4`, `SC-01/2`: en una sola acción, llevar el reloj en pausa a 120 s del hito y descongelarlo; esperar el disparo real; volver a congelar) y "Reloj en vivo" lo muestra a pedido.

## Consequences

- Toda fecha de negocio se guarda simulada (`…Sim`) y, donde importa para AWS, también real (`…Real`).
- La política de contacto evalúa horario y frecuencia en tiempo simulado; la ventana de 24 h de WhatsApp vivo usa tiempo real (ADR-0002).
- El reloj nunca retrocede salvo "Reiniciar demo", que recarga el mundo desde su plantilla, sube la época y borra la memoria del agente de ese mundo; ningún otro mundo cambia.
- Después de un reinicio, el agente no retoma la conversación de otro invitado ni recupera hechos extraídos de ella, y un email tardío dirigido a una operación del mundo anterior ya no resuelve.
- Un trabajo nocturno reinicia los mundos de invitado reservados inactivos y un barrido horario destruye los públicos vencidos (ADR-0015 §4); los mundos QA se destruyen al terminar y dejan una tumba para descartar correo tardío.
- Todo movimiento del reloj en `RUNNING` resincroniza los schedules pendientes del horizonte; desde la consola, ningún movimiento ocurre con el mundo ocupado (turno, evento o email en tránsito): la consola lo espera y lo explica (`WORLD_BUSY`).
- Los tokens, las URL prefirmadas, el login y los topes de costo usan siempre el reloj real.
