---
status: accepted
---

# Idiomas: español rioplatense para el estudio y el importador, inglés para el proveedor y los materiales de la submission

Las partes hablan idiomas distintos y los evaluadores del concurso leen inglés. Decidimos: consola, textos y plantillas al importador en **español rioplatense** (voseo), en `packages/bff/src/copy/es-AR.ts`; emails al proveedor en **inglés** (`copy/en.ts`, y `copy/en-supplier-sim.ts` para el simulador); landing con conmutador **es/en**; README, instrucciones privadas de prueba y materiales de submission en **inglés**; `CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs y casos de QA en **español (Argentina)**; código, identificadores, comentarios y commits en **inglés**.

## Considered options

- **Todo en inglés**: el importador y el estudio no son el público de un producto en inglés.
- **Multi-idioma completo del importador**: fuera de alcance para la POC.

## Consequences

- La verificación de salida controla el idioma por destinatario (inglés al proveedor, español al importador).
- Un texto tiene una sola fuente en `copy/`; el seed y los tests importan de ahí.
- Los Guardrails usan el tier `CLASSIC`, que cubre español e inglés; los temas denegados tienen definiciones y ejemplos en los dos.
