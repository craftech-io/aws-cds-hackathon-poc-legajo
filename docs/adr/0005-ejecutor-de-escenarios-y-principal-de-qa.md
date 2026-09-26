---
status: accepted
---

# Los flujos se prueban en el stage desplegado con un ejecutor de escenarios y un principal de QA propio

"100 % probada" exige ver cada flujo con los servicios reales: el Harness decidiendo, SES entregando y recibiendo, el Scheduler disparando, el lector respondiendo. Las pruebas locales con un Harness guionado prueban la plomería, no el agente. Decidimos correr un **ejecutor de escenarios** (`scripts/scenarios/`) contra `poc` que maneja cada flujo a través de una Lambda **`QaDriver`** sin URL, invocable solo por el rol **`aws-cds-hackathon-poc-legajo-qa-runner`** que crea el bootstrap con trust OIDC del repo. Cada escenario trabaja en su propio **mundo** (estudio `firm-qa`, reloj `qa-*`, operaciones clonadas del seed) y asierta sobre estado persistido y bitácora.

## Considered options

- **Solo pruebas locales**: no prueban lo que falla en la realidad (permisos, propagación de IAM, entregas de SES, Cedar evaluando de verdad).
- **Playwright contra la consola desplegada con usuarios reales**: exige credenciales humanas en CI y prueba la UI, no el agente.
- **Invocar las Lambdas de producto directamente desde el runner**: cada una tiene su contrato de entrada y sus cercas; el runner tendría permisos amplios y reimplementaría medio sistema.
- **Un driver único con acciones acotadas** (elegida): una sola Lambda con permisos de consola más controles de mocks, cercada a `firm-qa`, y un rol que solo puede invocarla.

## Consequences

- El `QaDriver` existe en `poc`; toda acción que muta exige un estudio de tipo QA (`firm-qa`, `firm-sim`, `firm-judge-test`) y un `clockId` ∈ {`qa-*`, `GLOBAL#firm-qa`, `JUDGE#firm-judge-test`}, con una lista cerrada de acciones para los dos últimos: sobre `GLOBAL#firm-qa`, solo `wa.inbound`, `snapshot`, `op.settle`, `memory.inspect`, `console.clock.reset` y `metrics.get`; sobre `JUDGE#firm-judge-test`, solo `world.destroy`, `snapshot`, `op.settle` y `platform.get`. `world.destroy` nunca alcanza un reloj `GLOBAL#*` ni otro `JUDGE#*`. Sus borrados llevan condiciones sobre `world` y `clockId` y su IAM solo borra objetos bajo `qa/`, schedules `tm-q-*` (y los del mundo de `judge-test`) y su propio mensaje de la DLQ. Las acciones de consola ejecutan el `appRouter` real (`createCaller`) con un principal armado en el servidor, así que los middlewares de estudio, rol y login reciente corren de verdad; ningún atajo saltea política, Cedar ni el pipeline.
- Los mundos QA son congelados y sus ids (importadores, teléfonos, números, buzones, direcciones de operación, actores de Memory) derivan del `runId`, del escenario y de la clave de cada operación clonada; `op.settle` espera la quiescencia de una operación y los correos pendientes de su reloj antes de todo assert negativo, y los descartes se prueban por su motivo (`mail.outcome`).
- Lo que ve el jurado se prueba aparte en el stage con Playwright y una cuenta sintética (`SC-24`, siguiendo los mismos pasos que el README y tocando cada botón apenas se habilita; `SC-25`, primer login, reinicio y dos sesiones).
- Los mundos QA se borran al terminar y tienen TTL de 48 h como respaldo.
- La suite completa cuesta turnos de Bedrock: se corre a pedido y antes de cada entrega, con tope de turnos; en cada deploy solo corre el smoke.
- El rol `qa-runner` nace del bootstrap, no del deploy: CI no puede ampliarle permisos.
