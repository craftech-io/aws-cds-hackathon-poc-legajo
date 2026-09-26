// English texts of the public landing, with the same shape as the Spanish ones (copy-es.ts): the
// language judges read (docs/adr/0008-idiomas.md). Words for documents, statuses and parties come
// from packages/bff/src/copy/en.ts; WhatsApp messages stay in Spanish with their fixed English gloss.
import { labelsEn } from "@legajo/bff/copy/en";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import type { ObservationCode } from "@legajo/shared";
import { formatNumber } from "../../lib/format";
import { JUDGES_SIGN_IN, type LandingCopy } from "./copy-es";

export const en: LandingCopy = {
  lang: { code: "en", switchTo: "Español", switchLabel: "View the page in Spanish" },
  nav: {
    label: "Page sections",
    problem: "The problem",
    story: "The story",
    real: "Real and simulated",
    how: "How it decides",
    console: "The console",
    architecture: "Architecture",
    judges: "Judges",
  },
  hero: {
    eyebrow: "A coordination agent for customs brokerage firms in Latin America",
    title: "Every import file complete before the vessel arrives.",
    lead: "Legajo listo chases the commercial invoice, the packing list and the certificate of origin of every import: the importer on WhatsApp and the foreign supplier by email. Every PDF goes through an external document reader; the agent decides who must correct each finding, reschedules the deadlines when the ETA moves and leaves the file ready for the customs broker to approve.",
    note: "Demo for the AWS CDS Agentic AI Partner Hackathon. 100% synthetic data: no real companies, people or shipments.",
    story: "See the story",
  },
  cta: { judges: JUDGES_SIGN_IN, goToConsole: "Go to the console" },
  problem: {
    title: "Three documents, two languages and a vessel that does not wait",
    lead: "Before the vessel arrives, the customs broker needs the complete file (legajo) of every import. The documents are with the importer or, almost always, with a foreign supplier who answers in English, from another time zone and by email.",
    items: [
      { title: "Manual chasing", text: "The broker writes to the importer on a personal WhatsApp and the importer forwards emails to the supplier. Nobody knows what was asked, of whom or when." },
      { title: "Late corrections", text: "A weight that does not match or a badly issued certificate shows up when the vessel has already arrived." },
      { title: "Nobody knows who must fix what", text: "The importer receives a problem that is not theirs and does not know what to do with it." },
      {
        title: "The ETA moves",
        text: "The carrier changes the arrival and the deadlines go stale. Every day of delay costs money: the console estimates it with labelled assumptions (≈ 5 free days at the port and ≈ USD 160-180 per day, assumption), never as a fact.",
      },
    ],
  },
  story: {
    eyebrow: "The story",
    title: "Operation 4471: from the first request to the release",
    lead: "Norpampa Insumos SRL imports from Qingdao Bluewave Textiles on the vessel Austral Aurora, estimated arrival 22/10. The commercial invoice is already valid; the packing list and the certificate of origin are missing. Every name is fictitious. The demo clock is paused: simulated time only moves with a button.",
    tabsLabel: "Scenes of the story",
    sceneLabel: (at: number, of: number): string => `Scene ${at} of ${of}`,
    previous: "Previous",
    next: "Next",
    play: "Play",
    pause: "Pause",
    simTime: "Simulated time",
    scenes: {
      request: {
        channel: "WhatsApp · template",
        title: "The first request, seven days before arrival",
        text: "The ETA − 7 milestone starts an agent turn. The importer gets the approved template with what is missing and four buttons: upload documents, the supplier sends them, ask a question or stop notices.",
      },
      delegate: {
        channel: "WhatsApp · contact policy",
        title: "“The supplier sends them”",
        text: "The importer delegates with a button and confirms the registered contact. It is 21:00 in Qingdao: the contact policy defers the email until 09:00 there, and the agent tells the importer.",
      },
      supplier: {
        channel: "Email · Amazon SES",
        title: "The supplier answers by real email",
        text: "The request goes out in English from the operation's address. The simulated supplier replies through SES with the PDFs, the document reader flags the packing list's gross weight (12,480 kg against 12,840 kg on the invoice) and the agent asks for the correction in the same thread.",
      },
      noAction: {
        channel: "WhatsApp · 09:00",
        title: "“You do not have to do anything”",
        text: "The importer only hears what concerns them: the correction is the supplier's. The notice goes out at 09:00, when Argentina's hours allow it. With version 2 of the packing list the file is ready for review.",
      },
      question: {
        channel: "WhatsApp · guardrails",
        title: "A question with an answer, and a limit",
        text: "“Does the certificate have to be signed?” is answered from the firm's checklist. “Which tariff classification applies?” is customs advice: the guardrail blocks it before the model, the fixed answer goes out and the case goes to the broker.",
      },
      eta: {
        channel: "Carrier · milestones",
        title: "The ETA moves two days earlier",
        text: "The carrier reports a new arrival. The code reschedules the pending milestones without the model; the agent only communicates the new deadline.",
      },
      approval: {
        channel: "Console · WhatsApp",
        title: "Human approval and dispatch status",
        text: "With the three documents valid, the broker reviews readings and observations and approves after a recent sign-in: no agent tool can approve. Then come the orange channel, with a generic explanation, and the release.",
      },
      policy: {
        channel: "Decision log",
        title: "Every decision, with its rule",
        text: "The contact policy lives in code and leaves every decision in the decision log. An audit re-evaluates every sent message with the data of that moment: the target is zero violations.",
      },
    },
    deferrals: {
      supplierHours: "Pending: deferred by the supplier's hours until 16/10 09:00 in Qingdao (15/10 22:00 in Buenos Aires).",
      importerHours: "Pending: the 22:10 notice was deferred until 09:00 by Argentina's hours.",
    },
    decisionsTitle: "Decisions of the contact policy and of Cedar",
    outcomes: { deferred: "Deferred", denied: "Denied" },
    decisions: {
      "CP-HOURS-SUPPLIER": { attempt: "Email to the supplier at 21:00 in Qingdao", outcome: "Goes out at 09:00 there" },
      "CP-HOURS-AR": { attempt: "Notice to the importer at 22:10", outcome: "Goes out at 09:00" },
      "CP-ONE-PER-DAY": { attempt: "A second reminder on the same day", outcome: "Not sent" },
      "CP-OPTIN": { attempt: "WhatsApp to an importer without opt-in", outcome: "Not sent; the case goes to the firm" },
      "CP-NO-FOREIGN-LINKS": { attempt: "A text with a link that is not the upload link", outcome: "Not sent" },
      "CED-NO-APPROVE": { attempt: "The model tries to approve the file", outcome: "Approving always belongs to a person" },
    },
    eta: {
      event: "The carrier reports a new estimated arrival: 22/10 → 20/10.",
      tableLabel: "Milestones rescheduled by the code",
      milestone: "Milestone",
      before: "Before",
      after: "Now",
      milestones: {
        followupFinal: "Last reminder (ETA − 3 days)",
        escalation: "Escalation if anything is missing (ETA − 48 h)",
        arrival: "Arrival",
      },
    },
    reader: {
      title: "Document reader result",
      version: (version: number): string => `version ${version}`,
      responsible: "Responsible",
      found: "on the packing list",
      expected: "on the invoice",
    },
    labels: labelsEn,
    observation: (code: ObservationCode): string => OBSERVATION_LABELS[code].en,
    kg: (value: number): string => `${formatNumber(value).replace(/\./g, ",")} kg`,
  },
  real: {
    title: "What is real and what is simulated",
    columns: {
      real: { title: "Real in this demo", text: "Every AWS service: SES end to end (sending and receiving), AgentCore Harness, Gateway, Policy and Memory, Bedrock Guardrails, EventBridge Scheduler and bus, SQS, DynamoDB, S3, Cognito and CloudFront." },
      simulated: { title: "Implemented, running in simulated mode", text: "The WhatsApp adapter for AWS End User Messaging Social: tested with fixtures, it runs with a phone simulator until the WhatsApp Business Account is connected." },
      mocks: { title: "Simulated systems", text: "Document reader (OpenAPI contract; an external product in real life), customs management platform, carrier, customs and suppliers." },
      data: { title: "Data", text: "100% synthetic, generated with a fixed seed. Every name is fictitious." },
    },
  },
  how: {
    eyebrow: "How it decides",
    title: "What does not depend on the model",
    lead: "The model decides what to do in each turn. What is not negotiable lives in code, in the Cedar policies and in the guardrails.",
    items: [
      { title: "Approval is always human", text: "No agent tool can approve: Cedar denies it, and the console asks the broker for a sign-in less than 15 minutes old." },
      { title: "The policy lives in code", text: "Opt-in, the 24-hour window, each party's business hours, one reminder per day and the recipient fence: rules that decide before every send, never the prompt." },
      { title: "The agent speaks only through tools", text: "Every WhatsApp message and every email goes through the same outbound pipeline; the final text of each turn is an internal note that is never sent." },
      { title: "Reading documents is not ours", text: "Every PDF goes to an external document reader through its OpenAPI contract. Whatever the reader does not recognize is resolved by the broker." },
      { title: "The model does not decide identity", text: "The importer is recognized by the registered phone and the supplier by the operation's address, its confirmed contact and DMARC. No id written by the model is ever used." },
      { title: "Everything inbound is hostile", text: "Tax ids, national ids, bank accounts, cards and IBANs are masked before they are stored; the text travels escaped inside a random delimiter and goes through a guardrail before the model." },
    ],
  },
  console: {
    eyebrow: "The firm's console",
    title: "Everything that happened, with its reason",
    lead: "Operations with their next event, the detail of each file with readings, observations and pendings, the demo clock, the phone simulator, the demo mailbox, metrics with their N and label, and the decision log.",
    pending: "Console captures are taken on the deployed stage, with the synthetic judge test account, after a real run.",
    uploadTitle: "The importer's upload page, with no login",
  },
  media: {
    placeholderTitle: "Capture pending from the stage run",
    placeholderNote: "capture pending",
    localTitle: "Capture of the local test server: the agent is replaced by a fixed plan",
    localNote: "local environment, scripted agent",
    items: {
      "console-operations": { alt: "Operations view of the console with operation 4471 pinned on top", caption: "Operations: 4471 pinned as the main story, with its next event." },
      "console-dossier": { alt: "Detail of the file of operation 4471", caption: "File detail: documents, readings, observations and pendings with their reason." },
      "console-simulator": { alt: "Phone simulator with the importer's WhatsApp thread", caption: "Phone simulator: WhatsApp in simulated mode, with the English gloss." },
      "console-mailbox": { alt: "Demo mailbox with the emails of the operation's thread", caption: "Demo mailbox: the real emails through SES, in plain text." },
      "console-clock": { alt: "Demo clock with the simulated time and the next events", caption: "Demo clock: the world paused and what happens next." },
      "console-metrics": { alt: "Metrics with the N, source and label of every number", caption: "Metrics with N, source and label: measured, scripted agent or assumption." },
      "console-audit": { alt: "Decision log with the rule of each decision", caption: "Decision log: every decision with its rule and zero policy violations." },
      "upload-page": { alt: "Upload page of operation 4471 on a phone", caption: "Upload link: the importer sees the operation number and what is missing, nothing else." },
      "upload-done": { alt: "Upload confirmation on a phone", caption: "After “Listo” (done): what arrived and what is still missing." },
    },
  },
  architecture: {
    eyebrow: "Architecture",
    title: "Serverless on AWS, end to end",
    lead: "Every AWS service is real on the stage; third-party systems are our own mocks behind their contracts.",
    tags: { simulated: "simulated mode", mock: "mock", live: "live" },
    lanes: [
      {
        title: "The parties",
        nodes: [
          { name: "Importer", note: "WhatsApp through AWS End User Messaging Social, with the console's phone simulator", tag: "simulated" },
          { name: "Foreign supplier", note: "Email through Amazon SES end to end; the supplier mailboxes are simulated", tag: "live" },
          { name: "Firm", note: "Console on CloudFront, own sign-in on Cognito and a tRPC BFF on Lambda" },
        ],
      },
      {
        title: "Intake and orchestration",
        nodes: [
          { name: "Inbound channels", note: "SNS for WhatsApp, SES receipt rules with S3 for email, and the upload link with a pre-signed S3 POST and a malware scan" },
          { name: "SQS FIFO per operation", note: "The turns of an operation run one at a time and in order; a repeated event is processed once" },
          { name: "EventBridge Scheduler and bus", note: "Milestones relative to the ETA, and carrier and customs events" },
        ],
      },
      {
        title: "The agent",
        nodes: [
          { name: "Bedrock AgentCore Harness", note: "One turn per event, with short and long-term memory in AgentCore Memory" },
          { name: "MCP Gateway and Policy (Cedar)", note: "15 tools in 5 Lambda targets; every identity comes from the session, never from the model" },
          { name: "Bedrock Guardrails", note: "One before the model (denied topics, injection, cards) and one on every outgoing text (grounding)" },
        ],
      },
      {
        title: "Outbound and data",
        nodes: [
          { name: "Outbound pipeline", note: "Contact policy, a check of figures, dates and links, and the recipient fence" },
          { name: "Document reader", note: "An external product behind an OpenAPI contract; in the demo, our own mock", tag: "mock" },
          { name: "DynamoDB and S3", note: "One table per aggregate, the decision log and versioned documents" },
        ],
      },
    ],
  },
  judges: {
    eyebrow: "For judges",
    title: "Try it in your own world",
    lead: "Every judge account has its own firm and its own world of synthetic data, with the clock paused on 14/10 at 10:30 and operation 4471 pinned on top. What you do never touches another judge's world.",
    steps: [
      "Sign in with your judge account.",
      "Follow the Guided tour panel: every step has a button, says what to look at and how long to wait.",
      "Emails really travel through SES: wait as long as each step says before moving on.",
    ],
    credentials: "Credentials and the account assignment rule are in the submission's testing instructions.",
  },
  video: { title: "The demo video" },
  closing: { title: "The file ready before the vessel", lead: "Sign in with your judge account and walk through the story of 4471 in a few minutes." },
  footer: {
    made: "Legajo listo · Powered by Craftech. Built for the AWS CDS Agentic AI Partner Hackathon.",
    synthetic: "100% synthetic data: every name is fictitious.",
    legal: "Legal",
    privacy: "Privacy",
    terms: "Terms",
  },
  phone: {
    simulator: "Simulator · WhatsApp in simulated mode",
    fictitious: "fictitious firm",
    glossToggle: "Show the English gloss",
    sources: { template: "Template", fixed: "Fixed text", agent: "Example of agent text", importer: "" },
    caption: "Illustration with the real texts of the templates and of the code; the agent's free replies are examples.",
    conversation: (day: string): string => `WhatsApp conversation on ${day}`,
  },
  email: {
    threadLabel: "Email thread with the supplier",
    from: "From",
    to: "To",
    subject: "Subject",
    attachments: "Attachments",
    agent: "Example body: the agent writes it",
    simulator: "Real text of the simulated supplier",
    when: (ar: string, supplier: string): string => `${ar} in Buenos Aires · ${supplier} in Qingdao`,
  },
  zoom: { open: "Enlarge image", close: "Close", previous: "Previous image", next: "Next image", counter: (at: number, of: number): string => `${at} of ${of}` },
};
