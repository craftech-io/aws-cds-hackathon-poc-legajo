---
status: accepted
---

# Las dudas del importador se responden desde un checklist estructurado, sin Knowledge Base

El agente responde dudas del importador solo desde el checklist del estudio para tres tipos de documento: 19 ítems cortos y versionados. Decidimos guardar el checklist como items en `Firms/CHECKLIST#<docType>#v<nnn>`, devolverlo entero con `get_checklist` y fundar la respuesta con el guardrail G2 (contextual grounding contra los resultados del turno); lo que el checklist no cubre se escala (`OUT_OF_CHECKLIST`).

## Considered options

- **Bedrock Knowledge Base sobre S3 Vectors**: agrega vector bucket, índice, data source, ingestión y el nombre reservado `aws*` que el scaffolding tuvo que esquivar, para recuperar de un corpus que entra entero en un resultado de tool.
- **Checklist en el system prompt**: no versionable por estudio ni auditable por turno.

## Consequences

- Una respuesta cita un ítem que está en los resultados del turno; G2 bloquea lo que no se apoya en él.
- Si un estudio necesitara un corpus grande, se agrega una Knowledge Base detrás de la misma tool (y su vector bucket se nombra `kb-<app>-<stage>-…`).
