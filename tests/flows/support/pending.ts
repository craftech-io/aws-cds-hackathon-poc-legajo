// What a pending local flow is waiting for (docs/test-plan.md §2: a cited file that cannot prove its
// flow yet declares it with `it.todo("[FL-xxx:pending] …")`, and `npm run flows:check -- --strict`
// fails on it). Each flow file names, per flow, the modules of the stage it drives that are not in the
// repository yet; when they land, the todo becomes a test over the in-process world (world.ts).
export const NEEDS = {
  worker: "OperationWorker, turns and Harness client (packages/bff/src/{worker,turns,agent}, WP-28)",
  policy: "contact policy engine (packages/bff/src/policy, WP-17)",
  pipeline: "outbound pipeline and messaging target (packages/bff/src/outbound, agent-tools/messaging, WP-25)",
  tools: "Gateway wrapper and targets (packages/bff/src/agent-tools/common, WP-22; operations and documents, WP-26; followups and handoff, WP-27)",
  intake: "document intake (packages/bff/src/intake, WP-26)",
  timers: "timers, milestones, clock and escalations (packages/bff/src/{timers,milestones,clock,escalations}, WP-27)",
  whatsapp: "WhatsApp adapter and InboundWhatsApp (packages/bff/src/channels/whatsapp, WP-20; handlers/inbound-whatsapp.ts, WP-29)",
  email: "email adapter and InboundEmail (packages/bff/src/channels/email, WP-19; handlers/inbound-email.ts, WP-29)",
  channelEvents: "SES events entry (packages/bff/src/handlers/channel-events.ts, WP-29)",
  feeds: "feed events and dispatch notices (packages/bff/src/{feeds,handlers/feed-events.ts}, WP-29)",
  simMail: "supplier simulator (packages/bff/src/sim-mail, WP-30)",
  services: "deterministic console and channel handlers (packages/bff/src/services/{consent,contacts,dossier-actions,conversation-control}, WP-43)",
  seed: "seed operations and reader catalog (scripts/seed/data, WP-08)",
  consoleRouters: "dossier and conversation routers (packages/bff/src/routers/{dossier,conversation}.ts, WP-33)",
} as const;
