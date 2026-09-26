# Legajo listo · Powered by Craftech

A coordination agent for customs brokerage firms (*estudios de despachantes de aduana*) in Latin
America, built by Craftech for the AWS CDS Agentic AI Partner Hackathon.

> This README is a placeholder while the project is being built. The full version (architecture
> diagram, what is real and what is simulated, how to reproduce the stack, testing instructions for
> judges) is written at the end of the build (`docs/build-plan.md`, wave 6).

## In one paragraph

Before a vessel arrives, the customs broker needs each import file (*legajo*) complete: commercial
invoice, packing list and certificate of origin. Legajo listo chases them: the importer on WhatsApp
(AWS End User Messaging Social; a phone simulator runs the channel until the WhatsApp Business
Account is connected) and the foreign supplier by email (Amazon SES, live end to end). Every PDF goes
through an external document reader behind an OpenAPI contract; the agent decides who must correct
each finding, reschedules deadlines when the ETA moves, and leaves the file ready for a human broker
to approve. All data is 100% synthetic.

## Stack

SST v4 on AWS (`us-east-1`): Amazon Bedrock AgentCore (Harness, Gateway, Memory, Policy), Bedrock
Guardrails, Amazon SES, AWS End User Messaging Social, SQS FIFO, EventBridge Scheduler and bus,
DynamoDB, S3, Cognito, CloudFront. TypeScript monorepo (npm workspaces): React 19 + Vite + Tailwind v4
console, tRPC v11 BFF on Lambda, vitest and Playwright.

## Development

```bash
npm ci
npm run lint && npm run lint:duplicates && npm run typecheck && npm test
npm run build -w packages/web
```

There is a single stage, `poc`, deployed only by CI (`.github/workflows/deploy.yml`) on a push to
`main`. The CI roles are created once by `infra/bootstrap/ci-role.yaml` (see its README).

## Scaffolding

The repository skeleton (SST and CI setup, CI bootstrap template, lint scripts, console shell and
shared components, own Cognito login, tRPC base, logging, retry and crypto helpers, landing gallery,
agent definitions in `.claude/`) was reused from internal Craftech scaffolding created during the
hackathon period. Everything specific to this product is new.
