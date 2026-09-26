---
status: accepted
---

# Un temporizador por evento futuro, con a lo sumo un schedule de EventBridge Scheduler, sin Step Functions

Cada operación tiene cinco hitos relativos a la ETA (ETA − 7 días, − 5, − 3, − 48 h y el arribo) y la ETA se mueve; además hay envíos diferidos por horario, seguimientos que agenda el agente, respuestas demoradas del simulador de proveedor, reintentos del lector, controles de contacto después de un rebote y reintentos de rebotes transitorios. Decidimos que **todo evento futuro sea un temporizador** `Operations/TIMER#<kind>#<id>` con su `dueAtSim`, indexado en un GSI por reloj (`CLOCK#<clockId>` + `dueAtSim`), y que cada temporizador tenga **a lo sumo un schedule `at()`** de EventBridge Scheduler (`tm-<mundo>-<timerId>`, `ActionAfterCompletion DELETE`, destino una Lambda que encola el evento en la cola FIFO de la operación o entrega la respuesta al simulador). Reprogramar es actualizar el item y su schedule con una versión para ignorar disparos viejos. Un mundo con el reloj en pausa no tiene schedules: el reloj despacha los vencidos desde el índice (ADR-0007).

## Considered options

- **Una máquina de Step Functions por operación esperando con `Wait`**: el cambio de ETA obliga a cancelar y relanzar ejecuciones, y una ejecución que espera semanas es difícil de ver y de corregir. Además arrastra el bug de serialización del timeout de SST 4 que el scaffolding tuvo que parchear.
- **Un barrido periódico (cron) de vencidos**: simple, pero la precisión depende del período y cada barrido lee todas las operaciones.
- **Un schedule por hito y mecanismos propios para el resto** (versión anterior de esta decisión): las respuestas del simulador, los reintentos y los controles quedaban fuera del índice, así que avanzar el reloj no los alcanzaba y esperaban tiempo real.
- **Un temporizador indexado por evento futuro** (elegida): un solo mecanismo que el reloj de demo sabe avanzar, precisión al minuto cuando corre en tiempo real, y visible en la consola como "pendiente" con su motivo.

## Consequences

- El rol de CI cerca el grupo `aws-cds-hackathon-poc-legajo-*` por nombre (el provider lee tags recién creados antes de que IAM los vea).
- Todo principal que crea o cambia temporizadores tiene la capacidad `TIMERS` (acciones del Scheduler sobre el grupo y `iam:PassRole` del rol de invocación condicionado a `scheduler.amazonaws.com`).
- Un hito que queda en el pasado al adelantarse la ETA se dispara una sola vez por código; en un mundo en tiempo real, un schedule con menos de 60 s de margen no se crea: se encola directo.
- `clock/advance.test.ts` tiene un caso por tipo de temporizador.
