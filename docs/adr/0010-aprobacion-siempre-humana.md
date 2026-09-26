---
status: accepted
---

# La aprobación del legajo es siempre humana: no existe una tool que apruebe

El legajo aprobado es la base de una declaración ante la aduana que firma el despachante. Decidimos que **no exista ninguna tool del agente que apruebe**: el agente solo puede pedir revisión (`request_approval`, que pasa el legajo a `READY_FOR_REVIEW` y exige los tres documentos válidos o dispensados), y la aprobación es un procedimiento de la consola que exige rol `BROKER` y un login de 15 minutos o menos. Cedar refuerza la cerca (`CED-NO-APPROVE`: ninguna llamada a `request_approval` puede llevar una decisión; el campo `decision` está declarado en el schema de la tool como "never set; denied by policy" para que el statement sea válido y se dispare) y detrás la Lambda rechaza con zod `.strict()` cualquier valor de ese campo; la dispensa de observaciones también es humana. Un jurado aprueba con el rol `JUDGE`, que tiene los permisos de `BROKER` solo en su propio estudio.

## Considered options

- **Aprobación automática cuando el lector no marca nada**: traslada al modelo y al lector una responsabilidad profesional.
- **Tool de aprobación protegida por Cedar**: una cerca de más que alguien puede aflojar; si la acción no existe, ninguna inyección la alcanza.

## Consequences

- Una inyección que pida aprobar no tiene a qué llamar; el invariante "ningún `APPROVED` sin `approvedBy` humano" se verifica sobre la bitácora en cada escenario.
- El guion de la demo muestra al despachante revisando documentos, lecturas y cómo se resolvió cada observación antes de aprobar.
- La métrica de minutos humanos incluye la revisión: el producto reduce la persecución, no la responsabilidad.
