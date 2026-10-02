# Legajo listo · Powered by Craftech

**An AI coordination agent that gets every import file ready before the vessel arrives.**

Before a shipment reaches port, a customs brokerage firm (*estudio de despachantes de aduana*) needs
a complete import file (*legajo*) for it: commercial invoice, packing list and certificate of origin.
Today a broker's team chases those documents by hand: the importer on WhatsApp, the foreign supplier
by email in another language and another time zone, and every PDF checked by eye against the others.
Legajo listo does the chasing, keeps every party on the rules the firm defines, and leaves the file
ready for a human broker to approve.

## Who it is for

- **Customs brokerage firms in Latin America** that run many import operations at once and lose time
  and demurrage days to missing or inconsistent documents.
- **Brokers and analysts** inside those firms, who keep control: the agent proposes and coordinates,
  a person approves.
- **Importers**, who get clear requests in their own language on the channel they already use, and
  **foreign suppliers**, who get precise requests in English with the exact correction needed.

## How it works

1. **The importer is asked for the documents** on WhatsApp, with a template and quick-reply buttons,
   when a milestone before the ETA fires.
2. **The importer can hand the request over to the supplier.** The agent writes to the supplier by
   email in English, from an address that belongs to that operation, and defers the email to the
   supplier's business hours when the contact policy says so.
3. **Every PDF goes through a document reader** behind an OpenAPI contract. Legajo listo never reads
   documents itself: it acts on the reader's findings (for example, a gross weight on the packing
   list that does not match the invoice).
4. **The agent decides who must correct each finding** (importer or supplier), asks for it in the same
   thread and tracks the new version until the file is consistent.
5. **Deadlines move with the ETA.** When the vessel is expected earlier or later, milestones and
   follow-ups are rescheduled, and anything at risk is escalated to the firm.
6. **A human approves.** No tool can approve a file: approval happens in the console, by a broker
   with a recent sign-in.
7. **Customs dispatch statuses** (declaration made official, channel assigned, released) reach the
   importer with a plain explanation.

Guarantees enforced in code, not in the prompt: a contact policy (business hours, one reminder per
day, the 24-hour WhatsApp window, consent) decides every outgoing message; recipient fences stop any
message to an address outside the operation; every incoming message is treated as hostile (masked,
delimited and filtered by guardrails before the model sees it); every decision is audited.

## Try it

Open **https://legajo.demo.craftech.io**, choose **Try the demo**, and create an account with your
email (you will receive a verification code). Your account gets its own isolated world of synthetic
data: a fictitious brokerage firm, its importers, suppliers and operations, with a simulated clock
paused at 14/10 10:30 that only moves with the console's controls. The console's **Guided tour**
panel walks you through the main story (operation 4471) one button at a time; the table below is
generated from the same source (`packages/web/src/views/tour/steps.ts`) and `npm run tour:check`
fails if they differ.

A demo world is for trying the product, not for real work: it only accepts synthetic contacts, it
has daily usage limits, and it is reset after 24 hours without activity (your account stays; the
next sign-in creates a fresh world). If every demo world is taken when you first sign in, your
account is kept and the console says the demo is full right now; try again later or choose
**Let's talk**. Terms and privacy policy:
`https://legajo.demo.craftech.io/legal/terms.html` and `/legal/privacy.html`.

**Status**: the product is being built in waves (`docs/build-plan.md`, section 5 lists what is
missing). Public sign-up, demo worlds and some scripts named below arrive with those waves. The stage
is deployed for the first time only once the whole product is built and its checks pass, so **Try the
demo** works from that first deploy (`docs/adr/0015-alta-publica-de-invitados-y-leads.md` §1.4).

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

## What is real and what is simulated

| Piece | In this demo |
|---|---|
| Companies, people, operations, documents | **Synthetic.** Every name is fictitious and every PDF is generated. No real importer, supplier or firm appears anywhere. |
| AI agent | **Real.** Amazon Bedrock AgentCore (Harness, Gateway with five tool targets, Memory, Policy) with Bedrock Guardrails on input and output. |
| Supplier email | **Real end to end.** Amazon SES sends and receives every email; suppliers are simulated mailboxes on a domain of the demo, answered by a supplier simulator. |
| Importer WhatsApp | **Adapter implemented, simulated transport.** AWS End User Messaging Social is the target channel; until the WhatsApp Business Account is connected, a phone simulator in the console plays the importer. In a demo world it is always simulated. |
| Document reader | **Mock behind a real contract.** An OpenAPI contract (`packages/reader-contract`) with a mock implementation; a real reader plugs in behind the same contract. |
| Customs management platform | **Mock** of the dispatch statuses (`packages/platform-mock`). |
| Clock | **Simulated per world**, paused by default; every timer is an EventBridge Scheduler schedule that the clock knows how to advance. |
| Account emails (sign-up code, password recovery) | **Real**, sent by Amazon Cognito through Amazon SES. |
| Impact figures on the landing page | **Goals and assumptions**, labelled as such; never production results. |

## Architecture

```
 Importer (WhatsApp)          Supplier (email)                Broker / analyst (console)
        │                           │                                   │
 End User Messaging Social     Amazon SES (in/out)          CloudFront + WAF → React console
        │                           │                                   │
        └──────────► inbound Lambdas ◄──────────┘                 tRPC BFF (Lambda) + Cognito
                           │                                              │
                   SQS FIFO per operation ──► worker ──► Bedrock AgentCore Harness
                           ▲                    │            │ Gateway (MCP, IAM) → tool Lambdas
             EventBridge Scheduler (timers)     │            │ Memory · Policy (Cedar) · Guardrails
                                                ▼
                         outbound pipeline: contact policy → guardrail → checks → recipient fence → channel
                                                │
                   DynamoDB (one table per aggregate) · S3 (documents, mail) · document reader (OpenAPI)
```

- **Serverless only**, infrastructure as code with SST v4 on AWS (`us-east-1`), a single stage
  (`poc`) deployed only by CI.
- The agent speaks only through `send_whatsapp` and `send_email`; both go through one outbound
  pipeline (contact policy, output guardrail, deterministic checks, recipient fence, transport).
- Identity never comes from the model: every tool resolves the operation, firm and parties from a
  server-side session token.
- Each account's world is isolated by firm and clock; public demo worlds are capped, expire and have
  per-world usage limits.

Design documents (in Spanish): `docs/design-brief.md`, `docs/architecture.md`,
`docs/architecture-integrations.md`, `docs/adr/`, `docs/flows-catalog.md`, `docs/test-plan.md`;
glossary in `CONTEXT.md`. Serve them with `python3 -m http.server 8099 --bind 127.0.0.1` and open
`http://localhost:8099/docs/viewer.html`.

## Repository layout

| Path | What |
|---|---|
| `infra/` | SST v4 infrastructure (one module per capability) and the CI bootstrap template |
| `packages/shared` | Enums, ids, errors, dates and contracts shared by every package |
| `packages/bff` | tRPC BFF, agent tools, outbound pipeline, contact policy, channels, workers |
| `packages/web` | Landing page, sign-up and sign-in, broker console (React 19, Vite, Tailwind v4) |
| `packages/reader-contract`, `packages/reader-mock` | Document reader contract (OpenAPI + zod) and its mock |
| `packages/platform-mock` | Customs management platform mock |
| `scripts/` | Seed generator, scenario runner, lint guards, operator scripts |
| `tests/` | Local flow tests, the local UI server for Playwright, test cases |

## Run, test and deploy

Requirements: Node (version in `.nvmrc`) and npm.

```bash
npm ci
npm run typecheck
npm run lint && npm run lint:duplicates && npm run lint:wp-ownership
npm test                                  # unit and local flow tests (vitest)
npm run build -w packages/web
npm run test:ui                           # Playwright against the local UI server
npm run lint:neutral-surfaces             # visible texts stay neutral (also with -- --dist)
FORBIDDEN_TERMS="…" npm run lint:forbidden  # the operator's list lives outside the repository
```

- There is no local stage: everything is tested locally with unit, local-flow and UI tests, and in
  `poc` by CI.
- **Deploy**: only by CI (`.github/workflows/deploy.yml`) on a push to `main`, with OIDC roles created
  once by `infra/bootstrap/ci-role.yaml` (see its README). Never `sst dev` or a local `sst deploy`.
- **Scenarios in the deployed stage**: `.github/workflows/scenarios.yml` runs the scenario suite
  against `poc` through a fenced QA driver.
- **Operator scripts**: `npm run console:invite` (internal accounts), `npm run seed:load`, and the
  lead scripts `leads:export`, `leads:optout` and `leads:delete` (confirmed sign-ups; see the privacy
  policy).

## Privacy

Sign-up asks for an email and a password; name, company and job title are optional. Two separate,
unchecked consents are recorded with their date and text version: the terms and privacy policy
(required) and being contacted by Craftech about this solution (optional). Craftech keeps them only
once the email has been verified with the code. Craftech is the data
controller; the privacy policy explains retention and how to opt out or request deletion. Emails
never reach logs, audit trails or demo exports. Everything written or uploaded inside a demo world,
PDFs included, is deleted with the world when it expires or when deletion is requested.

## Submission notes

This repository is Craftech's entry to the AWS CDS Agentic AI Partner Hackathon. Nothing in the
published product mentions the contest: it is presented as a product for a future customer.

- **Access for testing**: anyone can create an account at
  `https://legajo.demo.craftech.io/signup`. Reserved guest accounts, with their own worlds and without the public limits on world capacity,
  are listed only in the private testing instructions of the submission form.
- **Pre-existing code**: the repository skeleton (SST and CI setup, the CI bootstrap template, lint
  scripts, the console shell and shared components, the own Cognito sign-in, the tRPC base, logging,
  retry and crypto helpers, the landing gallery, the AgentCore setup patterns and the agent
  definitions in `.claude/`) was reused from internal Craftech scaffolding built before the contest
  period. Everything specific to this product is new.
- **Third-party pre-existing code**: the process skills in `.claude/skills/` (`grill-with-docs`,
  `grilling`, `domain-modeling`) come from [mattpocock/skills](https://github.com/mattpocock/skills)
  (`skills/engineering/` and `skills/productivity/`); `grill-with-docs` is an expanded version that
  works standalone. They are development tooling for the agents that build the repository, not
  product code (see `.claude/skills/README.md`).
- Submission materials are in English; the intellectual property is Craftech's.
