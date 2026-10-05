---
status: accepted
---

# El agente usa Claude Sonnet 5.5

Decisión del CTO del 2026-10-05, después de probar la conversación por WhatsApp real: un turno del agente con Claude Opus 5 tardaba entre 38 y 43 s (de 4 a 6 herramientas, cada una con una vuelta completa al modelo). Para una conversación de WhatsApp eso es demasiado.

- **El modelo:** el agente y las tres estrategias de Memory pasan a `global.anthropic.claude-sonnet-5-5`, a través del perfil de inferencia con tags de la app (`<app>-<stage>-sonnet-5-5`, `infra/agentcore-spec.ts`). El nombre del perfil lleva el modelo, así un cambio de modelo crea el perfil nuevo antes de borrar el viejo y el agente nunca queda sin modelo.
- **El costo:** US$ 2 / 10 por millón de tokens de entrada / salida (Standard, Global, lista de precios de AWS del 2026-10-05), contra US$ 5 / 25 de Opus 5. Un turno típico cuesta de US$ 0,07 a 0,13. La tarifa vive en el seed (`scripts/seed/generate/ratecard.ts`).
- **Lo que no cambia:** el prompt, las herramientas, Cedar, `CP-*`, G1, G2 y la verificación determinística. La calidad de los textos la sostienen las reglas en código, no el tamaño del modelo.
- **Cómo se verifica:** los escenarios de agente corren en local con el modelo local (`agent-test`); la validación final en la nube sigue la regla de costo (se avisa antes y con techo).
