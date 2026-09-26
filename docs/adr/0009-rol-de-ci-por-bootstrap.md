---
status: accepted
---

# El rol de deploy de CI y el rol de QA nacen de un template de CloudFormation aplicado una vez, fuera de SST

GitHub Actions asume un rol por OIDC para correr `sst deploy --stage poc`, así que ese rol tiene que existir antes del primer deploy, y la cuenta `craftech-demos` es compartida con otros proyectos. Decidimos, igual que en el scaffolding, que el rol `aws-cds-hackathon-poc-legajo-github-deploy`, sus políticas administradas, la permissions boundary `…-ci-boundary`, el rol `…-qa-runner`, el key-value store del Router y la response headers policy de la consola nazcan de `infra/bootstrap/ci-role.yaml`, que el operador aplica una vez por cuenta, y que SST no gestione ninguno. `infra/ci.ts` solo comparte nombres y estampa path IAM y boundary en todo rol del app.

## Considered options

- **Que SST cree el rol**: el primer deploy saldría de una laptop con credenciales de administrador y el rol quedaría en el state que él mismo escribe, con permiso para ampliarse.
- **Reusar un rol compartido de la cuenta**: alcanzaría recursos de otros proyectos.
- **Crearlo a mano**: no es reproducible.

## Consequences

- Orden de deploy con un paso previo del operador (`docs/architecture.md` §15); sin él, el primer deploy falla (la boundary no existe).
- Trust con `StringEquals` sobre el `sub` en sus dos formas y los claims numéricos del repo y la organización; los jobs de CI no declaran `environment:`.
- Un permiso faltante falla cerrado; se agrega un statement con su cerca y su justificación, nunca un comodín. Límites: 51.200 bytes el template, 6.144 caracteres cada política; `ci-role.test.ts` los controla.
- `sst remove` no borra estos recursos; se borran eliminando el stack del bootstrap después de remover los stages.
