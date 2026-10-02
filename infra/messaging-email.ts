// Email channel: Amazon SES v2, sending and receiving, live end to end (docs/architecture.md §1, §2,
// §14 and §15, docs/architecture-integrations.md §1-§3, docs/build-plan.md WP-18). Names, records,
// events and IAM statements live in infra/messaging-email-spec.ts (checked by
// messaging-email-spec.test.ts); this module only turns them into resources:
//
//   - domain identity `legajo.demo.craftech.io` (it also covers `sim.` for sending), Easy DKIM (three
//     CNAMEs, RSA 2048) and MAIL FROM `bounce.legajo.demo.craftech.io` (feedback MX + SPF), so every
//     From of both domains aligns DKIM and SPF in relaxed mode;
//   - DMARC `p=reject` on `_dmarc.legajo.…` and `_dmarc.sim.legajo.…`, and the inbound MX of both;
//   - configuration sets `…-email-poc` (events → default bus → ChannelEvents) and `…-sim-poc` (SimMail
//     and QaDriver, no events); no open or click tracking anywhere;
//   - the account's ONE active receipt rule set `aws-cds-hackathon-poc-legajo-inbound` with `ops-poc`
//     (→ InboundMail `poc/ops/` → InboundEmail) and `sim-poc` (→ `poc/sim/` → SimMail), spam and
//     virus scan on, TLS required;
//   - the Functions InboundEmail, SimMail and ChannelEvents, whose handlers belong to WP-29 and WP-30;
//   - the Linkables other modules link instead of spelling SES permissions: one sender per profile
//     (`EmailSenderSystem`, `EmailSenderSimulator`, `EmailSenderQa`, `EmailSenderLeadNotice` for
//     infra/leads.ts), the read of one route of the mail
//     bucket (`InboundMailOps`, `InboundMailSim`) and the write of the quarantine
//     (`DocumentsQuarantine`). `emailLinks(fn)` returns exactly the ones infra/iam-capabilities.ts
//     declares for a function.
//
// Activating the rule set deactivates any other of the account (SES keeps one per region): the
// operator's pre-check (docs/architecture.md §15 step 0) and the deploy workflow's pre-check stop
// before `sst deploy` when a foreign set is active. The receipt APIs have no resource-level fence
// beyond the set's ARN (infra/bootstrap/README.md, residual risks).
//
// The identity is not bound to a default configuration set: every SendEmail of the app names its set
// (packages/bff/src/channels/email/outbound.ts) and IAM allows each profile only its own set. Cognito's
// account emails (infra/auth.ts) name the email set in the pool's email configuration, so their
// bounces and complaints reach ChannelEvents, which keeps Runtime/MAILSTATUS# (ADR-0015 §3.2).
//
// Why `aws.sesv2.*` and not `sst.aws.Email`: the component waits for DKIM inside the deploy (hours in a
// delegated zone), binds its own configuration set and links `ses:*`. DKIM is checked after the deploy;
// until it reads SUCCESS the smoke warns and the email scenarios wait (docs/architecture.md §16).
//
// Verify (docs/architecture.md §15 step 6):
//   aws --profile craftech-demos sesv2 get-email-identity --email-identity legajo.demo.craftech.io
//     DkimAttributes.Status = SUCCESS · MailFromAttributes.MailFromDomainStatus = SUCCESS
//   aws --profile craftech-demos ses describe-active-receipt-rule-set      Metadata.Name = aws-cds-hackathon-poc-legajo-inbound, rules ops-poc and sim-poc
//   aws --profile craftech-demos sesv2 get-configuration-set-event-destinations --configuration-set-name aws-cds-hackathon-poc-legajo-email-poc
//   dig +short TXT _dmarc.legajo.demo.craftech.io · dig +short TXT _dmarc.sim.legajo.demo.craftech.io   "v=DMARC1; p=reject; adkim=r; aspf=r"
//   dig +short MX legajo.demo.craftech.io · dig +short MX sim.legajo.demo.craftech.io                   10 inbound-smtp.us-east-1.amazonaws.com

import { ZONE_ID, appDomain, mailFromDomain, simDomain } from "./dns";
import type { LambdaName } from "./iam-capabilities";
import { lateLinks, links, type LinkList } from "./late-links";
import {
  CONFIGURATION_SETS,
  CONFIGURATION_SET_PURPOSES,
  CONFIGURATION_SET_TLS_POLICY,
  DKIM_KEY_LENGTH,
  DKIM_TOKEN_COUNT,
  DNS_TTL_SECONDS,
  EMAIL_DNS_RECORDS,
  EMAIL_DOMAINS,
  EMAIL_EVENTS,
  EMAIL_EVENTS_RETRY,
  EMAIL_EVENT_DESTINATION_NAME,
  EMAIL_FUNCTIONS,
  INBOUND_MAIL_LINKS,
  INBOUND_MAIL_READ_ACTIONS,
  LATE_LINKS,
  MAIL_FROM_BEHAVIOR_ON_MX_FAILURE,
  QUARANTINE_LINK,
  QUARANTINE_PREFIX,
  QUARANTINE_WRITE_ACTIONS,
  RECEIPT_LAMBDA_INVOCATION,
  RECEIPT_RULE_SCAN,
  RECEIPT_RULE_TLS_POLICY,
  SENDERS,
  SENDER_PROFILES,
  SEND_ACTIONS,
  assertEmailDomains,
  assertSesRegion,
  configurationSetName,
  defaultEventBusArn,
  demoRecipientEmails,
  dkimRecord,
  emailEventPattern,
  emailLinkNames,
  quarantineObjectArns,
  receiptRules,
  s3ObjectsArn,
  sendStatement,
  type ConfigurationSetPurpose,
  type EmailFunction,
  type InboundRoute,
  type LateLinkName,
  type Place,
  type SenderProfile,
} from "./messaging-email-spec";
import { SeedOverrides, SessionTokenKey } from "./secrets";
import { buckets, documentsBucket, inboundMailBucket, tables } from "./storage";
import { SES_PRINCIPAL, inboundRuleSetName, receiptRuleArn, storageFor } from "./storage-keys";

assertEmailDomains({ app: appDomain, sim: simDomain, mailFrom: mailFromDomain });

/** Account and region of the stage; the deploy fails if the provider is not in SES's region. */
export const place: $util.Output<Place> = $util
  .all([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).region])
  .apply(([account, region]) => {
    assertSesRegion(region);
    return { account, region };
  });

// ---- Identity, DKIM, MAIL FROM and DNS -----------------------------------------------------------

/** Read by infra/auth.ts: Cognito sends from `no-reply@` through it once it is verified. */
export const emailIdentity = new aws.sesv2.EmailIdentity("EmailIdentity", {
  emailIdentity: EMAIL_DOMAINS.app,
  dkimSigningAttributes: { nextSigningKeyLength: DKIM_KEY_LENGTH },
});

// Easy DKIM: the three tokens exist once the identity does, so the records resolve after it.
export const dkimRecords = Array.from({ length: DKIM_TOKEN_COUNT }, (_, index) => {
  const record = emailIdentity.dkimSigningAttributes.apply((attributes) => {
    const token = attributes.tokens[index];
    if (token === undefined) throw new Error(`SES returned fewer than ${DKIM_TOKEN_COUNT} DKIM tokens for ${EMAIL_DOMAINS.app}`);
    return dkimRecord(token, EMAIL_DOMAINS.app);
  });
  return new aws.route53.Record(`EmailDkimRecord${index}`, {
    zoneId: ZONE_ID,
    type: "CNAME",
    name: record.name,
    ttl: DNS_TTL_SECONDS,
    records: [record.value],
  });
});

/** MX of `legajo.` and `sim.`, MAIL FROM MX and SPF, and both DMARC records. */
export const emailDnsRecords: aws.route53.Record[] = EMAIL_DNS_RECORDS.map(
  (spec) => new aws.route53.Record(spec.logicalName, { zoneId: ZONE_ID, type: spec.type, name: spec.name, ttl: DNS_TTL_SECONDS, records: [...spec.records] }),
);

// SES checks the MAIL FROM MX on its own schedule; the records go first so the first check can pass.
export const emailMailFrom = new aws.sesv2.EmailIdentityMailFromAttributes(
  "EmailMailFrom",
  {
    emailIdentity: emailIdentity.emailIdentity,
    mailFromDomain: EMAIL_DOMAINS.mailFrom,
    behaviorOnMxFailure: MAIL_FROM_BEHAVIOR_ON_MX_FAILURE,
  },
  { dependsOn: emailDnsRecords.filter((_, index) => EMAIL_DNS_RECORDS[index]?.name === EMAIL_DOMAINS.mailFrom) },
);

// ---- Configuration sets and events ---------------------------------------------------------------

const setName = (purpose: ConfigurationSetPurpose): string => configurationSetName($app.name, $app.stage, purpose);

export const configurationSets = Object.fromEntries(
  CONFIGURATION_SET_PURPOSES.map((purpose) => {
    const spec = CONFIGURATION_SETS[purpose];
    return [
      purpose,
      new aws.sesv2.ConfigurationSet(spec.logicalName, {
        configurationSetName: setName(purpose),
        deliveryOptions: { tlsPolicy: CONFIGURATION_SET_TLS_POLICY },
        reputationOptions: { reputationMetricsEnabled: spec.reputationMetrics },
        sendingOptions: { sendingEnabled: true },
        suppressionOptions: { suppressedReasons: [...spec.suppressedReasons] },
      }),
    ];
  }),
) as Record<ConfigurationSetPurpose, aws.sesv2.ConfigurationSet>;

export const emailEventDestinations = CONFIGURATION_SET_PURPOSES.filter((purpose) => CONFIGURATION_SETS[purpose].events).map(
  (purpose) =>
    new aws.sesv2.ConfigurationSetEventDestination(`${CONFIGURATION_SETS[purpose].logicalName}Events`, {
      configurationSetName: configurationSets[purpose].configurationSetName,
      eventDestinationName: EMAIL_EVENT_DESTINATION_NAME,
      eventDestination: {
        enabled: true,
        matchingEventTypes: EMAIL_EVENTS.map((event) => event.sesType),
        eventBridgeDestination: { eventBusArn: place.apply(defaultEventBusArn) },
      },
    }),
);

// ---- Linkables: senders and scoped storage --------------------------------------------------------

// The registered demo recipients are read from the secret at deploy time and rendered as exact
// addresses into the SYSTEM statement; only that profile reads the secret, so only its policy is secret.
const demoRecipients = SeedOverrides.value.apply(demoRecipientEmails);

function sender(profile: SenderProfile): sst.Linkable<{ profile: SenderProfile; configurationSet: string }> {
  const spec = SENDERS[profile];
  const scope = place.apply((where) => ({ ...where, app: $app.name, stage: $app.stage }));
  const statement = spec.demoRecipients
    ? $util.all([scope, demoRecipients]).apply(([where, demo]) => sendStatement(profile, where, demo))
    : scope.apply((where) => sendStatement(profile, where));
  return new sst.Linkable(spec.linkName, {
    properties: { profile, configurationSet: setName(spec.configurationSet) },
    include: [sst.aws.permission({ actions: [...SEND_ACTIONS], resources: statement.resources, conditions: statement.conditions })],
  });
}

/** `Resource.EmailSender<Profile>.configurationSet`; linking one grants `ses:SendEmail` fenced to that profile. */
export const emailSenders = Object.fromEntries(SENDER_PROFILES.map((profile) => [profile, sender(profile)])) as Record<
  SenderProfile,
  sst.Linkable<{ profile: SenderProfile; configurationSet: string }>
>;

const mailRules = receiptRules($app.stage);

function mailRoute(route: InboundRoute): { rule: string; prefix: string } {
  const found = mailRules.find((rule) => rule.route === route);
  if (found === undefined) throw new Error(`no receipt rule for the ${route} route`);
  return found;
}

/** `Resource.InboundMail<Route>.{name, prefix}`; grants the read of that route's raw MIME only. */
export const inboundMailLinks = Object.fromEntries(
  (Object.keys(INBOUND_MAIL_LINKS) as InboundRoute[]).map((route) => {
    const { prefix } = mailRoute(route);
    return [
      route,
      new sst.Linkable(INBOUND_MAIL_LINKS[route], {
        properties: { name: inboundMailBucket.name, prefix },
        include: [sst.aws.permission({ actions: [...INBOUND_MAIL_READ_ACTIONS], resources: [inboundMailBucket.name.apply((bucket) => s3ObjectsArn(bucket, prefix))] })],
      }),
    ];
  }),
) as Record<InboundRoute, sst.Linkable<{ name: $util.Output<string>; prefix: string }>>;

/** `Resource.DocumentsQuarantine.{name, prefix}`; grants PutObject under `quarantine/` (and its `qa/<runId>/` form). */
export const DocumentsQuarantine = new sst.Linkable(QUARANTINE_LINK, {
  properties: { name: documentsBucket.name, prefix: QUARANTINE_PREFIX },
  include: [sst.aws.permission({ actions: [...QUARANTINE_WRITE_ACTIONS], resources: documentsBucket.name.apply(quarantineObjectArns) })],
});

const linkablesByName = new Map<string, unknown>([
  ...SENDER_PROFILES.map((profile) => [SENDERS[profile].linkName, emailSenders[profile]] as const),
  ...(Object.keys(INBOUND_MAIL_LINKS) as InboundRoute[]).map((route) => [INBOUND_MAIL_LINKS[route], inboundMailLinks[route]] as const),
  [QUARANTINE_LINK, DocumentsQuarantine] as const,
]);

/**
 * The Linkables of this module a function links (sender, mail route, quarantine), exactly as
 * infra/iam-capabilities.ts declares them; for the `link` of any module that creates one of those
 * functions. The mail bucket and the quarantine are never linked whole.
 */
export function emailLinks(fn: LambdaName): unknown[] {
  return emailLinkNames(fn).map((name) => {
    const linkable = linkablesByName.get(name);
    if (linkable === undefined) throw new Error(`infra/messaging-email.ts has no Linkable ${name}`);
    return linkable;
  });
}

// ---- Functions -------------------------------------------------------------------------------------

// Queue and timers belong to infra/operations.ts and infra/scheduler.ts, which import this module:
// resolved late so neither side closes an import cycle (infra/late-links.ts).
const lateLinkLoaders: Record<LateLinkName, () => Promise<object>> = {
  OperationEvents: () => import("./operations"),
  Scheduler: () => import("./scheduler"),
};

// Tables through their SST link (as every module does); buckets named in the spec linked whole.
function linksOf(fn: EmailFunction): LinkList {
  const spec = EMAIL_FUNCTIONS[fn];
  const own: unknown[] = [
    ...storageFor(fn).tables.map((name) => tables[name]),
    ...spec.linkedBuckets.map((name) => buckets[name]),
    ...emailLinks(fn),
    ...(spec.sessionTokenKey ? [SessionTokenKey] : []),
  ];
  const late = spec.lateLinks.map((name) => lateLinks("messaging-email", LATE_LINKS[name].owner, lateLinkLoaders[name], [name]));
  return links(own, ...late);
}

function emailFunction(fn: EmailFunction): sst.aws.Function {
  const spec = EMAIL_FUNCTIONS[fn];
  return new sst.aws.Function(fn, {
    handler: spec.handler,
    description: spec.description,
    timeout: `${spec.timeoutSeconds} seconds` as const,
    memory: `${spec.memoryMb} MB` as const,
    ...(spec.reservedConcurrency === undefined ? {} : { concurrency: { reserved: spec.reservedConcurrency } }),
    link: linksOf(fn),
  });
}

export const inboundEmail = emailFunction("InboundEmail");
export const simMail = emailFunction("SimMail");
export const channelEvents = emailFunction("ChannelEvents");

// ---- Receiving: the account's active rule set ------------------------------------------------------

export const inboundRuleSet = new aws.ses.ReceiptRuleSet("EmailInboundRuleSet", { ruleSetName: inboundRuleSetName($app.name) });

const receivers: Record<(typeof mailRules)[number]["fn"], sst.aws.Function> = { InboundEmail: inboundEmail, SimMail: simMail };

/** One rule per route: S3 first (raw MIME, 30 days), then the Function asynchronously. */
export const receiptRuleResources: aws.ses.ReceiptRule[] = [];
for (const spec of mailRules) {
  const receiver = receivers[spec.fn];
  // SES may invoke the Function only on behalf of this rule of this account (anti confused deputy).
  const invoke = new aws.lambda.Permission(`${spec.logicalName}Invoke`, {
    action: "lambda:InvokeFunction",
    function: receiver.name,
    principal: SES_PRINCIPAL,
    sourceAccount: place.account,
    sourceArn: place.apply((where) => receiptRuleArn(where.region, where.account, $app.name, spec.rule)),
  });
  const previous = receiptRuleResources.at(-1);
  receiptRuleResources.push(
    new aws.ses.ReceiptRule(
      spec.logicalName,
      {
        name: spec.rule,
        ruleSetName: inboundRuleSet.ruleSetName,
        recipients: [...spec.recipients],
        enabled: true,
        scanEnabled: RECEIPT_RULE_SCAN,
        tlsPolicy: RECEIPT_RULE_TLS_POLICY,
        ...(previous === undefined ? {} : { after: previous.name }),
        s3Actions: [{ position: 1, bucketName: inboundMailBucket.name, objectKeyPrefix: spec.prefix }],
        lambdaActions: [{ position: 2, functionArn: receiver.arn, invocationType: RECEIPT_LAMBDA_INVOCATION }],
      },
      // SES validates both when the rule is created: the bucket policy that trusts this rule
      // (infra/storage-buckets.ts, part of the bucket component) and the invoke permission.
      { dependsOn: [inboundMailBucket, invoke] },
    ),
  );
}

// Activation goes after every rule, so the set is never active while incomplete.
export const activeReceiptRuleSet = new aws.ses.ActiveReceiptRuleSet(
  "EmailInboundRuleSetActive",
  { ruleSetName: inboundRuleSet.ruleSetName },
  { dependsOn: receiptRuleResources },
);

// ---- Delivery events → ChannelEvents ------------------------------------------------------------------

// Only the events of the email configuration set; the default bus is shared with the whole account.
export const emailEventsSubscription = sst.aws.Bus.subscribe("EmailEvents", place.apply(defaultEventBusArn), channelEvents, {
  pattern: emailEventPattern(setName("email")),
  transform: {
    target: (args) => {
      args.retryPolicy = { ...EMAIL_EVENTS_RETRY };
    },
  },
});
