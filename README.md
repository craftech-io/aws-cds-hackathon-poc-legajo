# Legajo listo · Powered by Craftech

A coordination agent for customs brokerage firms (*estudios de despachantes de aduana*) in Latin
America, built by Craftech for the AWS CDS Agentic AI Partner Hackathon.

> This README is a placeholder while the project is being built. The full version (architecture
> diagram, what is real and what is simulated, how to reproduce the stack) is written at the end of
> the build (`docs/build-plan.md`, wave 6). The test instructions below are already generated from
> the console's guided tour.

## In one paragraph

Before a vessel arrives, the customs broker needs each import file (*legajo*) complete: commercial
invoice, packing list and certificate of origin. Legajo listo chases them: the importer on WhatsApp
(AWS End User Messaging Social; a phone simulator runs the channel until the WhatsApp Business
Account is connected) and the foreign supplier by email (Amazon SES, live end to end). Every PDF goes
through an external document reader behind an OpenAPI contract; the agent decides who must correct
each finding, reschedules deadlines when the ETA moves, and leaves the file ready for a human broker
to approve. All data is 100% synthetic.

## Test instructions

Sign in at `https://legajo.demo.craftech.io` with the judge account from the private Devpost
instructions. Each judge gets their own world of synthetic data whose simulated clock is paused at
14/10 10:30 and only moves with the console's controls. The console's **Guided tour** panel shows
these same steps with one button each; the table below is generated from the same source
(`packages/web/src/views/tour/steps.ts`) and `npm run tour:check` fails if they differ.

<!-- TOUR:START -->
| # | Step | Button / action | What to look at | Expected wait |
|---|---|---|---|---|
| 1 | Sign in | “Open operations” | Your own world with the clock paused at Oct 14 10:30 and operation 4471 pinned at the top as the main story. | First sign-in: ~10 s (your world is created) |
| 2 | First request | “Go to the 4471 request (Oct 15 10:00)” | Phone simulator: the pending-documents template with 4 buttons; the ETA − 7 days milestone fired at its own hour. | ~1 min (agent turn) |
| 3 | Hand over to the supplier | “Open the simulator” | Tap “Los manda el proveedor” (the supplier sends them), then “Sí, escribile” (yes, write to them). In the 4471 dossier the email is deferred by Qingdao business hours until Oct 15 22:00 (Oct 16 09:00 in Qingdao). | ~1 min per button (agent turn) |
| 4 | Email in English | “Advance to the next event” (→ Oct 15 22:00) | Demo mailbox: the email in English to the supplier, from the address of operation 4471. | ~1-2 min (turn + real email through SES to the simulated mailbox) |
| 5 | Reply and finding | “Advance to the next event” (→ Oct 15 22:10) | 4471 dossier: the real reply through SES, the packing list reading with a gross weight that does not match the invoice, the correction request in the same thread and the notice to the importer deferred until Oct 16 09:00. | ~2-4 min (reply through SES, reading, turn and correction through SES) |
| 6 | Correction | “Advance to the next event” (→ Oct 15 22:20) · “Advance to the next event” (→ Oct 16 09:00) | Wait between the two moves. Packing list v2 valid and dossier ready for review; at Oct 16 09:00 the two deferred notices reach the importer (nothing to do; the documents arrived). | ~2-3 min each time |
| 7 | ETA change | “Move ETA −2 days” | Milestones rescheduled in the 4471 dossier and the new-deadline notice in the simulator. | ~1 min (agent turn) |
| 8 | Approve | “Approve the dossier” | Your password is asked for: the human approval needs a recent sign-in. Then the dossier-approved notice in the simulator. | ~10 s |
| 9 | Customs dispatch | “Emit: declaration made official” · “Emit: orange channel” · “Emit: released” | The orange channel with its generic explanation in the simulator and, at the end, the release. | ~10 s per status |
| 10 | Metrics | “Open Metrics” | KPIs with N, source and label; policy decisions by rule next to the 0 violations. | — |
<!-- TOUR:END -->

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

Third-party pre-existing code: the process skills in `.claude/skills/` (`grill-with-docs`,
`grilling`, `domain-modeling`) come from [mattpocock/skills](https://github.com/mattpocock/skills)
(`skills/engineering/` and `skills/productivity/`); `grill-with-docs` is an expanded version that
works standalone. They are development tooling for the agents that build the repository, not product
code (see `.claude/skills/README.md`).
