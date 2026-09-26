---
status: accepted
---

# La política de contacto vive en código, no en el prompt

Quién puede recibir qué, cuándo y por dónde (opt-in, ventana de 24 h, horario de Argentina y del proveedor, un recordatorio por día, autorización para escribir al proveedor, cerco de destinatarios, alcance después de la aprobación) no puede depender de que el modelo lo recuerde. Decidimos un módulo puro `packages/bff/src/policy/` con el reloj de la operación inyectado, reglas con id (`CP-*`) y un orden de evaluación fijo; lo importan las tools de envío, el fallback de hitos, los mensajes del estudio y el trabajo `PolicyAudit`, que reevalúa cada envío después y cuenta violaciones.

## Considered options

- **Reglas en el system prompt**: no auditables, no verificables, inyectables.
- **Reglas en Cedar**: Cedar no ve la sesión, el opt-in, el horario del proveedor ni la ventana.

## Consequences

- Una denegación por tiempo no descarta el mensaje: lo difiere con un schedule y se reevalúa al dispararse.
- Cada decisión queda en la bitácora con sus `ruleIds`; la métrica "violaciones de política" tiene una definición verificable (debe ser 0).
- El agente puede consultar la política de forma indirecta (por ejemplo, `get_counterpart_profile` le dice si la ventana está abierta), pero nunca la decide.
