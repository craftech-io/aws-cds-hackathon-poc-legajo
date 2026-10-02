// Amazon SES of the app as plain data and pure functions (docs/architecture.md §1, §2, §14 and §15,
// docs/architecture-integrations.md §1-§3, docs/build-plan.md WP-18). No SST or Pulumi dependency:
// infra/messaging-email.ts builds the resources from this file and infra/messaging-email-spec.test.ts
// checks every value against the docs, the CI bootstrap, the deploy workflow and iam-capabilities.ts.
// Nothing is spelled twice: domains and address prefixes come from packages/shared/src/addresses.ts
// (the SES client's fence builds the same ones), receipt rules and key prefixes from storage-keys.ts
// (the mail bucket policy trusts exactly those rules), actions from iam-capabilities.ts.
//
// IAM half of the recipient fence (docs/architecture.md §13-§14): one send statement per sender
// profile (`SYSTEM` pipeline and escalations, `SIMULATOR` SimMail, `QA` QaDriver, `LEAD_NOTICE` the
// internal notice of a new lead to `@craftech.io`, ADR-0015 §6), linked as a Linkable.
// Each fences `ses:FromAddress`, every recipient (`ForAllValues:StringLike ses:Recipients`, with a
// `Null` guard so a request without the key is denied instead of passing vacuously) and the set. What
// IAM cannot express (a `SIMULATOR` From that is an ACTIVE contact of the operation, a `QA` recipient
// that resolves to a `qa-*` clock) stays in the client. Raw MIME and quarantined attachments are
// reached per prefix through their own Linkables: an SST bucket link grants `s3:*` on every object.

import { NOTICES_ADDRESS, QA_INJECTOR_PREFIX, QA_PARTY_PREFIX, SES_MAILBOX_SIMULATOR_DOMAIN, SIM_MAIL_DOMAIN, STAGE_DOMAIN, isReservedDomain } from "../packages/shared/src/addresses";
import { CAPABILITIES, LAMBDA_CAPABILITIES, resolveCapabilities, type BucketName, type LambdaName } from "./iam-capabilities";
import { inboundMailRoutes } from "./storage-keys";

/** SES sending and receiving of the stage (docs/architecture.md §1); the inbound MX hosts are regional. */
export const SES_REGION = "us-east-1";

/** Account and region an ARN belongs to (infra modules resolve them from the caller identity). */
export interface Place { readonly account: string; readonly region: string }

export function assertSesRegion(region: string): void {
  if (region !== SES_REGION) throw new Error(`SES of this app lives in ${SES_REGION} (docs/architecture.md §1); the provider points at ${region}.`);
}

// ---- Domains --------------------------------------------------------------------------------------

/** `app`: identity (covers `sim.` for sending), `op-*@`, `avisos@`, `no-reply@`; `sim`: simulated mailboxes; `mailFrom`: SPF alignment. */
export interface EmailDomains { readonly app: string; readonly sim: string; readonly mailFrom: string }

export const EMAIL_DOMAINS: EmailDomains = { app: STAGE_DOMAIN, sim: SIM_MAIL_DOMAIN, mailFrom: `bounce.${STAGE_DOMAIN}` };

/** infra/dns.ts names the same domains for the Router; a drift fails the deploy instead of splitting them. */
export function assertEmailDomains(fromDns: EmailDomains): void {
  for (const key of Object.keys(EMAIL_DOMAINS) as Array<keyof EmailDomains>) {
    if (fromDns[key] !== EMAIL_DOMAINS[key]) throw new Error(`infra/dns.ts names the ${key} domain ${fromDns[key]}, but SES uses ${EMAIL_DOMAINS[key]}.`);
  }
}

// ---- DNS records ----------------------------------------------------------------------------------

export const DNS_TTL_SECONDS = 300;
/** Easy DKIM always issues three tokens; each one becomes a CNAME under `_domainkey`. */
export const DKIM_TOKEN_COUNT = 3;
export const DKIM_KEY_LENGTH = "RSA_2048_BIT";
/** Every domain we send from or receive for (docs/architecture.md §1, row DMARC). */
export const DMARC_RECORD = "v=DMARC1; p=reject; adkim=r; aspf=r";
export const MAIL_FROM_SPF_RECORD = "v=spf1 include:amazonses.com -all";
export const MX_PRIORITY = 10;
export const INBOUND_MX_HOST = `inbound-smtp.${SES_REGION}.amazonaws.com`;
export const FEEDBACK_MX_HOST = `feedback-smtp.${SES_REGION}.amazonses.com`;
/** If the MAIL FROM MX stops resolving SES falls back to its own envelope: DKIM still aligns, DMARC still passes. */
export const MAIL_FROM_BEHAVIOR_ON_MX_FAILURE = "USE_DEFAULT_VALUE";

export const dmarcRecordName = (domain: string): string => `_dmarc.${domain}`;

export interface DnsRecordSpec { readonly logicalName: string; readonly type: "MX" | "TXT"; readonly name: string; readonly records: readonly string[] }

/** Static records of the channel (the DKIM CNAMEs depend on the tokens SES issues). */
export const EMAIL_DNS_RECORDS: readonly DnsRecordSpec[] = [
  { logicalName: "EmailInboundMx", type: "MX", name: EMAIL_DOMAINS.app, records: [`${MX_PRIORITY} ${INBOUND_MX_HOST}`] },
  { logicalName: "EmailSimInboundMx", type: "MX", name: EMAIL_DOMAINS.sim, records: [`${MX_PRIORITY} ${INBOUND_MX_HOST}`] },
  { logicalName: "EmailMailFromMx", type: "MX", name: EMAIL_DOMAINS.mailFrom, records: [`${MX_PRIORITY} ${FEEDBACK_MX_HOST}`] },
  { logicalName: "EmailMailFromSpf", type: "TXT", name: EMAIL_DOMAINS.mailFrom, records: [MAIL_FROM_SPF_RECORD] },
  { logicalName: "EmailDmarc", type: "TXT", name: dmarcRecordName(EMAIL_DOMAINS.app), records: [DMARC_RECORD] },
  { logicalName: "EmailSimDmarc", type: "TXT", name: dmarcRecordName(EMAIL_DOMAINS.sim), records: [DMARC_RECORD] },
];

export function dkimRecord(token: string, domain: string): { name: string; value: string } {
  if (!/^[a-z0-9]+$/.test(token)) throw new Error("a DKIM token is lowercase letters and digits only");
  return { name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com` };
}

// ---- Configuration sets and events ----------------------------------------------------------------

export const CONFIGURATION_SET_PURPOSES = ["email", "sim"] as const;
export type ConfigurationSetPurpose = (typeof CONFIGURATION_SET_PURPOSES)[number];

/** `<app>-email-<stage>` (pipeline, escalations) and `<app>-sim-<stage>` (SimMail, QaDriver): fixed names. */
export const configurationSetName = (app: string, stage: string, purpose: ConfigurationSetPurpose): string => `${app}-${purpose}-${stage}`;

export interface ConfigurationSetSpec {
  readonly logicalName: string;
  /** Publishes delivery events to EventBridge → ChannelEvents. */
  readonly events: boolean;
  readonly reputationMetrics: boolean;
  /** The simulator's set suppresses nothing: its only recipients are our own thread addresses. */
  readonly suppressedReasons: ReadonlyArray<"BOUNCE" | "COMPLAINT">;
}

export const CONFIGURATION_SETS: Readonly<Record<ConfigurationSetPurpose, ConfigurationSetSpec>> = {
  email: { logicalName: "EmailConfigurationSet", events: true, reputationMetrics: true, suppressedReasons: ["BOUNCE", "COMPLAINT"] },
  sim: { logicalName: "EmailSimConfigurationSet", events: false, reputationMetrics: false, suppressedReasons: [] },
};

/** Every set requires TLS to the receiving MTA; none tracks opens or clicks (no pixel, no rewritten links). */
export const CONFIGURATION_SET_TLS_POLICY = "REQUIRE";

export const EMAIL_EVENT_DESTINATION_NAME = "eventbridge";

// Events ChannelEvents consumes (docs/architecture-integrations.md §1): `sesType` to the destination,
// `detailType` as EventBridge shows it. No OPEN or CLICK (they switch tracking on), no SEND.
export const EMAIL_EVENTS = [
  { sesType: "DELIVERY", detailType: "Email Delivered" },
  { sesType: "BOUNCE", detailType: "Email Bounced" },
  { sesType: "COMPLAINT", detailType: "Email Complaint Received" },
  { sesType: "REJECT", detailType: "Email Rejected" },
  { sesType: "DELIVERY_DELAY", detailType: "Email Delivery Delayed" },
  { sesType: "RENDERING_FAILURE", detailType: "Email Rendering Failed" },
] as const;

export interface EmailEventPattern {
  readonly source: string[];
  readonly detailType: string[];
  readonly detail: { mail: { tags: { "ses:configuration-set": string[] } } };
}

/** Rule on the shared default bus: SES events of OUR events configuration set and nothing else. */
export function emailEventPattern(configurationSet: string): EmailEventPattern {
  return {
    source: ["aws.ses"],
    detailType: EMAIL_EVENTS.map((event) => event.detailType),
    detail: { mail: { tags: { "ses:configuration-set": [configurationSet] } } },
  };
}

/** EventBridge's retries towards ChannelEvents; the handler is idempotent by SES message id. */
export const EMAIL_EVENTS_RETRY = { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 } as const;

export const sesIdentityArn = (place: Place, domain: string): string => `arn:aws:ses:${place.region}:${place.account}:identity/${domain}`;
export const sesConfigurationSetArn = (place: Place, name: string): string => `arn:aws:ses:${place.region}:${place.account}:configuration-set/${name}`;
/** SES publishes configuration set events to the default bus only. */
export const defaultEventBusArn = (place: Place): string => `arn:aws:events:${place.region}:${place.account}:event-bus/default`;

// ---- Receiving --------------------------------------------------------------------------------------

export type EmailFunction = "InboundEmail" | "SimMail" | "ChannelEvents";
export type InboundRoute = "ops" | "sim";

/** A bare recipient domain matches its addresses and none of its subdomains; S3 stores `<prefix><SES messageId>`. */
export interface ReceiptRuleSpec {
  readonly route: InboundRoute;
  readonly logicalName: string;
  readonly rule: string;
  readonly recipients: readonly string[];
  readonly prefix: string;
  readonly fn: Extract<EmailFunction, "InboundEmail" | "SimMail">;
}

/** Spam and virus verdicts on every rule; TLS required from the sending MTA. */
export const RECEIPT_RULE_SCAN = true;
export const RECEIPT_RULE_TLS_POLICY = "Require";
export const RECEIPT_LAMBDA_INVOCATION = "Event";

/** The two rules of the active rule set (docs/architecture.md §2), in their order inside the set. */
export function receiptRules(stage: string): ReceiptRuleSpec[] {
  const prefixes = new Map(inboundMailRoutes(stage).map((route) => [route.rule, route.prefix]));
  const prefixOf = (rule: string): string => {
    const prefix = prefixes.get(rule);
    if (prefix === undefined) throw new Error(`infra/storage-keys.ts has no mail bucket route for the receipt rule ${rule}`);
    return prefix;
  };
  return [
    { route: "ops", logicalName: "EmailOpsRule", rule: `ops-${stage}`, recipients: [EMAIL_DOMAINS.app], prefix: prefixOf(`ops-${stage}`), fn: "InboundEmail" },
    { route: "sim", logicalName: "EmailSimRule", rule: `sim-${stage}`, recipients: [EMAIL_DOMAINS.sim], prefix: prefixOf(`sim-${stage}`), fn: "SimMail" },
  ];
}

/** Linkables that name the mail bucket and one route's prefix and grant only its read. */
export const INBOUND_MAIL_LINKS: Readonly<Record<InboundRoute, string>> = { ops: "InboundMailOps", sim: "InboundMailSim" };
export const INBOUND_MAIL_READ_ACTIONS = ["s3:GetObject"] as const;

/** The only route of the mail bucket each reader of docs/architecture.md §14 may read. */
export const INBOUND_MAIL_READERS: Readonly<Partial<Record<LambdaName, InboundRoute>>> = { InboundEmail: "ops", OperationWorker: "ops", QaDriver: "ops", SimMail: "sim" };

export const s3ObjectsArn = (bucket: string, prefix: string): string => `arn:aws:s3:::${bucket}/${prefix}*`;

/** Attachments of an untrusted email (docs/architecture.md §6): InboundEmail writes only there. */
export const QUARANTINE_LINK = "DocumentsQuarantine";
export const QUARANTINE_WRITER: LambdaName = "InboundEmail";
export const QUARANTINE_PREFIX = "quarantine/";
export const QUARANTINE_WRITE_ACTIONS = ["s3:PutObject"] as const;
/** `quarantine/…` and, in QA worlds, `qa/<runId>/quarantine/…` (packages/shared/src/document-keys.ts). */
export const quarantineObjectArns = (bucket: string): string[] => [s3ObjectsArn(bucket, QUARANTINE_PREFIX), s3ObjectsArn(bucket, `qa/*/${QUARANTINE_PREFIX}`)];

// ---- Sending ------------------------------------------------------------------------------------------

export const SENDER_PROFILES = ["SYSTEM", "SIMULATOR", "QA", "LEAD_NOTICE"] as const;
export type SenderProfile = (typeof SENDER_PROFILES)[number];

/**
 * `linkName`: the Linkable a sender links (names the set, carries the statement). `fromAddresses`:
 * `StringLike ses:FromAddress`. `recipients`: `ForAllValues:StringLike ses:Recipients`, plus the exact
 * `SeedOverrides.demoRecipients.emails` when `demoRecipients`.
 */
export interface SenderSpec {
  readonly linkName: string;
  readonly configurationSet: ConfigurationSetPurpose;
  readonly fromAddresses: readonly string[];
  readonly recipients: readonly string[];
  readonly demoRecipients: boolean;
}

const OPERATION_THREADS = `op-*@${EMAIL_DOMAINS.app}`;

/**
 * The only domain the lead notice reaches (ADR-0015 §6). The recipients come from the secret
 * `LeadNoticeTo`, never from the code; the client's fence wants `<local>@craftech.io` exactly, and IAM
 * repeats it: `*@craftech.io` cannot match a subdomain (`x@mail.craftech.io` ends otherwise).
 */
export const LEAD_NOTICE_DOMAIN = "craftech.io";

export const SENDERS: Readonly<Record<SenderProfile, SenderSpec>> = {
  SYSTEM: {
    linkName: "EmailSenderSystem",
    configurationSet: "email",
    fromAddresses: [OPERATION_THREADS, NOTICES_ADDRESS],
    recipients: [`*@${EMAIL_DOMAINS.sim}`, `*@${SES_MAILBOX_SIMULATOR_DOMAIN}`],
    demoRecipients: true,
  },
  SIMULATOR: { linkName: "EmailSenderSimulator", configurationSet: "sim", fromAddresses: [`*@${EMAIL_DOMAINS.sim}`], recipients: [OPERATION_THREADS], demoRecipients: false },
  QA: {
    linkName: "EmailSenderQa",
    configurationSet: "sim",
    fromAddresses: [`${QA_INJECTOR_PREFIX}*@${EMAIL_DOMAINS.sim}`, `${QA_PARTY_PREFIX}*@${EMAIL_DOMAINS.sim}`],
    recipients: [OPERATION_THREADS, `${QA_PARTY_PREFIX}*@${EMAIL_DOMAINS.sim}`],
    demoRecipients: false,
  },
  // A profile without a clock: no PENDING#/MAIL#, no X-Legajo-Mail-Id, no Message (ADR-0015 §6).
  LEAD_NOTICE: { linkName: "EmailSenderLeadNotice", configurationSet: "email", fromAddresses: [NOTICES_ADDRESS], recipients: [`*@${LEAD_NOTICE_DOMAIN}`], demoRecipients: false },
};

export const SEND_ACTIONS: readonly string[] = CAPABILITIES.SEND_EMAIL.actions;

/** Functions that send without the SEND_EMAIL capability, each with its own profile (§14 rows). */
const DIRECT_SENDERS: Readonly<Partial<Record<LambdaName, SenderProfile>>> = { SimMail: "SIMULATOR", QaDriver: "QA", LeadNotice: "LEAD_NOTICE" };

/** The sender Linkable a function links: SYSTEM for every holder of SEND_EMAIL (PIPELINE included). */
export function senderProfileOf(fn: LambdaName): SenderProfile | undefined {
  if (resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("SEND_EMAIL")) return "SYSTEM";
  return DIRECT_SENDERS[fn];
}

/** Every Linkable of this module a function needs, by name (infra/messaging-email.ts `emailLinks`). */
export function emailLinkNames(fn: LambdaName): string[] {
  const names: string[] = [];
  const profile = senderProfileOf(fn);
  if (profile !== undefined) names.push(SENDERS[profile].linkName);
  const route = INBOUND_MAIL_READERS[fn];
  if (route !== undefined) names.push(INBOUND_MAIL_LINKS[route]);
  if (fn === QUARANTINE_WRITER) names.push(QUARANTINE_LINK);
  return names;
}

export interface StatementCondition { readonly test: string; readonly variable: string; readonly values: string[] }
export interface IamStatement { readonly actions: string[]; readonly resources: string[]; readonly conditions: StatementCondition[] }

/** `ses:SendEmail` of one profile: on the identity (the parent domain covers `sim.`) and only this profile's set. */
export function sendStatement(profile: SenderProfile, scope: Place & { app: string; stage: string }, demoRecipients: readonly string[] = []): IamStatement {
  const sender = SENDERS[profile];
  const recipients = [...sender.recipients, ...(sender.demoRecipients ? demoRecipients : [])];
  return {
    actions: [...SEND_ACTIONS],
    resources: [sesIdentityArn(scope, EMAIL_DOMAINS.app), sesConfigurationSetArn(scope, configurationSetName(scope.app, scope.stage, sender.configurationSet))],
    conditions: [
      { test: "StringLike", variable: "ses:FromAddress", values: [...sender.fromAddresses] },
      { test: "Null", variable: "ses:Recipients", values: ["false"] },
      { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: recipients },
    ],
  };
}

// Plain ASCII mailbox, one "@", no quoting, no IDN, no IAM wildcard: `*` or `?` would turn an exact
// address into a pattern of the StringLike condition.
const EXACT_ADDRESS = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The exact demo recipients of `SeedOverrides` (docs/seed-spec.md §1), read at deploy time for the SYSTEM
 * statement. The deploy fails on anything but one exact, non-reserved address outside our own domains
 * (SYSTEM never writes to `op-*@`); a message names the position, never the address (the secret is PII).
 */
export function demoRecipientEmails(seedOverridesJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(seedOverridesJson);
  } catch {
    throw new Error("SeedOverrides is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("SeedOverrides must be a JSON object");
  const demo: unknown = Reflect.get(parsed, "demoRecipients");
  if (demo === undefined) return [];
  if (typeof demo !== "object" || demo === null || Array.isArray(demo)) throw new Error("SeedOverrides.demoRecipients must be an object");
  const emails: unknown = Reflect.get(demo, "emails");
  if (emails === undefined) return [];
  if (!Array.isArray(emails)) throw new Error("SeedOverrides.demoRecipients.emails must be an array");
  const addresses = emails.map((entry: unknown, index) => {
    const where = `SeedOverrides.demoRecipients.emails[${index}]`;
    const address = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!EXACT_ADDRESS.test(address)) throw new Error(`${where} is not one exact email address`);
    const domain = address.slice(address.indexOf("@") + 1);
    if (isReservedDomain(domain)) throw new Error(`${where} uses a reserved domain`);
    if (domain === EMAIL_DOMAINS.app || domain.endsWith(`.${EMAIL_DOMAINS.app}`)) throw new Error(`${where} is inside the app's own domains`);
    return address;
  });
  return [...new Set(addresses)].filter((address) => !address.endsWith(`@${SES_MAILBOX_SIMULATOR_DOMAIN}`)).sort();
}

// ---- Functions -------------------------------------------------------------------------------------------

/** Linkables of later modules the email functions take (infra/late-links.ts), with what each grants. */
export const LATE_LINKS = {
  OperationEvents: { owner: "operations", actions: ["sqs:SendMessage"] },
  Scheduler: { owner: "scheduler", actions: CAPABILITIES.TIMERS.actions },
} as const satisfies Record<string, { owner: string; actions: readonly string[] }>;
export type LateLinkName = keyof typeof LATE_LINKS;

/**
 * `handler`: its file belongs to the WP that owns the code (docs/build-plan.md §2). `reservedConcurrency`:
 * docs/architecture.md §12. `linkedBuckets`: linked whole (mail bucket and quarantine go through their
 * Linkables). `sessionTokenKey`: links the master key for the HKDF subkeys `thread`, `email-hash` and
 * (ChannelEvents) `lead-email`.
 */
export interface EmailFunctionSpec {
  readonly handler: string;
  readonly description: string;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly reservedConcurrency?: number;
  readonly linkedBuckets: readonly BucketName[];
  readonly lateLinks: readonly LateLinkName[];
  readonly sessionTokenKey: boolean;
}

export const EMAIL_FUNCTIONS: Readonly<Record<EmailFunction, EmailFunctionSpec>> = {
  InboundEmail: {
    handler: "packages/bff/src/handlers/inbound-email.handler",
    description: "SES receipt rule ops-*: thread address, verdicts, sender, attachments and turn enqueued.",
    timeoutSeconds: 60, memoryMb: 1024, reservedConcurrency: 5, linkedBuckets: [], lateLinks: ["OperationEvents"], sessionTokenKey: true,
  },
  SimMail: {
    handler: "packages/bff/src/handlers/sim-mail.handler",
    description: "SES receipt rule sim-*: supplier simulator and demo mailbox, only for our own verified mail.",
    timeoutSeconds: 60, memoryMb: 1024, reservedConcurrency: 5, linkedBuckets: ["Seed"], lateLinks: ["Scheduler"], sessionTokenKey: true,
  },
  // The master key for the subkey `lead-email`: a bounce or complaint of an account email or of the
  // lead notice marks Runtime/MAILSTATUS#<emailHash> (ADR-0015 §3.2), never Leads.
  ChannelEvents: {
    handler: "packages/bff/src/handlers/channel-events.handler",
    description: "SES delivery events of the email configuration set: message status, pendings, EMAIL_EVENT, bounce state of a recipient.",
    timeoutSeconds: 30, memoryMb: 256, linkedBuckets: [], lateLinks: ["OperationEvents"], sessionTokenKey: true,
  },
};

/** Raw IAM actions a function of this module ends up with: its sender statement and its late links. */
export function generatedActions(fn: EmailFunction): string[] {
  const actions = new Set<string>();
  const profile = senderProfileOf(fn);
  if (profile !== undefined) for (const action of SEND_ACTIONS) actions.add(action);
  for (const link of EMAIL_FUNCTIONS[fn].lateLinks) for (const action of LATE_LINKS[link].actions) actions.add(action);
  return [...actions].sort();
}

/** Buckets a function of this module reaches, whole or through a scoped Linkable. */
export function generatedBuckets(fn: EmailFunction): BucketName[] {
  const buckets = new Set<BucketName>(EMAIL_FUNCTIONS[fn].linkedBuckets);
  if (INBOUND_MAIL_READERS[fn] !== undefined) buckets.add("InboundMail");
  if (fn === QUARANTINE_WRITER) buckets.add("Documents");
  return [...buckets].sort();
}
