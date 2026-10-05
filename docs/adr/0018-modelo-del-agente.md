---
status: accepted
---

# El agente usa Claude Haiku 4.5, y lee en un solo paso

Decisión del CTO del 2026-10-05, después de probar la conversación por WhatsApp real. Un turno tardaba entre 38 y 43 s con Claude Opus 5 y unos 31 s con Claude Sonnet 5.5 (4 a 6 herramientas, cada una con una vuelta completa al modelo). Para un chat es demasiado; el CTO prioriza la velocidad sobre la redacción.

- **El modelo.** El agente y las tres estrategias de Memory usan `global.anthropic.claude-haiku-4-5-20251001-v1:0`, el Haiku más nuevo de Bedrock. Lo llaman a través del perfil de inferencia con tags de la app (`<app>-<stage>-<modelo>`, `infra/agentcore-spec.ts`). El nombre del perfil lleva el modelo, así un cambio de modelo crea el perfil nuevo antes de borrar el viejo y el agente nunca queda sin modelo.
- **Menos vueltas.** La regla `READ_FIRST` del prompt pide leer `get_operation` y `get_dossier` juntos, en la misma respuesta, sumando en ese paso `get_counterpart_profile` o `get_checklist` si el turno los necesita, y nunca releer.
- **"Escribiendo…".** Mientras el agente piensa, el importador ve su mensaje leído y la animación de "escribiendo…" de WhatsApp: `markReadTyping` del transporte vivo, al encolar el turno.
- **El costo.** US$ 1 / 5 por millón de tokens de entrada / salida (página de precios de Bedrock), contra US$ 5 / 25 de Opus 5. Un turno típico cuesta de US$ 0,035 a 0,065. La tarifa vive en el seed (`scripts/seed/generate/ratecard.ts`).
- **Habilitar un modelo.** El primer uso de un modelo de Anthropic en la cuenta crea una suscripción de AWS Marketplace. El rol del agente no tiene permisos de Marketplace, a propósito: la habilita una vez un principal administrador, con el OK del CTO porque acepta los términos de la oferta.
- **Lo que no cambia.** Las herramientas, Cedar, `CP-*`, G1, G2 y la verificación determinística: lo que no se negocia sigue en el código y no depende del tamaño del modelo.
