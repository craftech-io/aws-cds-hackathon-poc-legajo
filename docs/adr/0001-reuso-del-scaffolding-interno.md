---
status: accepted
---

# Reusamos el scaffolding interno de Craftech creado durante la hackathon

Craftech construyó, desde el 2026-09-14 y para esta misma hackathon, un repositorio interno con la infraestructura que cualquier agente sobre AWS necesita: SST v4 por stages, bootstrap del rol de CI por CloudFormation con cercas por tag, nombre, path IAM y ARN, patrón de AgentCore (Harness, Gateway con targets Lambda, Memory, Policy Cedar con permits por target, Guardrails, log group del runtime), SES entrante y saliente con cerco de destinatarios, login propio sobre Cognito, consola React con componentes compartidos, landing con galería, herramienta de capturas, tooling de seed determinista, lint de tamaño y duplicados, y las definiciones de agentes de `.claude/`. Decidimos arrancar Legajo listo **copiando y adaptando** ese scaffolding en lugar de escribirlo de nuevo, con el mapa exacto de qué se copia, qué se adapta y qué se descarta en `docs/reuse-map.md`. Todo lo específico del producto anterior (dominio, textos, marca, datos, investigación, un canal que este producto no usa) se descarta y ningún archivo del repo nuevo lo nombra.

## Considered options

- **Escribir todo de cero**: cero riesgo de arrastrar algo ajeno, pero repite semanas de trabajo ya pagado (el primer deploy del scaffolding falló cerrado siete veces antes del verde) y deja menos tiempo para lo que importa del producto: el agente y sus flujos.
- **Fork del repositorio interno**: más rápido todavía, pero arrastra el historial de commits, la marca y el dominio del producto anterior; el repo de la submission tiene que ser nuevo.
- **Copiar y adaptar archivo por archivo con un mapa** (elegida): repo nuevo sin historial ajeno, solo lo que sirve, y cada lección del primer deploy ya resuelta en el código copiado.

## Consequences

- El README declara el scaffolding como "internal Craftech scaffolding created during the hackathon period", como pide el reglamento.
- `docs/architecture.md` §16 lista cada lección heredada y dónde queda resuelta; `security` verifica con la lista externa de términos prohibidos que nada del producto anterior quedó en el árbol.
- Los paquetes cambian de scope (`@legajo/*`); ningún identificador, comentario ni texto conserva el nombre anterior.
- Lo que no existe en el scaffolding se escribe de cero: plataforma y lector mock, simulador de proveedor, simulador de teléfono, hitos por Scheduler, reloj por mundo, ejecutor de escenarios.
